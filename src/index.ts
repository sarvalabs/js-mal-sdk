// mal.md Part VI: bindings, a local resolver, a local attenuation checker,
// id utilities and event streams.

export { AuthorityRegistry } from "./registry.js";
export type { ConnectOptions, DeployOptions, EventOptions, Page, PageOptions, RegistryOptions, ResolveOptions, WatchOptions, WriteResult } from "./registry.js";
export type { Receipt, TransportOptions } from "./transport.js";

export { MoiIdentity, didOf, homeOf, isMoiDid } from "./identity.js";
export { IDENTITY_LOGIC_ID, REGISTRY_LOGIC_ID } from "./defaults.js";
export { IDENTITY_MANIFEST } from "./identity-manifest.js";

export { resolveAuthority } from "./resolver.js";
export type { RecordSource } from "./resolver.js";
export { attenuationEscalation, constraintWithin, entryEscalation, isNarrower } from "./attenuation.js";
export { validateDelegationInput, validateGrantInput, validateScope } from "./validate.js";
export { buildId, isDelegationId, isGrantId, parseId, routeOf } from "./ids.js";
export type { ParsedId, Route } from "./ids.js";
export { decodeLog } from "./events.js";
export type { RecordedEvent, RegistryEvent } from "./events.js";

export { AuthorityError } from "./errors.js";
export { ErrorCode, LIMITS, VERSION } from "./constants.js";
export { REGISTRY_MANIFEST } from "./manifest.js";

export type {
    ConstraintValue, CreateDelegationInput, CreateGrantInput, Delegation, DelegationId, DID, Grant, GrantId, Hex,
    ResolvedAuthority, ScopeEntry, Status,
} from "./types.js";
