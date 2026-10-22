// Conversion between the spec's types and the registry's wire structs
// (mal.md §2.3–§2.5).

import { CONSTRAINT_KIND } from "./constants.js";
import { invalidShape } from "./errors.js";
import type { ConstraintValue, Delegation, Grant, Hex, ScopeEntry } from "./types.js";

export interface WireConstraint {
    key: string;
    kind: number;
    text: string;
    number: number;
    flag: boolean;
    texts: string[];
    numbers: number[];
}

export interface WireScopeEntry {
    resource: string;
    actions: string[];
    constraints: WireConstraint[];
}

const KIND_NAMES = Object.fromEntries(Object.entries(CONSTRAINT_KIND).map(([name, code]) => [code, name])) as Record<number, ConstraintValue["kind"]>;

const toWireConstraint = (key: string, value: ConstraintValue): WireConstraint => {
    const wire: WireConstraint = { key, kind: CONSTRAINT_KIND[value.kind], text: "", number: 0, flag: false, texts: [], numbers: [] };
    switch (value.kind) {
        case "number": wire.number = value.value; break;
        case "boolean": wire.flag = value.value; break;
        case "strings": wire.texts = [...value.value]; break;
        case "numbers": wire.numbers = [...value.value]; break;
        default: wire.text = value.value;
    }
    return wire;
};

export const toWireScope = (scope: ScopeEntry[]): WireScopeEntry[] =>
    scope.map((entry) => ({
        resource: entry.resource,
        actions: [...entry.actions],
        constraints: Object.entries(entry.constraints ?? {}).map(([key, value]) => toWireConstraint(key, value)),
    }));

// --- decoding outputs ----------------------------------------------------------

const num = (value: unknown): number => (value == null ? 0 : Number(value));
const str = (value: unknown): string => (value == null ? "" : String(value));
const list = <T = unknown>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

export const toHex = (value: unknown): Hex => {
    if (value instanceof Uint8Array) return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const text = str(value).toLowerCase();
    return (text.startsWith("0x") ? text : `0x${text}`) as Hex;
};

// The registry stores what it is sent (mal.md §3.3), so a stored
// constraint is decoded strictly: an unknown kind, a field set outside its kind
// or a repeated key can't be represented as a ConstraintValue without guessing,
// and a guess could differ between resolvers. Such a record is malformed.
const fromWireConstraint = (raw: any, entry: number): ConstraintValue => {
    const kind = KIND_NAMES[num(raw.kind)];
    const key = str(raw.key);
    if (!kind || key === "") throw invalidShape(`stored scope[${entry}].constraints has an invalid key or kind`);
    const textual = kind === "string" || kind === "ref";
    const stray = (!textual && str(raw.text) !== "") || (kind !== "number" && num(raw.number) !== 0) || (kind !== "boolean" && Boolean(raw.flag))
        || (kind !== "strings" && list(raw.texts).length > 0) || (kind !== "numbers" && list(raw.numbers).length > 0);
    if (stray) throw invalidShape(`stored scope[${entry}].constraints.${key} is not well-typed`);
    switch (kind) {
        case "number": return { kind, value: num(raw.number) };
        case "boolean": return { kind, value: Boolean(raw.flag) };
        case "strings": return { kind, value: list(raw.texts).map(str) };
        case "numbers": return { kind, value: list(raw.numbers).map(num) };
        default: return { kind, value: str(raw.text) };
    }
};

export const fromWireScope = (raw: unknown): ScopeEntry[] =>
    list<any>(raw).map((entry, i) => {
        const constraints: Record<string, ConstraintValue> = {};
        for (const c of list<any>(entry.constraints)) {
            const key = str(c.key);
            if (Object.hasOwn(constraints, key)) throw invalidShape(`stored scope[${i}].constraints has duplicate key ${key}`);
            constraints[key] = fromWireConstraint(c, i);
        }
        return { resource: str(entry.resource), actions: list(entry.actions).map(str), constraints };
    });

// The registry stores only `revoked_at` (0 while live); §2.4's status follows from it.
const status = (raw: unknown) => (num(raw) > 0 ? "revoked" : "active") as Grant["status"];
const revokedAt = (raw: unknown) => (num(raw) > 0 ? num(raw) : null);

export const fromWireGrant = (raw: any): Grant => ({
    version: num(raw.version),
    grantId: str(raw.grant_id),
    context: str(raw.context),
    grantorDid: str(raw.grantor_did),
    grantees: list(raw.grantees).map(str),
    scope: fromWireScope(raw.scope),
    maxDelegationDepth: num(raw.max_delegation_depth),
    createdAt: num(raw.created_at),
    expiresAt: num(raw.expires_at),
    status: status(raw.revoked_at),
    revokedAt: revokedAt(raw.revoked_at),
});

export const fromWireDelegation = (raw: any): Delegation => ({
    version: num(raw.version),
    delegationId: str(raw.delegation_id),
    grantId: str(raw.grant_id),
    parentId: str(raw.parent_id),
    depth: num(raw.depth),
    delegatorDid: str(raw.delegator_did),
    delegateeDid: str(raw.delegatee_did),
    scope: fromWireScope(raw.scope),
    canDelegate: Boolean(raw.can_delegate),
    createdAt: num(raw.created_at),
    expiresAt: num(raw.expires_at),
    status: status(raw.revoked_at),
    revokedAt: revokedAt(raw.revoked_at),
});
