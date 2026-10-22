import {
    getLogicDriver, type LogicDriver, type Signer,
} from "js-moi-sdk";
import { attenuationEscalation } from "./attenuation.js";
import { fromWireDelegation, fromWireGrant, toHex, toWireScope } from "./codec.js";
import { ErrorCode, LIMITS, VERSION } from "./constants.js";
import { AuthorityError, invalidArgument, toAuthorityError } from "./errors.js";
import { IDENTITY_LOGIC_ID, REGISTRY_LOGIC_ID } from "./defaults.js";
import { decodeLog, type RecordedEvent, type RegistryEvent } from "./events.js";
import { homeOf, isMoiDid } from "./identity.js";
import { isDelegationId, isGrantId, parseId, routeOf } from "./ids.js";
import { REGISTRY_MANIFEST } from "./manifest.js";
import { resolveAuthority as resolveLocally, type RecordSource } from "./resolver.js";
import { Transport, deployLogic, type Receipt, type TransportOptions } from "./transport.js";
import type {
    CreateDelegationInput, CreateGrantInput, Delegation, DelegationId, Grant, GrantId, Hex, ResolvedAuthority,
} from "./types.js";
import { validateDelegationInput, validateGrantInput } from "./validate.js";

export interface RegistryOptions extends TransportOptions {
    /** Current time in epoch seconds, used for client-side checks. Defaults to the system clock. */
    clock?: () => number;
}

export interface ConnectOptions extends RegistryOptions {
    /** The logic to connect to. Default: `REGISTRY_LOGIC_ID` for a registry, `IDENTITY_LOGIC_ID` for an identity layer. */
    logicId?: string;
}

export interface DeployOptions extends RegistryOptions {
    /** KMOI (in ANU) sent to the new logic to back its own storage. Default 500 KMOI for a registry, 10 for an identity layer. */
    storageFund?: bigint;
    /** `AuthorityRegistry.deploy` only: the identity layer to bind the registry to. Default `IDENTITY_LOGIC_ID`. */
    identityLogicId?: string;
}

export interface WriteResult {
    /** Interaction hash. */
    hash: string;
    fuelUsed: number;
    receipt: Receipt;
}

export interface ResolveOptions {
    /**
     * Also require the grantor's DID and every actor's DID to be active in the
     * identity layer now. mal.md §3.1 checks identity at write time only, so
     * by default a deactivated DID keeps its authority until it is revoked.
     */
    requireActive?: boolean;
}

export interface EventOptions {
    fromHeight?: number;
    toHeight?: number;
    /**
     * Drop events about records that were not valid when written (see
     * `verifyRecord`). Anyone can write a record around the SDK and emit a
     * `DelegationCreated` naming any grant; a feed shown to people should set this.
     */
    verified?: boolean;
}

export interface PageOptions {
    offset?: number;
    limit?: number;
}

export interface Page<T> {
    ids: T[];
    total: number;
}

export interface WatchOptions {
    /** The first height to deliver; default the registry's current height. */
    fromHeight?: number;
    /** Milliseconds between polls. Default 5000. */
    intervalMs?: number;
    /** As for `events`. */
    verified?: boolean;
    /**
     * Called with each failure: a network error, or an error thrown by
     * `handler`. The watch keeps going and retries from the event that
     * failed, so that event and the ones before it at its height are
     * delivered again. Default: logged with console.error.
     */
    onError?: (error: AuthorityError) => void;
}

const DEFAULT_STORAGE_FUND = 500n * 1_000_000_000n;
const CACHE_SIZE = 10_000;
// Heights per log query. A query's range is inclusive, and the network
// refuses ranges spanning more than 10 heights.
const LOG_WINDOW = 10;

/**
 * A connection to a deployed AuthorityRegistry, signing as one account.
 *
 * ```ts
 * const registry = await AuthorityRegistry.connect(wallet);
 * await registry.enlist();
 * const { grantId } = await registry.createGrant({ ... });
 * const authority = await registry.resolveAuthority(grantId);
 * ```
 */
export class AuthorityRegistry {
    readonly #transport: Transport;
    readonly #now: () => number;
    /** Record bodies seen before, for their parent ids only; never used as a record. */
    readonly #bodies = new Map<string, Grant | Delegation>();
    /** verifyRecord results; whether a record was valid when written never changes. */
    readonly #verified = new Map<string, boolean>();

