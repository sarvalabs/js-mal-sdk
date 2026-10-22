/** The record schema version this SDK reads and writes (mal.md §3.9). */
export const VERSION = 1;

/** mal.md §2.8. */
export const LIMITS = {
    maxScopeEntries: 64,
    maxActionsPerEntry: 64,
    maxConstraintsPerEntry: 32,
    maxGrantees: 32,
    maxDelegationDepth: 16,
    /** Values in a list constraint. */
    maxListValues: 64,
    /** UTF-8 bytes in any string a record stores. */
    maxStringBytes: 256,
    /**
     * Bytes in a whole scope: every string, plus 8 per number. Keeps a record
     * readable with a free call, which a MOI node caps at 100,000 fuel.
     */
    maxScopeBytes: 16_384,
} as const;

/** Wire values of the registry's constraint kind (mal.md §2.3). */
export const CONSTRAINT_KIND = {
    string: 1,
    number: 2,
    boolean: 3,
    strings: 4,
    numbers: 5,
    ref: 6,
} as const;

/** mal.md §3.10, plus the SDK's own codes. */
export const ErrorCode = {
    NOT_CONTROLLER: "NOT_CONTROLLER",
    NOT_ENLISTED: "NOT_ENLISTED",
    UNKNOWN_PARTY: "UNKNOWN_PARTY",
    INVALID_SHAPE: "INVALID_SHAPE",
    UNSUPPORTED_VERSION: "UNSUPPORTED_VERSION",
    UNKNOWN_PARENT: "UNKNOWN_PARENT",
    PARENT_REVOKED: "PARENT_REVOKED",
    PARENT_EXPIRED: "PARENT_EXPIRED",
    NOT_HOLDER: "NOT_HOLDER",
    DEPTH_VIOLATION: "DEPTH_VIOLATION",
    DELEGATION_NOT_PERMITTED: "DELEGATION_NOT_PERMITTED",
    SCOPE_ESCALATION: "SCOPE_ESCALATION",
    NOT_AUTHORIZED_TO_REVOKE: "NOT_AUTHORIZED_TO_REVOKE",
    ALREADY_REVOKED: "ALREADY_REVOKED",
    UNKNOWN_GRANT: "UNKNOWN_GRANT",
    UNKNOWN_DELEGATION: "UNKNOWN_DELEGATION",
    GRANT_REVOKED: "GRANT_REVOKED",
    GRANT_EXPIRED: "GRANT_EXPIRED",
    DELEGATION_REVOKED: "DELEGATION_REVOKED",
    DELEGATION_EXPIRED: "DELEGATION_EXPIRED",
    BROKEN_CHAIN: "BROKEN_CHAIN",
    /** MoiIdentity: the sender doesn't control the DID it tries to change. */
    NOT_DID_CONTROLLER: "NOT_DID_CONTROLLER",
    /** MoiIdentity: the string isn't a did:moi DID. */
    UNKNOWN_DID: "UNKNOWN_DID",
    /** The interaction executed but the network discarded its state changes. */
    STATE_REVERTED: "STATE_REVERTED",
    /** The network rejected the interaction, or failed in a way not listed above. */
    NETWORK_ERROR: "NETWORK_ERROR",
    /** An argument the SDK could not interpret, such as a malformed id. */
    INVALID_ARGUMENT: "INVALID_ARGUMENT",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
