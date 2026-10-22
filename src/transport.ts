// Every network-specific concern lives here: participant declaration, fuel,
// receipt checks and retries.

import { LockType, LogicFactory, ManifestCoder, RoutineOption, type LogicDriver, type Signer } from "js-moi-sdk";
import { ErrorCode } from "./constants.js";
import { AuthorityError, toAuthorityError } from "./errors.js";
import type { Hex } from "./types.js";

export interface TransportOptions {
    /** Fuel price for every interaction. Default 50. */
    fuelPrice?: number;
    /**
     * Fuel ceiling for interactions the network can't simulate (it caps
     * simulation at 100,000 fuel), and the limit simulations run under.
     * Default 5,000,000.
     */
    maxFuel?: number;
    /** Multiplier applied to simulated fuel use. Default 1.5. */
    fuelMultiplier?: number;
    /** Retries after a lock conflict with a participant's own interaction. Default 3. */
    retries?: number;
    /** Seconds to wait for a receipt. Default 120. */
    receiptTimeout?: number;
}

/** The parts of an interaction receipt the SDK reads. */
export interface Receipt {
    ix_hash: string;
    ts_hash: string;
    status: number;
    fuel_used: string;
    participants?: { id: string; height: string }[];
    ix_operations: { status: number; data?: { outputs?: string; error?: string } }[];
}

export interface SendResult {
    output: Record<string, any>;
    hash: string;
    receipt: Receipt;
}

/** Accounts an interaction touches besides the sender and the logic: read, or write. */
export interface Access {
    read?: Iterable<string>;
    write?: Iterable<string>;
}

type Routine = (...args: unknown[]) => {
    call(option?: object): Promise<{ receipt: Receipt; result(): Promise<{ output: unknown; error: unknown }> }>;
    send(option?: object): Promise<{ hash: string; wait(timeout?: number): Promise<Receipt>; result(timeout?: number): Promise<{ output: unknown; error: unknown }> }>;
};

const METER_EXHAUSTED = /MeterExhausted|meter exhausted|compute effort exhausted/i;
const LOCK_CONFLICT = /missing signature of extern origin actor/i;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// js-moi-sdk numbers an interaction from the sender's pending count, so two
// submissions from one account at the same moment can take the same number and
// one is rejected. Submissions from an account go one at a time, across every
// connection in the process; waiting for receipts still overlaps.
const submitting = new Map<string, Promise<unknown>>();
const oneAtATime = <T>(account: string, submit: () => Promise<T>): Promise<T> => {
    const previous = submitting.get(account) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(submit);
    const tail = next.catch(() => {});
    submitting.set(account, tail);
    void tail.then(() => {
        if (submitting.get(account) === tail) submitting.delete(account);
    });
    return next;
};

/** Waits for an interaction's receipt; a timeout or RPC failure keeps the hash, since the interaction may still land. */
const awaitReceipt = async <T>(wait: () => Promise<T>, label: string, hash: string): Promise<T> => {
    try {
        return await wait();
    } catch (error) {
        throw toAuthorityError(error, { operation: label, hash, stage: "receipt" });
    }
};

export const decodeReceiptError = (receipt: Receipt): { class?: string; error?: string } | null => {
    for (const op of receipt?.ix_operations ?? []) {
        const raw = op?.data?.error;
        if (raw && raw !== "0x") {
            try {
                return ManifestCoder.decodeException(raw) as { class?: string; error?: string };
            } catch {
                return { error: raw };
            }
        }
    }
    return null;
};

export class Transport {
    readonly fuelPrice: number;
    readonly maxFuel: number;
    readonly fuelMultiplier: number;
    readonly retries: number;
    readonly receiptTimeout: number;
    #sender: Hex | undefined;

    constructor(readonly driver: LogicDriver, readonly signer: Signer, readonly logicId: Hex, options: TransportOptions = {}) {
        this.fuelPrice = options.fuelPrice ?? 50;
        this.maxFuel = options.maxFuel ?? 5_000_000;
        this.fuelMultiplier = options.fuelMultiplier ?? 1.5;
        this.retries = options.retries ?? 3;
        this.receiptTimeout = options.receiptTimeout ?? 120;
    }

    async sender(): Promise<Hex> {
        this.#sender ??= (await this.signer.getIdentifier()).toHex().toLowerCase() as Hex;
        return this.#sender;
    }

    /**
     * The interaction's participants. The registry can read or write only
     * accounts declared here. The sender is implicit; the registry logic is
     * declared by js-moi-sdk with a mutate lock and is left out here, because
     * a read lock for the same id would replace it and the network would then
     * drop the logic's writes.
     */
    async participants({ read = [], write = [] }: Access) {
        const skip = new Set([await this.sender(), this.logicId.toLowerCase()]);
        const locks = new Map<string, number>();
        for (const id of read) if (!skip.has(id.toLowerCase())) locks.set(id.toLowerCase(), LockType.READ_LOCK);
        for (const id of write) if (!skip.has(id.toLowerCase())) locks.set(id.toLowerCase(), LockType.MUTATE_LOCK);
        return [...locks].map(([id, lock_type]) => ({ id, lock_type }));
    }