    private constructor(
        readonly logicId: Hex,
        /** The identity layer the registry asks for DID controllers and status. */
        readonly identityLogicId: Hex,
        driver: LogicDriver,
        readonly signer: Signer,
        options: RegistryOptions,
    ) {
        this.#transport = new Transport(driver, signer, logicId, options);
        this.#now = options.clock ?? (() => Math.floor(Date.now() / 1000));
    }

    /** Connects to the registry at `options.logicId`, by default `REGISTRY_LOGIC_ID`. */
    static async connect(signer: Signer, options: ConnectOptions = {}): Promise<AuthorityRegistry> {
        const id = toHex(options.logicId ?? REGISTRY_LOGIC_ID);
        let driver: LogicDriver;
        try {
            driver = await getLogicDriver(id, signer);
        } catch (error) {
            throw toAuthorityError(error, { logicId: id });
        }
        const { identity } = await new Transport(driver, signer, id, options).call("GetIdentity", []);
        return new AuthorityRegistry(id, toHex(identity), driver, signer, options);
    }

    /** Deploys a registry bound to the identity layer at `options.identityLogicId`, by default `IDENTITY_LOGIC_ID`. */
    static async deploy(signer: Signer, options: DeployOptions = {}): Promise<AuthorityRegistry> {
        const identity = toHex(options.identityLogicId ?? IDENTITY_LOGIC_ID);
        const logicId = await deployLogic(REGISTRY_MANIFEST, signer, [identity], options.storageFund ?? DEFAULT_STORAGE_FUND, options);
        return AuthorityRegistry.connect(signer, { ...options, logicId });
    }

    /** The account this connection signs as. */
    signerId(): Promise<Hex> {
        return this.#transport.sender();
    }

    // --- §3.2 -------------------------------------------------------------------

    /**
     * Enlists the signing account (mal.md §3.2): initializes its registry
     * state. Returns null when it is already enlisted. No access policy is
     * published: revocations live in the registry's own state, so nothing is
     * ever written into this account by anyone else (§3.6).
     */
    async enlist(): Promise<WriteResult | null> {
        if (await this.isEnlisted()) return null;
        return this.#written(await this.#transport.send("Enlist", []));
    }

