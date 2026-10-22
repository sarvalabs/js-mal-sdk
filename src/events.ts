// mal.md §3.8 events, decoded, and streams of them with replay from a height.

import { ManifestCoder, topicHash } from "js-moi-sdk";
import { toHex } from "./codec.js";
import { REGISTRY_MANIFEST } from "./manifest.js";
import type { DelegationId, DID, GrantId, Hex } from "./types.js";

export type RegistryEvent =
    | { name: "Enlisted"; address: Hex }
    | { name: "GrantCreated"; grantId: GrantId; grantorDid: DID; context: string }
    | { name: "GrantRevoked"; grantId: GrantId }
    | { name: "DelegationCreated"; delegationId: DelegationId; grantId: GrantId; delegatorDid: DID; delegateeDid: DID }
    | { name: "DelegationRevoked"; delegationId: DelegationId; grantId: GrantId };

/** A decoded event with where it was recorded. */
export type RecordedEvent = RegistryEvent & { height: number; tsHash: string };

const NAMES = ["Enlisted", "GrantCreated", "GrantRevoked", "DelegationCreated", "DelegationRevoked"] as const;
const CODER = new ManifestCoder(REGISTRY_MANIFEST as never);
const BY_TOPIC = new Map<string, (typeof NAMES)[number]>(NAMES.map((name) => [topicHash(name), name]));

export interface RawLog {
    topics: string[];
    data: string;
    ts_hash: string;
}

/** Decodes a log of the registry logic, or returns null for one that isn't a registry event. */
export const decodeLog = (log: RawLog): RegistryEvent | null => {
    const name = BY_TOPIC.get(log.topics?.[0] ?? "");
    if (!name) return null;
    const raw = CODER.decodeEventOutput(name, log.data) as Record<string, unknown>;
    const s = (key: string) => String(raw[key] ?? "");
    switch (name) {
        case "Enlisted": return { name, address: toHex(raw.address) };
        case "GrantCreated": return { name, grantId: s("grant_id"), grantorDid: s("grantor_did"), context: s("context") };
        case "GrantRevoked": return { name, grantId: s("grant_id") };
        case "DelegationCreated": return { name, delegationId: s("delegation_id"), grantId: s("grant_id"), delegatorDid: s("delegator_did"), delegateeDid: s("delegatee_did") };
        case "DelegationRevoked": return { name, delegationId: s("delegation_id"), grantId: s("grant_id") };
    }
};
