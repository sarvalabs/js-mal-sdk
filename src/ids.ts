// mal.md §2.2. Ids are self-routing: the owner segment says whose state holds
// the record. They are never proof. The parser hands back the owner only as a
// `Route`, a lookup key, so nothing can mistake it for an authenticated claim.

import { invalidArgument } from "./errors.js";
import type { DelegationId, GrantId, Hex } from "./types.js";

const ID = /^(grt|del)_([0-9a-f]{64})_([1-9]\d*)$/;

declare const ROUTE: unique symbol;

/** Where a record lives. Usable to look the record up, and for nothing else. */
export type Route = { readonly lookupKey: Hex; readonly [ROUTE]: true };

export interface ParsedId {
    kind: "grant" | "delegation";
    route: Route;
    seq: number;
}

/** Builds an id from the account that writes the record and its sequence number. */
export const buildId = (kind: "grant" | "delegation", owner: string, seq: number): GrantId | DelegationId => {
    const hex = owner.toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{64}$/.test(hex)) throw invalidArgument(`not an account address: ${owner}`);
    if (!Number.isSafeInteger(seq) || seq < 1) throw invalidArgument(`invalid sequence number: ${seq}`);
    return `${kind === "grant" ? "grt" : "del"}_${hex}_${seq}`;
};

/** Parses an id. Throws INVALID_ARGUMENT unless it is exactly a §2.2 id. */
export const parseId = (id: string): ParsedId => {
    const match = ID.exec(id);
    if (!match) throw invalidArgument(`not a grant or delegation id: ${id}`);
    return {
        kind: match[1] === "grt" ? "grant" : "delegation",
        route: { lookupKey: `0x${match[2]}` } as Route,
        seq: Number(match[3]),
    };
};

export const isGrantId = (id: string): id is GrantId => ID.test(id) && id.startsWith("grt_");
export const isDelegationId = (id: string): id is DelegationId => ID.test(id) && id.startsWith("del_");

/** The account whose state holds the record; a lookup key only. */
export const routeOf = (id: string): Hex => parseId(id).route.lookupKey;