    async isEnlisted(address?: string): Promise<boolean> {
        const id = toHex(address ?? (await this.#transport.sender()));
        const { enlisted } = await this.#transport.call("IsEnlisted", [id], { read: [id] });
        return Boolean(enlisted);
    }

    // --- §3.3 -------------------------------------------------------------------

    /**
     * Issues a grant. The shape and the grantees (§3.3 client steps a and b)
     * are checked here; the registry checks the sender and the §2.8 counts.
     */
    async createGrant(input: CreateGrantInput): Promise<WriteResult & { grantId: GrantId }> {
        validateGrantInput(input, this.#now());
        for (const grantee of input.grantees) await this.#requireActive(grantee);
        const result = await this.#transport.send("CreateGrant", [
            input.context, input.grantorDid, input.grantees, toWireScope(input.scope), input.maxDelegationDepth, input.expiresAt,
        ], { read: [this.identityLogicId, ...homeRoute(input.grantorDid)] });
        return { ...this.#written(result), grantId: String(result.output.grant_id) };
    }

    /**
     * Delegates part of a grant or delegation. Steps 1 and 3–8 of mal.md §3.3
     * are checked here against the stored parent and root; the registry checks
     * only the sender and the §2.8 counts, and stores the depth computed here.
     * A delegation written without these checks never resolves (§3.7).
     */
    async createDelegation(input: CreateDelegationInput): Promise<WriteResult & { delegationId: DelegationId }> {
        validateDelegationInput(input, this.#now());
        if (!isGrantId(input.grantId)) throw new AuthorityError(ErrorCode.UNKNOWN_PARENT, "UNKNOWN_PARENT: grantId is not a grant id");
        const depth = await this.#checkDelegation(input);
        await this.#requireActive(input.delegateeDid);
        const result = await this.#transport.send("CreateDelegation", [
            input.grantId, input.parentId, depth, input.delegatorDid, input.delegateeDid, toWireScope(input.scope), input.canDelegate ?? false, input.expiresAt,
        ], { read: [this.identityLogicId, ...homeRoute(input.delegatorDid)] });
        return { ...this.#written(result), delegationId: String(result.output.delegation_id) };
    }

    // --- §3.5, §3.6 ---------------------------------------------------------------

    /**
     * Revokes a grant; allowed for the grantor DID's current controller
     * (§3.5). The revocation is kept in the registry's own state, so it needs
     * nothing from the account that holds the grant.
     */
    async revokeGrant(grantId: GrantId): Promise<WriteResult> {
        const grant = (await this.getGrant(expectGrantId(grantId))) ?? fail(ErrorCode.UNKNOWN_GRANT);
        return this.#written(await this.#transport.send("RevokeGrant", [grantId], {
            read: [this.identityLogicId, routeOf(grantId), ...homeRoute(grant.grantorDid)],
        }));
    }

    /**
     * Revokes a delegation; allowed for the delegator DID's controller and the
     * root grantor's controller (§3.5, §3.6). Like a grant's, the revocation is
     * kept in the registry's own state.
     */
    async revokeDelegation(delegationId: DelegationId): Promise<WriteResult> {
        const record = (await this.getDelegation(expectDelegationId(delegationId))) ?? fail(ErrorCode.UNKNOWN_DELEGATION);
        const root = isGrantId(record.grantId) ? await this.getGrant(record.grantId) : null;
        return this.#written(await this.#transport.send("RevokeDelegation", [delegationId], {
            read: [
                this.identityLogicId, routeOf(delegationId), ...(isGrantId(record.grantId) ? [routeOf(record.grantId)] : []),
                ...homeRoute(record.delegatorDid), ...(root ? homeRoute(root.grantorDid) : []),
            ],
        }));
    }

    // --- §3.7 reads ---------------------------------------------------------------

    async getGrant(grantId: GrantId): Promise<Grant | null> {
        if (!isGrantId(grantId)) return null;
        const { found, grant } = await this.#transport.call("GetGrant", [grantId], { read: [routeOf(grantId)] });
        return found ? fromWireGrant(grant) : null;
    }

    async getDelegation(delegationId: DelegationId): Promise<Delegation | null> {
        if (!isDelegationId(delegationId)) return null;
        const { found, delegation } = await this.#transport.call("GetDelegation", [delegationId], { read: [routeOf(delegationId)] });
        return found ? fromWireDelegation(delegation) : null;
    }

    /** A page of the grant ids an account has issued, oldest first. */
    async listGrants(address: string, page: PageOptions = {}): Promise<Page<GrantId>> {
        return this.#list("ListGrants", "grant_ids", address, page);
    }

    /** A page of the delegation ids an account has issued, oldest first. */
    async listDelegations(address: string, page: PageOptions = {}): Promise<Page<DelegationId>> {
        return this.#list("ListDelegations", "delegation_ids", address, page);
    }

    /**
     * The authority behind a grant or delegation id (mal.md §3.7), re-proving
     * every link from the stored records. Resolution runs here, not on chain:
     * each record is one free read, so any depth resolves at no cost. Every
     * record is read fresh on every call; records this connection has seen
     * before only tell it the chain's ids up front, so it reads them all at
     * once instead of one parent at a time. Throws an AuthorityError with the
     * resolution code when the authority isn't live.
     */
    async resolveAuthority(ref: GrantId | DelegationId, options: ResolveOptions = {}): Promise<ResolvedAuthority> {
        parseId(ref);
        const authority = await resolveLocally(ref, this.#now(), await this.#freshChain(ref));
        if (options.requireActive) {
            for (const did of [authority.grantorDid, ...authority.actorBinding]) {
                if (!(await this.isActive(did))) throw new AuthorityError(ErrorCode.UNKNOWN_PARTY, `UNKNOWN_PARTY: ${did} is not active`);
            }
        }
        return authority;
    }

    /**
     * Whether a record was valid when it was written: well-formed, and for a
     * delegation, a correctly linked and narrowed link of a live chain at its
     * creation time, as the SDK checks before writing. Later revocation or
     * expiry doesn't change the answer. A record written around the SDK that
     * would never have resolved is false.
     */
    async verifyRecord(id: GrantId | DelegationId): Promise<boolean> {
        const known = this.#verified.get(id);
        if (known !== undefined) return known;
        const source = this.#source();
        let leaf: Grant | Delegation | null;
        try {
            leaf = isDelegationId(id) ? await source.getDelegation(id) : await source.getGrant(id);
        } catch (error) {
            // A stored record the codec refuses is malformed; anything else (the network) isn't an answer.
            if (!(error instanceof AuthorityError && error.code === ErrorCode.INVALID_SHAPE)) throw error;
            leaf = null;
            this.#cacheVerified(id, false);
        }
        if (!leaf) return false;
        // The chain as it stood when the record was written: revocations made later are hidden.
        const at = leaf.createdAt;
        const asOf = <T extends Grant | Delegation>(record: T | null): T | null =>
            record && record.revokedAt !== null && record.revokedAt > at ? { ...record, status: "active", revokedAt: null } : record;
        let valid: boolean;
        try {
            await resolveLocally(id, at, { getGrant: async (g) => asOf(await source.getGrant(g)), getDelegation: async (d) => asOf(await source.getDelegation(d)) });
            valid = true;
        } catch (error) {
            if (!(error instanceof AuthorityError) || error.code === ErrorCode.NETWORK_ERROR) throw error;
            valid = false;
        }
        this.#cacheVerified(id, valid);
        return valid;
    }

    // --- identity layer (§1.6) ----------------------------------------------------

    /** The account that controls `did`, or null when the identity layer doesn't know it. */
    async controllerOf(did: string): Promise<Hex | null> {
        const answer = await this.#identity("ControllerOf", did);
        if (!answer) return null;
        const { controller } = answer;
        const id = toHex(controller);
        return /^0x0*$/.test(id) ? null : id;
    }

    async isActive(did: string): Promise<boolean> {
        const answer = await this.#identity("IsActive", did);
        return Boolean(answer?.active);
    }

    /**
     * Asks the bound identity layer. MoiIdentity can't parse a string that
     * starts with "did:moi:" but isn't 64 hex digits, and fails the call; such
     * a DID is unknown (null). Other identity layers may use that prefix
     * differently, so the layer is always asked first.
     */
    async #identity(routine: string, did: string): Promise<Record<string, any> | null> {
        try {
            return await this.#transport.call(routine, [did], { read: [this.identityLogicId, ...homeRoute(did)] });
        } catch (error) {
            if (did.startsWith("did:moi:") && !isMoiDid(did)) return null;
            throw error;
        }
    }

    // --- §3.8 events ---------------------------------------------------------------

    /**
     * The registry events an interaction emitted. Logs are matched to the
     * receipt by tesseract hash and can be indexed a few seconds after the
     * receipt, so this retries for up to `waitMs`.
     */
    async getEvents(receipt: Receipt, waitMs = 15_000): Promise<RegistryEvent[]> {
        const participant = receipt.participants?.find((p) => p.id.toLowerCase() === this.logicId);
        if (!participant) return [];
        const height = Number(participant.height);
        for (const deadline = Date.now() + waitMs; ;) {
            const events = [];
            for await (const event of this.events({ fromHeight: Math.max(0, height - 1), toHeight: height + 3 })) {
                if (event.tsHash === receipt.ts_hash) events.push(event);
            }
            if (events.length > 0 || Date.now() >= deadline) return events.map(({ height: _h, tsHash: _t, ...event }) => event as RegistryEvent);
            await sleep(2000);
        }
    }

    /**
     * Every registry event between two heights of the registry logic's
     * account, oldest first: replay for indexers and caches (mal.md §3.8).
     * `toHeight` defaults to the current height.
     */
    async *events({ fromHeight = 0, toHeight, verified = false }: EventOptions = {}): AsyncGenerator<RecordedEvent> {
        if (!Number.isSafeInteger(fromHeight) || fromHeight < 0) throw invalidArgument(`invalid fromHeight: ${fromHeight}`);
        if (toHeight !== undefined && (!Number.isSafeInteger(toHeight) || toHeight < 0)) throw invalidArgument(`invalid toHeight: ${toHeight}`);
        const end = toHeight ?? (await this.#height());
        for (let start = fromHeight; start <= end; start += LOG_WINDOW) {
            const stop = Math.min(start + LOG_WINDOW - 1, end);
            let logs;
            try {
                logs = await this.signer.getProvider().getLogs({ id: this.logicId, height: [start, stop], topics: [] });
            } catch (error) {
                throw toAuthorityError(error, { stage: "events", fromHeight: start, toHeight: stop });
            }
            for (const log of logs) {
                const event = decodeLog(log);
                // The node reports a participant's account as `id`; the SDK's type calls it `address`.
                const participants = (log.participants ?? []) as unknown as { id?: string; address?: string; height: string }[];
                const own = participants.find((p) => (p.id ?? p.address ?? "").toLowerCase() === this.logicId);
                const height = Number(own?.height ?? start);
                if (!event) continue;
                if (verified && !(await this.#genuine(event))) continue;
                yield { ...event, height, tsHash: log.ts_hash };
            }
        }
    }

    /**
     * Calls `handler` for each new registry event, in order, polling every
     * `intervalMs`. Delivery is at least once (mal.md §3.8): handlers must be
     * idempotent. A failure never stops the watch or escapes it: it goes to
     * `onError`, and the watch retries from where it failed. Returns a
     * function that stops the watch.
     */
    watch(handler: (event: RecordedEvent) => void | Promise<void>, options: WatchOptions = {}): () => void {
        const { intervalMs = 5000, verified = false } = options;
        const onError = options.onError ?? ((error: AuthorityError) => console.error("js-mal-sdk watch:", error));
        let stopped = false;
        let next = options.fromHeight;
        const loop = async () => {
            while (!stopped) {
                try {
                    next ??= await this.#height();
                    const current = await this.#height();
                    if (current >= next) {
                        for await (const event of this.events({ fromHeight: next, toHeight: current, verified })) {
                            if (stopped) return;
                            // Should anything fail from here, resume at this event's height.
                            next = event.height;
                            await handler(event);
                        }
                        next = current + 1;
                    }
                } catch (error) {
                    try {
                        onError(toAuthorityError(error, { stage: "watch", height: next }));
                    } catch {
                        // An onError that throws mustn't end the watch.
                    }
                }
                if (!stopped) await sleep(intervalMs);
            }
        };
        void loop();
        return () => {
            stopped = true;
        };
    }

    // --- internals ----------------------------------------------------------------

    /** An event is about a genuine record when that record was valid when written. */
    async #genuine(event: RegistryEvent): Promise<boolean> {
        if (event.name === "Enlisted") return true;
        return this.verifyRecord("delegationId" in event ? event.delegationId : event.grantId);
    }

    /**
     * Reads every record of `ref`'s chain fresh for this resolution. Bodies
     * never change after they are written (only revocation does), so the
     * parent ids of records seen before are known; those reads go out
     * together, and only parents never seen are read one after another.
     */
    async #freshChain(ref: string): Promise<RecordSource> {
        const reads = new Map<string, Promise<Grant | Delegation | null>>();
        const read = (id: string) => {
            if (!reads.has(id)) {
                const pending = (isDelegationId(id) ? this.getDelegation(id) : this.getGrant(id)).then((record) => {
                    if (record) this.#remember(id, record);
                    return record;
                });
                pending.catch(() => {});
                reads.set(id, pending);
            }
            return reads.get(id)!;
        };
        // Read the chain this connection already knows, all at once.
        const known: string[] = [];
        for (let id: string | undefined = ref; id && known.length <= LIMITS.maxDelegationDepth; ) {
            known.push(id);
            const body = this.#bodies.get(id);
            id = body && "delegationId" in body ? body.parentId : undefined;
        }
        known.forEach(read);
        // Then follow parents it hasn't seen.
        for (let id: string | undefined = ref, hops = 0; id && hops <= LIMITS.maxDelegationDepth; hops++) {
            const record: Grant | Delegation | null = await read(id).catch(() => null);
            id = record && "delegationId" in record ? record.parentId : undefined;
        }
        return {
            getGrant: (id) => read(id) as Promise<Grant | null>,
            getDelegation: (id) => read(id) as Promise<Delegation | null>,
        };
    }

    #remember(id: string, record: Grant | Delegation): void {
        if (this.#bodies.size >= CACHE_SIZE) this.#bodies.clear();
        this.#bodies.set(id, record);
    }

    #cacheVerified(id: string, valid: boolean): void {
        if (this.#verified.size >= CACHE_SIZE) this.#verified.clear();
        this.#verified.set(id, valid);
    }

    #source(): RecordSource {
        return { getGrant: (id) => this.getGrant(id), getDelegation: (id) => this.getDelegation(id) };
    }

    /** §3.3 client steps b and g: a party must be active in the identity layer. */
    async #requireActive(did: string): Promise<void> {
        if (!(await this.isActive(did))) throw new AuthorityError(ErrorCode.UNKNOWN_PARTY, `UNKNOWN_PARTY: ${did}`);
    }

    /** mal.md §3.3 client steps b–f, against the stored records. Returns the new link's depth. */
    async #checkDelegation(input: CreateDelegationInput): Promise<number> {
        const now = this.#now();
        const root = (await this.getGrant(input.grantId)) ?? fail(ErrorCode.UNKNOWN_PARENT);
        const parentIsGrant = input.parentId === input.grantId;
        let parent: Delegation | null = null;
        if (!parentIsGrant) {
            parent = await this.getDelegation(input.parentId);
            if (!parent || parent.grantId !== input.grantId) fail(ErrorCode.UNKNOWN_PARENT);
        }
        parentLive(root, now);
        if (parent) parentLive(parent, now);
        if (parentIsGrant ? !root.grantees.includes(input.delegatorDid) : parent!.delegateeDid !== input.delegatorDid) fail(ErrorCode.NOT_HOLDER);
        const depth = parent ? parent.depth + 1 : 1;
        if (depth > root.maxDelegationDepth) fail(ErrorCode.DEPTH_VIOLATION);
        if (parent && !parent.canDelegate) fail(ErrorCode.DELEGATION_NOT_PERMITTED);
        const escalation = attenuationEscalation(input.scope, input.expiresAt, parent?.scope ?? root.scope, parent?.expiresAt ?? root.expiresAt);
        if (escalation) {
            throw new AuthorityError(ErrorCode.SCOPE_ESCALATION, `SCOPE_ESCALATION: ${escalation}`, { escalation });
        }
        return depth;
    }

    async #height(): Promise<number> {
        try {
            return Number((await this.signer.getProvider().getAccountMetaInfo(this.logicId)).height);
        } catch (error) {
            throw toAuthorityError(error, { stage: "height" });
        }
    }

    async #list<T>(routine: string, field: string, address: string, { offset = 0, limit = 50 }: PageOptions): Promise<Page<T>> {
        if (offset < 0 || limit < 1) throw invalidArgument("offset must be >= 0 and limit >= 1");
        const id = toHex(address);
        const out = await this.#transport.call(routine, [id, offset, limit], { read: [id] });
        return { ids: (out[field] ?? []).map(String) as T[], total: Number(out.total ?? 0) };
    }

    #written({ hash, receipt }: { hash: string; receipt: Receipt }): WriteResult {
        return { hash, receipt, fuelUsed: Number(receipt.fuel_used) };
    }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A did:moi DID's home account, which MoiIdentity reads; none for other DID methods. */
const homeRoute = (did: string): Hex[] => (isMoiDid(did) ? [homeOf(did)] : []);

const fail = (code: ErrorCode): never => {
    throw new AuthorityError(code);
};

const expectGrantId = (id: string): GrantId => {
    if (!isGrantId(id)) throw invalidArgument(`not a grant id: ${id}`);
    return id;
};

const expectDelegationId = (id: string): DelegationId => {
    if (!isDelegationId(id)) throw invalidArgument(`not a delegation id: ${id}`);
    return id;
};

/** §3.3 client step c: a dead parent or root is reported as the parent's failure. */
const parentLive = (record: Grant | Delegation, now: number): void => {
    if (record.version !== VERSION) fail(ErrorCode.UNSUPPORTED_VERSION);
    if (record.status === "revoked") fail(ErrorCode.PARENT_REVOKED);
    if (now >= record.expiresAt) fail(ErrorCode.PARENT_EXPIRED);
};
