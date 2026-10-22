// The logics the SDK connects to unless told otherwise: the AuthorityRegistry
// and MoiIdentity deployed on MOI's devnet. Set MOI_AUTHORITY_REGISTRY_LOGIC_ID
// or MOI_IDENTITY_LOGIC_ID to use other deployments.

/** An environment variable, where the runtime has them. */
const env = (name: string): string | undefined =>
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name] || undefined;

/** The AuthorityRegistry logic `AuthorityRegistry.connect` uses by default. */
export const REGISTRY_LOGIC_ID: string = env("MOI_AUTHORITY_REGISTRY_LOGIC_ID")
    ?? "0x20000000da714779e4a5a3e9aad5e280ce90a026757ef8ca0c2a8d2400000000";

/** The MoiIdentity logic `MoiIdentity.connect` and `AuthorityRegistry.deploy` use by default. */
export const IDENTITY_LOGIC_ID: string = env("MOI_IDENTITY_LOGIC_ID")
    ?? "0x20000000928c74bb345d4bdc726dfe22ed485742c6640a9df86d71b300000000";
