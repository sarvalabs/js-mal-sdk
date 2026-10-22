// mal.md §3.4, exactly as the registry checks it. Every child entry must be
// dominated by a single parent entry: same resource, a subset of actions,
// every parent constraint key kept and none loosened. A child may add keys.

import type { ConstraintValue, ScopeEntry } from "./types.js";

/** Per kind: numbers are ceilings, lists narrow to subsets, the rest stay equal. */
export const constraintWithin = (child: ConstraintValue, parent: ConstraintValue): boolean => {
    if (child.kind !== parent.kind) return false;
    switch (child.kind) {
        case "number": return child.value <= (parent.value as number);
        case "strings": return child.value.every((v) => (parent.value as string[]).includes(v));
        case "numbers": return child.value.every((v) => (parent.value as number[]).includes(v));
        default: return child.value === parent.value;
    }
};

/** The dimension in which `child` isn't dominated by `parent`, or "" when it is. */
export const entryEscalation = (child: ScopeEntry, parent: ScopeEntry): string => {
    if (child.resource !== parent.resource) return "resource";
    if (!child.actions.every((action) => parent.actions.includes(action))) return "actions";
    for (const [key, required] of Object.entries(parent.constraints ?? {})) {
        const value = child.constraints?.[key];
        if (!value) return `constraint ${key} dropped`;
        if (!constraintWithin(value, required)) return `constraint ${key}`;
    }
    return "";
};

/**
 * `assertAttenuation` of §3.4. Returns null when `child` narrows `parent`,
 * otherwise "expiresAt" or "scope[i] <dimension>", as the registry reports
 * it in SCOPE_ESCALATION.
 */
export const attenuationEscalation = (child: ScopeEntry[], childExpiry: number, parent: ScopeEntry[], parentExpiry: number): string | null => {
    if (childExpiry > parentExpiry) return "expiresAt";
    for (const [i, entry] of child.entries()) {
        let reason = "resource";
        let dominated = false;
        for (const candidate of parent) {
            const dimension = entryEscalation(entry, candidate);
            if (dimension === "") {
                dominated = true;
                break;
            }
            if (candidate.resource === entry.resource) reason = dimension;
        }
        if (!dominated) return `scope[${i}] ${reason}`;
    }
    return null;
};

export const isNarrower = (child: ScopeEntry[], childExpiry: number, parent: ScopeEntry[], parentExpiry: number): boolean =>
    attenuationEscalation(child, childExpiry, parent, parentExpiry) === null;
