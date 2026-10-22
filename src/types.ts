// The data model of mal.md Part II, in the spec's own names.

/** A 0x-prefixed hex string. */
export type Hex = `0x${string}`;

/** A DID, as the identity layer knows it. */
export type DID = string;

/** `grt_<owner-address-hex>_<seq>` (mal.md §2.2). */
export type GrantId = string;
/** `del_<owner-address-hex>_<seq>` (mal.md §2.2). */
export type DelegationId = string;

/** mal.md §2.3 */
export type ConstraintValue =
    | { kind: "string"; value: string }
    | { kind: "number"; value: number }
    | { kind: "boolean"; value: boolean }
    | { kind: "strings"; value: string[] }
    | { kind: "numbers"; value: number[] }
    | { kind: "ref"; value: string };

/** mal.md §2.3: one resource, with the actions and constraints that belong to it. */
export interface ScopeEntry {
    resource: string;
    actions: string[];
    constraints: Record<string, ConstraintValue>;
}

export type Status = "active" | "revoked";

/** mal.md §2.4 */
export interface Grant {
    version: number;
    grantId: GrantId;
    context: string;
    grantorDid: DID;
    grantees: DID[];
    scope: ScopeEntry[];
    maxDelegationDepth: number;
    /** Epoch seconds, as are all timestamps. */
    createdAt: number;
    expiresAt: number;
    status: Status;
    revokedAt: number | null;
}

/** mal.md §2.5 */
export interface Delegation {
    version: number;
    delegationId: DelegationId;
    grantId: GrantId;
    /** The grant id when depth is 1, else the parent delegation id. */
    parentId: GrantId | DelegationId;
    depth: number;
    delegatorDid: DID;
    delegateeDid: DID;
    scope: ScopeEntry[];
    canDelegate: boolean;
    createdAt: number;
    expiresAt: number;
    status: Status;
    revokedAt: number | null;
}

/** mal.md §3.7 */
export interface ResolvedAuthority {
    grantId: GrantId;
    /** The root's. */
    context: string;
    /** The root's: the identity every action is accountable to. */
    grantorDid: DID;
    /** The grantees for a grant ref; the delegatee for a delegation ref. */
    actorBinding: DID[];
    /** The leaf's, narrowest by construction. */
    scope: ScopeEntry[];
    maxDelegationDepth: number;
    /** The leaf's. */
    expiresAt: number;
    /** Ids leaf-first, the grant id last. */
    chain: (GrantId | DelegationId)[];
}

/** mal.md §3.3 createGrant */
export interface CreateGrantInput {
    context: string;
    grantorDid: DID;
    grantees: DID[];
    scope: ScopeEntry[];
    maxDelegationDepth: number;
    expiresAt: number;
}

/** mal.md §3.3 createDelegation. `delegatorDid` is explicit; the SDK computes `depth`. */
export interface CreateDelegationInput {
    grantId: GrantId;
    parentId: GrantId | DelegationId;
    delegatorDid: DID;
    delegateeDid: DID;
    scope: ScopeEntry[];
    /** Default false. */
    canDelegate?: boolean;
    expiresAt: number;
}