    private routine(name: string): Routine {
        const routine = (this.driver.routines as unknown as Record<string, Routine>)[name];
        if (!routine) throw new AuthorityError(ErrorCode.NETWORK_ERROR, `the logic has no routine ${name}; is the logic id right?`);
        return routine;
    }

    /** Runs a static routine and returns its outputs, or throws its error. */
    async call(name: string, args: unknown[], access: Access = {}): Promise<Record<string, any>> {
        const participants = await this.participants(access);
        let result;
        try {
            const response = await this.routine(name)(...args).call({ fuel_price: this.fuelPrice, fuel_limit: this.maxFuel, participants });
            result = await response.result();
        } catch (error) {
            throw toAuthorityError(error, { routine: name });
        }
        if (result.error) throw toAuthorityError(result.error, { routine: name });
        return (result.output ?? {}) as Record<string, any>;
    }

    /**
     * Sends a dynamic routine. It is simulated first, so a registry error is
     * thrown before any fuel is spent and a successful simulation sizes the
     * fuel limit. Only when simulation hits the network's cap is the
     * interaction sent at `maxFuel`.
     */
    async send(name: string, args: unknown[], access: Access = {}): Promise<SendResult> {
        const sender = await this.sender();
        const participants = await this.participants(access);
        const fuelLimit = await this.fuelFor(name, args, participants);
        return this.withRetries(async () => {
            let response;
            try {
                response = await oneAtATime(sender, () => this.routine(name)(...args).send({ fuel_price: this.fuelPrice, fuel_limit: fuelLimit, participants }));
            } catch (error) {
                throw toAuthorityError(error, { routine: name, stage: "submit" });
            }
            const receipt = await awaitReceipt(() => response.wait(this.receiptTimeout), name, response.hash);
            this.checkReceipt(receipt, name, response.hash);
            const result = await awaitReceipt(() => response.result(this.receiptTimeout), name, response.hash);
            return { output: (result.output ?? {}) as Record<string, any>, hash: response.hash, receipt };
        });
    }

    private async fuelFor(name: string, args: unknown[], participants: object[]): Promise<number> {
        let simulation;
        try {
            simulation = await this.routine(name)(...args).call({ fuel_price: this.fuelPrice, fuel_limit: this.maxFuel, participants });
        } catch (error) {
            throw toAuthorityError(error, { routine: name, stage: "simulate" });
        }
        const exception = decodeReceiptError(simulation.receipt);
        if (exception) {
            if (METER_EXHAUSTED.test(`${exception.class} ${exception.error}`)) return this.maxFuel;
            throw toAuthorityError(exception, { routine: name, stage: "simulate" });
        }
        return Math.min(this.maxFuel, Math.ceil(Number(simulation.receipt.fuel_used) * this.fuelMultiplier) + 10_000);
    }

    private checkReceipt(receipt: Receipt, name: string, hash: string): void {
        const details = { operation: name, hash, fuelUsed: Number(receipt.fuel_used) };
        const exception = decodeReceiptError(receipt);
        if (exception) throw toAuthorityError(exception, details);
        // A non-zero status with no exception: the network discarded the state
        // changes after execution, usually because the sender's balance can't
        // back the storage the write adds.
        if (Number(receipt.status) !== 0) {
            throw new AuthorityError(
                ErrorCode.STATE_REVERTED,
                `${name} executed but the network discarded its state changes (receipt status ${receipt.status}); the sender may not have enough KMOI to back the storage it adds`,
                details,
            );
        }
    }

    // A declared account sending its own interaction at the same moment can
    // make the network reject this one; it is safe to send again.
    private async withRetries<T>(attempt: () => Promise<T>): Promise<T> {
        for (let tries = 0; ; tries++) {
            try {
                return await attempt();
            } catch (error) {
                const conflict = error instanceof AuthorityError && LOCK_CONFLICT.test(error.message);
                if (!conflict || tries >= this.retries) throw error;
                await sleep(1000 * (tries + 1));
            }
        }
    }
}

/**
 * Deploys a logic from its manifest and returns its id. `storageFund` (KMOI in
 * ANU) is sent with the deploy: a logic backs its own storage, and an
 * underfunded deploy reverts with no error message.
 */
export const deployLogic = async (
    manifest: Readonly<Record<string, unknown>>, signer: Signer, args: unknown[], storageFund: bigint, options: TransportOptions = {},
): Promise<Hex> => {
    const factory = new LogicFactory(manifest as never, signer);
    const context = factory.deploy("Init", ...args, new RoutineOption({ storageFund }));
    let logicId: string | undefined;
    try {
        const response = await context.send({ fuel_price: options.fuelPrice ?? 50, fuel_limit: options.maxFuel ?? 5_000_000 });
        const receipt = await response.wait();
        const result = await response.result();
        if (result.error) throw toAuthorityError(result.error);
        if (Number(receipt.status) !== 0) {
            throw new AuthorityError(ErrorCode.STATE_REVERTED, "deploy reverted; the storage fund is likely too small", { hash: response.hash });
        }
        logicId = result.logic_id;
    } catch (error) {
        throw toAuthorityError(error, { stage: "deploy" });
    }
    if (!logicId) throw new AuthorityError(ErrorCode.NETWORK_ERROR, "deploy returned no logic id");
    return logicId.toLowerCase() as Hex;
};
