// AuthorityRegistry's event reading, watching and record verification against
// a scripted network. The logs are real ones, recorded from a devnet registry
// (test/fixtures/registry-logs.json).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AuthorityError, AuthorityRegistry, ErrorCode } from "../dist/index.js";

const { logicId, logs } = JSON.parse(readFileSync(new URL("./fixtures/registry-logs.json", import.meta.url), "utf8"));
const heightOf = (log) => Number(log.participants.find((p) => p.id.toLowerCase() === logicId).height);
const HEAD = Math.max(...logs.map(heightOf));
const IDENTITY = `0x20000000${"ee".repeat(24)}00000000`;

/** A network serving the recorded logs. getLogs behaves as a MOI node: inclusive ranges, at most 10 heights apart. */
const network = ({ failLogs = 0, failReads = false } = {}) => {
    const queries = [];
    const provider = {
        getAccountMetaInfo: async () => ({ height: HEAD }),
        getLogs: async ({ height: [from, to] }) => {
            queries.push([from, to]);
            if (failLogs > 0) {
                failLogs--;
                throw new Error("connection reset");
            }
            if (to - from > 10 || to < from) throw new Error("Invalid query range");
            return logs.filter((log) => heightOf(log) >= from && heightOf(log) <= to);
        },
    };
    const read = (kind) => () => ({
        call: async () => ({
            receipt: {},
            result: async () => {
                if (failReads) throw new Error("socket hang up");
                return { output: { found: false, [kind]: null }, error: null };
            },
        }),
    });
    const driver = { routines: { GetGrant: read("grant"), GetDelegation: read("delegation") } };
    const signer = { getProvider: () => provider, getIdentifier: async () => ({ toHex: () => `0x00000000${"bb".repeat(24)}00000000` }) };
    // The constructor is private to TypeScript; connect() needs a live node.
    const registry = new AuthorityRegistry(logicId, IDENTITY, driver, signer, {});
    return { registry, queries };
};

const collect = async (iterable) => {
    const out = [];
    for await (const item of iterable) out.push(item);
    return out;
};
const key = (event) => `${event.height}:${event.tsHash}`;
const until = async (condition, ms = 3000) => {
    for (const deadline = Date.now() + ms; !condition(); ) {
        if (Date.now() > deadline) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 5));
    }
};

describe("events", () => {
    test("every log in a range exactly once, in order, in windows the node accepts", async () => {
        const { registry, queries } = network();
        const events = await collect(registry.events({ fromHeight: 0, toHeight: HEAD }));
        assert.equal(events.length, logs.length);
        assert.equal(new Set(events.map(key)).size, events.length);
        assert.deepEqual(events.map((e) => e.height), [...events.map((e) => e.height)].sort((a, b) => a - b));
        for (const [from, to] of queries) assert.ok(to - from < 10 && to >= from, `${from}..${to}`);
        assert.equal(queries[0][0], 0);
        assert.equal(queries.at(-1)[1], HEAD);
    });

    test("a window boundary isn't read twice", async () => {
        const { registry } = network();
        const a = await collect(registry.events({ fromHeight: 0, toHeight: 9 }));
        const b = await collect(registry.events({ fromHeight: 10, toHeight: HEAD }));
        assert.equal(a.length + b.length, logs.length);
    });

    test("a failed log query is an error, never an empty range", async () => {
        const { registry } = network({ failLogs: 1 });
        await assert.rejects(collect(registry.events({ fromHeight: 0, toHeight: HEAD })), (error) => error instanceof AuthorityError && error.code === ErrorCode.NETWORK_ERROR);
    });

    test("bad heights are refused", async () => {
        const { registry } = network();
        await assert.rejects(collect(registry.events({ fromHeight: -1 })), (error) => error.code === ErrorCode.INVALID_ARGUMENT);
        await assert.rejects(collect(registry.events({ fromHeight: 0, toHeight: 1.5 })), (error) => error.code === ErrorCode.INVALID_ARGUMENT);
    });
});

describe("watch", () => {
    test("delivers every event once, and survives a network failure", async () => {
        const { registry } = network({ failLogs: 1 });
        const seen = [];
        const errors = [];
        const stop = registry.watch((event) => void seen.push(key(event)), { fromHeight: 0, intervalMs: 5, onError: (e) => errors.push(e) });
        await until(() => seen.length >= logs.length);
        stop();
        assert.equal(errors.length, 1);
        assert.equal(errors[0].code, ErrorCode.NETWORK_ERROR);
        assert.equal(new Set(seen).size, logs.length);
        assert.equal(seen.length, logs.length);
    });

    test("an event whose handler throws is delivered again, and nothing after it is skipped", async () => {
        const { registry } = network();
        const seen = [];
        const errors = [];
        let failed = false;
        const target = logs.length >> 1;
        const stop = registry.watch((event) => {
            if (seen.length === target && !failed) {
                failed = true;
                throw new Error("database down");
            }
            seen.push(key(event));
        }, { fromHeight: 0, intervalMs: 5, onError: (e) => errors.push(e) });
        await until(() => new Set(seen).size >= logs.length);
        stop();
        assert.equal(errors.length, 1);
        assert.match(errors[0].message, /database down/);
        assert.equal(new Set(seen).size, logs.length);
    });

    test("an onError that throws doesn't end the watch", async () => {
        const { registry } = network({ failLogs: 2 });
        const seen = [];
        const stop = registry.watch((event) => void seen.push(key(event)), { fromHeight: 0, intervalMs: 5, onError: () => { throw new Error("bad logger"); } });
        await until(() => seen.length >= logs.length);
        stop();
    });
});

describe("verifyRecord", () => {
    test("a network failure is thrown, not taken as an invalid record", async () => {
        const { registry } = network({ failReads: true });
        await assert.rejects(registry.verifyRecord(`grt_${"ab".repeat(32)}_1`), (error) => error.code === ErrorCode.NETWORK_ERROR);
    });

    test("a record that doesn't exist is not valid", async () => {
        const { registry } = network();
        assert.equal(await registry.verifyRecord(`grt_${"ab".repeat(32)}_1`), false);
    });

    test("a verified event stream fails rather than dropping events when it can't check them", async () => {
        const { registry } = network({ failReads: true });
        await assert.rejects(collect(registry.events({ fromHeight: 0, toHeight: HEAD, verified: true })), (error) => error.code === ErrorCode.NETWORK_ERROR);
    });
});
