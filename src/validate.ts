// mal.md §3.3 client step a (shape), exactly as the registry checks it and with the same
// messages, so a request that passes here fails on chain only for reasons
// that need chain state.

import { LIMITS } from "./constants.js";
import { invalidShape } from "./errors.js";
import type { ConstraintValue, CreateDelegationInput, CreateGrantInput, ScopeEntry } from "./types.js";

const KINDS = new Set(["string", "number", "boolean", "strings", "numbers", "ref"]);
const u64 = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const encoder = new TextEncoder();

/** A string size bound (§2.8), in UTF-8 bytes, as the registry counts them. */
const checkString = (value: string, field: string): void => {
    if (encoder.encode(value).length > LIMITS.maxStringBytes) throw invalidShape(`${field} exceeds MAX_STRING_BYTES`);
};

const checkConstraint = (value: ConstraintValue, entry: number, key: string): void => {
    if (key.length === 0 || !KINDS.has(value?.kind)) throw invalidShape(`scope[${entry}].constraints has an invalid key or kind`);
    const typed = (() => {
        switch (value.kind) {
            case "number": return u64(value.value);
            case "boolean": return typeof value.value === "boolean";
            case "strings": return Array.isArray(value.value) && value.value.every((v) => typeof v === "string");
            case "numbers": return Array.isArray(value.value) && value.value.every(u64);
            default: return typeof value.value === "string";
        }
    })();
    if (!typed) throw invalidShape(`scope[${entry}].constraints.${key} is not well-typed`);
    checkString(key, `scope[${entry}].constraints key`);
    if (value.kind === "strings" || value.kind === "numbers") {
        if (value.value.length > LIMITS.maxListValues) throw invalidShape(`scope[${entry}].constraints.${key} exceeds MAX_LIST_VALUES`);
        if (value.kind === "strings") for (const text of value.value) checkString(text, `scope[${entry}].constraints.${key}`);
    } else if (value.kind === "string" || value.kind === "ref") {
        checkString(value.value, `scope[${entry}].constraints.${key}`);
    }
};

/** Every string's UTF-8 bytes, plus 8 per number: what a read of the scope has to load. */
const scopeBytes = (scope: ScopeEntry[]): number => {
    let total = 0;
    const add = (text: string) => { total += encoder.encode(text).length; };
    for (const entry of scope) {
        add(entry.resource);
        entry.actions.forEach(add);
        for (const [key, value] of Object.entries(entry.constraints ?? {})) {
            add(key);
            switch (value.kind) {
                case "strings": value.value.forEach(add); break;
                case "numbers": total += 8 * value.value.length; break;
                case "number": case "boolean": total += 8; break;
                default: add(value.value);
            }
        }
    }
    return total;
};

export const validateScope = (scope: ScopeEntry[]): void => {
    if (!Array.isArray(scope) || scope.length === 0) throw invalidShape("scope is empty");
    if (scope.length > LIMITS.maxScopeEntries) throw invalidShape("scope exceeds MAX_SCOPE_ENTRIES");
    scope.forEach((entry, i) => {
        if (!entry.resource) throw invalidShape(`scope[${i}].resource is empty`);
        if (!Array.isArray(entry.actions) || entry.actions.length === 0) throw invalidShape(`scope[${i}].actions is empty`);
        if (entry.actions.length > LIMITS.maxActionsPerEntry) throw invalidShape(`scope[${i}].actions exceeds MAX_ACTIONS_PER_ENTRY`);
        checkString(entry.resource, `scope[${i}].resource`);
        entry.actions.forEach((action, j) => checkString(action, `scope[${i}].actions[${j}]`));
        const keys = Object.keys(entry.constraints ?? {});
        if (keys.length > LIMITS.maxConstraintsPerEntry) throw invalidShape(`scope[${i}].constraints exceeds MAX_CONSTRAINTS_PER_ENTRY`);
        for (const key of keys) checkConstraint(entry.constraints[key]!, i, key);
        for (let j = 0; j < i; j++) {
            if (scope[j]!.resource !== entry.resource) continue;
            const repeated = entry.actions.find((action) => scope[j]!.actions.includes(action));
            if (repeated !== undefined) throw invalidShape(`scope[${i}] repeats (${entry.resource}, ${repeated})`);
        }
    });
    if (scopeBytes(scope) > LIMITS.maxScopeBytes) throw invalidShape("scope exceeds MAX_SCOPE_BYTES");
};

const checkExpiry = (expiresAt: number, now: number): void => {
    if (!u64(expiresAt) || expiresAt <= now) throw invalidShape("expiresAt is not in the future");
};

export const validateGrantInput = (input: CreateGrantInput, now: number): void => {
    if (!input.context) throw invalidShape("context is empty");
    checkString(input.context, "context");
    checkString(input.grantorDid, "grantorDid");
    const { grantees } = input;
    if (!Array.isArray(grantees) || grantees.length === 0) throw invalidShape("grantees is empty");
    if (grantees.length > LIMITS.maxGrantees) throw invalidShape("grantees exceeds MAX_GRANTEES");
    grantees.forEach((grantee, i) => {
        if (grantees.indexOf(grantee) < i) throw invalidShape(`grantees[${i}] is a duplicate`);
        checkString(grantee, `grantees[${i}]`);
    });
    validateScope(input.scope);
    checkExpiry(input.expiresAt, now);
    if (!u64(input.maxDelegationDepth) || input.maxDelegationDepth > LIMITS.maxDelegationDepth) {
        throw invalidShape("maxDelegationDepth exceeds MAX_DELEGATION_DEPTH");
    }
};

export const validateDelegationInput = (input: CreateDelegationInput, now: number): void => {
    for (const field of ["grantId", "parentId", "delegatorDid", "delegateeDid"] as const) {
        if (typeof input[field] === "string") checkString(input[field], field);
    }
    validateScope(input.scope);
    checkExpiry(input.expiresAt, now);
};
