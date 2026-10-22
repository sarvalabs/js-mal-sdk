// mal.md §3.7 resolveAuthority over records from any source: live reads, or a
// gateway's cache. This is the only resolver: the registry stores records and
// checks who wrote them, and leaves shape, structure and attenuation to the
// SDK (mal.md §3.1, §3.7). So every record is re-proven here: it is
// well-formed, live, linked to its parent and narrower than it. Nothing
// trusts that creation-time validation ran.

import { attenuationEscalation } from "./attenuation.js";
import { ErrorCode, LIMITS, VERSION } from "./constants.js";
import { AuthorityError } from "./errors.js";
import { isDelegationId } from "./ids.js";
import type { Delegation, Grant, ResolvedAuthority } from "./types.js";
import { validateScope } from "./validate.js";

/** Where the resolver reads records from. Return null for a record that doesn't exist. */
export interface RecordSource {
    getGrant(grantId: string): Promise<Grant | null>;
    getDelegation(delegationId: string): Promise<Delegation | null>;
}

const encoder = new TextEncoder();

const fail = (code: ErrorCode): never => {
    throw new AuthorityError(code);
};

/**
 * The §2.3–§2.5 and §2.8 shape the SDK writes. A record without it was written
 * around the SDK, and resolves as BROKEN_CHAIN.
 */
const wellFormed = (record: Grant | Delegation): boolean => {
    try {
        validateScope(record.scope);
    } catch {
        return false;
    }
    const short = (value: string) => encoder.encode(value).length <= LIMITS.maxStringBytes;
    if ("delegationId" in record) {
        return Number.isSafeInteger(record.depth) && record.depth >= 1 && record.depth <= LIMITS.maxDelegationDepth
            && [record.grantId, record.parentId, record.delegatorDid, record.delegateeDid].every(short);
    }
    const { grantees } = record;
    return record.context !== "" && grantees.length > 0 && grantees.length <= LIMITS.maxGrantees
        && new Set(grantees).size === grantees.length
        && Number.isSafeInteger(record.maxDelegationDepth) && record.maxDelegationDepth >= 0 && record.maxDelegationDepth <= LIMITS.maxDelegationDepth
        && [record.context, record.grantorDid, ...grantees].every(short);
};

/**
 * Reads record `id`. A record that can't be decoded (the codec refuses a
 * malformed stored scope), isn't well-formed or isn't the record asked for
 * (a source returning the wrong record) fails with BROKEN_CHAIN.
 */
const read = async <T extends Grant | Delegation>(id: string, load: (id: string) => Promise<T | null>, missing: ErrorCode): Promise<T> => {
    let record: T | null;
    try {
        record = await load(id);
    } catch (error) {
        if (error instanceof AuthorityError && error.code === ErrorCode.INVALID_SHAPE) fail(ErrorCode.BROKEN_CHAIN);
        throw error;
    }
    if (!record) return fail(missing);
    const own = "delegationId" in record ? record.delegationId : record.grantId;
    if (own !== id || !wellFormed(record)) fail(ErrorCode.BROKEN_CHAIN);
    return record;
};

/** §2.7 liveness and §3.9 versioning. */
const assertLive = (record: Grant | Delegation, now: number): void => {
    const kind = "grantId" in record && !("delegationId" in record) ? "GRANT" : "DELEGATION";
    if (record.version !== VERSION) fail(ErrorCode.UNSUPPORTED_VERSION);
    if (record.status === "revoked") fail(ErrorCode[`${kind}_REVOKED`]);
    if (now >= record.expiresAt) fail(ErrorCode[`${kind}_EXPIRED`]);
};

/**
 * Resolves `ref` (a grant or delegation id) at time `now` (epoch seconds).
 * Throws an AuthorityError with the §3.10 resolution code when the authority
 * isn't live.
 */
export const resolveAuthority = async (ref: string, now: number, source: RecordSource): Promise<ResolvedAuthority> => {
    if (!isDelegationId(ref)) {
        const grant = await read(ref, (id) => source.getGrant(id), ErrorCode.UNKNOWN_GRANT);
        assertLive(grant, now);
        return {
            grantId: ref, context: grant.context, grantorDid: grant.grantorDid, actorBinding: grant.grantees,
            scope: grant.scope, maxDelegationDepth: grant.maxDelegationDepth, expiresAt: grant.expiresAt, chain: [ref],
        };
    }

    const leaf = await read(ref, (id) => source.getDelegation(id), ErrorCode.UNKNOWN_DELEGATION);
    assertLive(leaf, now);
    const chain = [ref];
    let current = leaf;

    for (let hop = 0; hop < LIMITS.maxDelegationDepth; hop++) {
        if (current.depth === 1) {
            const grant = await read(current.grantId, (id) => source.getGrant(id), ErrorCode.BROKEN_CHAIN);
            assertLive(grant, now);
            if (leaf.depth > grant.maxDelegationDepth) fail(ErrorCode.BROKEN_CHAIN);
            // assertLink(current, grant)
            if (current.parentId !== current.grantId || current.grantId !== grant.grantId) fail(ErrorCode.BROKEN_CHAIN);
            if (!grant.grantees.includes(current.delegatorDid)) fail(ErrorCode.BROKEN_CHAIN);
            // assertAttenuation(current, grant)
            if (attenuationEscalation(current.scope, current.expiresAt, grant.scope, grant.expiresAt) !== null) fail(ErrorCode.BROKEN_CHAIN);
            chain.push(current.grantId);
            return {
                grantId: grant.grantId, context: grant.context, grantorDid: grant.grantorDid,
                actorBinding: [leaf.delegateeDid], scope: leaf.scope, maxDelegationDepth: grant.maxDelegationDepth,
                expiresAt: leaf.expiresAt, chain,
            };
        }

        const parent = await read(current.parentId, (id) => source.getDelegation(id), ErrorCode.BROKEN_CHAIN);
        assertLive(parent, now);
        if (!parent.canDelegate) fail(ErrorCode.BROKEN_CHAIN);
        // assertLink(current, parent)
        if (parent.depth + 1 !== current.depth || parent.delegateeDid !== current.delegatorDid || parent.grantId !== current.grantId) {
            fail(ErrorCode.BROKEN_CHAIN);
        }
        // assertAttenuation(current, parent)
        if (attenuationEscalation(current.scope, current.expiresAt, parent.scope, parent.expiresAt) !== null) fail(ErrorCode.BROKEN_CHAIN);
        chain.push(current.parentId);
        current = parent;
    }
    return fail(ErrorCode.BROKEN_CHAIN);
};
