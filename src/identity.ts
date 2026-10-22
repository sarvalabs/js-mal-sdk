// MoiIdentity (contracts/identity/moi_identity.coco): the identity layer of
// mal.md §1.6 with self-certifying DIDs. Every MOI account `a` owns
// "did:moi:<a>" from the start, with no registration, so nobody can claim the
// DID of an account they don't control. Control never moves: a DID's
// controller is always its own account, which can turn the DID off and on.

import { getLogicDriver, type LogicDriver, type Signer } from "js-moi-sdk";
import { toHex } from "./codec.js";
import { ErrorCode } from "./constants.js";
import { AuthorityError, invalidArgument, toAuthorityError } from "./errors.js";
import { IDENTITY_MANIFEST } from "./identity-manifest.js";
import { IDENTITY_LOGIC_ID } from "./defaults.js";
import type { ConnectOptions, DeployOptions, RegistryOptions, WriteResult } from "./registry.js";
import { Transport, deployLogic } from "./transport.js";
import type { DID, Hex } from "./types.js";

const MOI_DID = /^did:moi:([0-9a-fA-F]{64})$/;
const DEFAULT_STORAGE_FUND = 10n * 1_000_000_000n;

/** True when `did` is a did:moi DID: "did:moi:" and an account's 64 hex digits. */
export const isMoiDid = (did: string): boolean => MOI_DID.test(did);

/** The did:moi DID of an account. */
export const didOf = (address: string): DID => {
    const hex = address.toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{64}$/.test(hex)) throw invalidArgument(`not an account address: ${address}`);
    return `did:moi:${hex}`;
};

/** The account a did:moi DID belongs to, which is also its controller. */
export const homeOf = (did: string): Hex => {
    const match = MOI_DID.exec(did);
    if (!match) throw invalidArgument(`not a did:moi DID: ${did}`);
    return `0x${match[1]!.toLowerCase()}`;
};

/** A connection to a deployed MoiIdentity logic, signing as one account. */
export class MoiIdentity {
    readonly #transport: Transport;

    private constructor(readonly logicId: Hex, driver: LogicDriver, readonly signer: Signer, options: RegistryOptions) {
        this.#transport = new Transport(driver, signer, logicId, options);
    }

    /** Connects to the identity layer at `options.logicId`, by default `IDENTITY_LOGIC_ID`. */
    static async connect(signer: Signer, options: ConnectOptions = {}): Promise<MoiIdentity> {
        const id = toHex(options.logicId ?? IDENTITY_LOGIC_ID);
        try {
            return new MoiIdentity(id, await getLogicDriver(id, signer), signer, options);
        } catch (error) {
            throw toAuthorityError(error, { logicId: id });
        }
    }

    /**
     * Deploys a MoiIdentity logic. Each account stores its own DID's on/off
     * flag and the logic stores nothing, so the fund (default 10 KMOI) only
     * has to cover storing the logic itself; it never needs topping up.
     */
    static async deploy(signer: Signer, options: DeployOptions = {}): Promise<MoiIdentity> {
        const logicId = await deployLogic(IDENTITY_MANIFEST, signer, [], options.storageFund ?? DEFAULT_STORAGE_FUND, options);
        return MoiIdentity.connect(signer, { ...options, logicId });
    }

    /** The DID of the account this connection signs as. */
    async did(): Promise<DID> {
        return didOf(await this.#transport.sender());
    }

    /** The account that controls `did` (its own account), or null when `did` isn't a did:moi DID. */
    async controllerOf(did: string): Promise<Hex | null> {
        return isMoiDid(did) ? homeOf(did) : null;
    }

    /** Whether `did` is active; false when it isn't a did:moi DID. */
    async isActive(did: string): Promise<boolean> {
        if (!isMoiDid(did)) return false;
        const { active } = await this.#transport.call("IsActive", [did], { read: [homeOf(did)] });
        return Boolean(active);
    }

    /** Turns `did` on or off. Only its own account may. */
    async setActive(did: string, active: boolean): Promise<WriteResult> {
        if (!isMoiDid(did)) throw new AuthorityError(ErrorCode.INVALID_ARGUMENT, `not a did:moi DID: ${did}`);
        const { hash, receipt } = await this.#transport.send("SetActive", [did, active], { read: [homeOf(did)] });
        return { hash, receipt, fuelUsed: Number(receipt.fuel_used) };
    }
}
