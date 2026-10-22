// Unit tests for the parts of the SDK that don't touch the network.
// `npm test` builds first.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    AuthorityError, ErrorCode, LIMITS, attenuationEscalation, buildId, entryEscalation, isNarrower, parseId,
    resolveAuthority, routeOf, validateDelegationInput, validateGrantInput, didOf, homeOf, isMoiDid,
} from "../dist/index.js";
import { fromWireScope, toWireScope } from "../dist/codec.js";

const PRIYA = "ab".repeat(32);
const PLANNER = "cd".repeat(32);
const WORKER = "ef".repeat(32);
const NOW = 1_800_000_000;
const FAR = NOW + 86_400;

const apScope = () => [
    { resource: "erp", actions: ["lookup_vendor", "get_purchase_order"], constraints: {} },
    {
        resource: "payments", actions: ["schedule_payment"],
        constraints: { max_payment_minor: { kind: "number", value: 1_000_000 }, allowed_vendors: { kind: "strings", value: ["acme-corp", "initech"] } },
    },
    {
        resource: "reports", actions: ["read"],
        constraints: {
            region: { kind: "string", value: "eu" }, redact: { kind: "boolean", value: true },
            policy: { kind: "ref", value: "policy:v1" }, days: { kind: "numbers", value: [1, 2, 3] },
        },
    },
];
const payments = (max = 500_000, vendors = ["acme-corp"], extra = {}) => ({
    resource: "payments", actions: ["schedule_payment"],
    constraints: { max_payment_minor: { kind: "number", value: max }, allowed_vendors: { kind: "strings", value: vendors }, ...extra },
});

const codeOf = (fn) => {
    try {
        fn();
    } catch (error) {
        assert.ok(error instanceof AuthorityError, `expected AuthorityError, got ${error}`);
        return error;
    }
    assert.fail("expected an error");
};

describe("ids (§2.2)", () => {
    test("build and parse round-trip", () => {
        const id = buildId("grant", `0x${PRIYA}`, 14);
        assert.equal(id, `grt_${PRIYA}_14`);
        const parsed = parseId(id);
        assert.equal(parsed.kind, "grant");
        assert.equal(parsed.seq, 14);
        assert.equal(parsed.route.lookupKey, `0x${PRIYA}`);
        assert.equal(routeOf(buildId("delegation", PLANNER, 3)), `0x${PLANNER}`);
    });

    test("reject anything that isn't exactly an id", () => {
        for (const bad of ["", "garbage", `grt_${PRIYA}_0`, `grt_${PRIYA}_01`, `grt_${PRIYA.toUpperCase()}_1`, `grt_0x${PRIYA}_1`, `xyz_${PRIYA}_1`, `grt_${PRIYA.slice(2)}_1`]) {
            assert.equal(codeOf(() => parseId(bad)).code, ErrorCode.INVALID_ARGUMENT, bad);
        }
    });
});

describe("shape (§3.3 client step a)", () => {
    const grant = (overrides = {}) => ({
        context: "ap-processing", grantorDid: "did:priya", grantees: ["did:planner"], scope: apScope(),
        maxDelegationDepth: 2, expiresAt: FAR, ...overrides,
    });

    test("accepts a valid grant and one at every §2.8 limit", () => {
        validateGrantInput(grant(), NOW);
        validateGrantInput(grant({
            context: "é".repeat(128),
            scope: [{ resource: "r".repeat(256), actions: ["a".repeat(256)], constraints: { k: { kind: "strings", value: Array.from({ length: 60 }, () => "v".repeat(256)) } } }],
        }), NOW);
        validateGrantInput(grant({
            grantees: Array.from({ length: LIMITS.maxGrantees }, (_, i) => `did:g${i}`),
            maxDelegationDepth: LIMITS.maxDelegationDepth,
            scope: Array.from({ length: LIMITS.maxScopeEntries }, (_, i) => ({ resource: `r${i}`, actions: ["a"], constraints: {} })),
        }), NOW);
    });

    const cases = {
        "an empty context": [{ context: "" }, "context is empty"],
        "no grantees": [{ grantees: [] }, "grantees is empty"],
        "duplicate grantees": [{ grantees: ["did:a", "did:a"] }, "grantees[1] is a duplicate"],
        "too many grantees": [{ grantees: Array.from({ length: 33 }, (_, i) => `did:${i}`) }, "grantees exceeds MAX_GRANTEES"],
        "an empty scope": [{ scope: [] }, "scope is empty"],
        "too many entries": [{ scope: Array.from({ length: 65 }, (_, i) => ({ resource: `r${i}`, actions: ["a"], constraints: {} })) }, "scope exceeds MAX_SCOPE_ENTRIES"],
        "an empty resource": [{ scope: [{ resource: "", actions: ["a"], constraints: {} }] }, "scope[0].resource is empty"],
        "an entry without actions": [{ scope: [{ resource: "r", actions: [], constraints: {} }] }, "scope[0].actions is empty"],
        "too many actions": [{ scope: [{ resource: "r", actions: Array.from({ length: 65 }, (_, i) => `a${i}`), constraints: {} }] }, "scope[0].actions exceeds MAX_ACTIONS_PER_ENTRY"],
        "too many constraints": [{ scope: [{ resource: "r", actions: ["a"], constraints: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, { kind: "number", value: 1 }])) }] }, "scope[0].constraints exceeds MAX_CONSTRAINTS_PER_ENTRY"],
        "an unknown kind": [{ scope: [{ resource: "r", actions: ["a"], constraints: { k: { kind: "date", value: 1 } } }] }, "scope[0].constraints has an invalid key or kind"],
        "a badly typed value": [{ scope: [{ resource: "r", actions: ["a"], constraints: { k: { kind: "number", value: "1" } } }] }, "scope[0].constraints.k is not well-typed"],
        "a negative number": [{ scope: [{ resource: "r", actions: ["a"], constraints: { k: { kind: "number", value: -1 } } }] }, "scope[0].constraints.k is not well-typed"],
        "a repeated (resource, action) pair": [{ scope: [{ resource: "erp", actions: ["a", "b"], constraints: {} }, { resource: "erp", actions: ["c", "a"], constraints: {} }] }, "scope[1] repeats (erp, a)"],
        "an expiry of now": [{ expiresAt: NOW }, "expiresAt is not in the future"],
        "max depth over 16": [{ maxDelegationDepth: 17 }, "maxDelegationDepth exceeds MAX_DELEGATION_DEPTH"],
        // Size bounds (§2.8), in UTF-8 bytes.
        "a 257-byte context": [{ context: "c".repeat(257) }, "context exceeds MAX_STRING_BYTES"],
        "a context of 129 two-byte characters": [{ context: "é".repeat(129) }, "context exceeds MAX_STRING_BYTES"],
        "a 257-byte grantor DID": [{ grantorDid: "d".repeat(257) }, "grantorDid exceeds MAX_STRING_BYTES"],
        "a 257-byte grantee": [{ grantees: ["did:a", "g".repeat(257)] }, "grantees[1] exceeds MAX_STRING_BYTES"],
        "a 257-byte resource": [{ scope: [{ resource: "r".repeat(257), actions: ["a"], constraints: {} }] }, "scope[0].resource exceeds MAX_STRING_BYTES"],
        "a 257-byte action": [{ scope: [{ resource: "r", actions: ["a", "x".repeat(257)], constraints: {} }] }, "scope[0].actions[1] exceeds MAX_STRING_BYTES"],
        "a 257-byte constraint key": [{ scope: [{ resource: "r", actions: ["a"], constraints: { ["k".repeat(257)]: { kind: "number", value: 1 } } }] }, "scope[0].constraints key exceeds MAX_STRING_BYTES"],
        "a 257-byte string value": [{ scope: [{ resource: "r", actions: ["a"], constraints: { k: { kind: "string", value: "v".repeat(257) } } }] }, "scope[0].constraints.k exceeds MAX_STRING_BYTES"],
        "a 257-byte list value": [{ scope: [{ resource: "r", actions: ["a"], constraints: { k: { kind: "strings", value: ["ok", "v".repeat(257)] } } }] }, "scope[0].constraints.k exceeds MAX_STRING_BYTES"],
        "a list of 65 strings": [{ scope: [{ resource: "r", actions: ["a"], constraints: { k: { kind: "strings", value: Array.from({ length: 65 }, (_, i) => `v${i}`) } } }] }, "scope[0].constraints.k exceeds MAX_LIST_VALUES"],
        "a list of 65 numbers": [{ scope: [{ resource: "r", actions: ["a"], constraints: { k: { kind: "numbers", value: Array.from({ length: 65 }, (_, i) => i) } } }] }, "scope[0].constraints.k exceeds MAX_LIST_VALUES"],
        "a scope over 16 KB (4 lists of 64 values of 256 bytes)": [{ scope: [{ resource: "r", actions: ["a"], constraints: Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`k${i}`, { kind: "strings", value: Array.from({ length: 64 }, () => "v".repeat(256)) }])) }] }, "scope exceeds MAX_SCOPE_BYTES"],
    };
    for (const [label, [overrides, message]] of Object.entries(cases)) {
        test(`rejects ${label}, with the registry's message`, () => {
            const error = codeOf(() => validateGrantInput(grant(overrides), NOW));
            assert.equal(error.code, ErrorCode.INVALID_SHAPE);
            assert.equal(error.message, `INVALID_SHAPE: ${message}`);
        });
    }

    test("delegations: an empty scope and a past expiry", () => {
        const base = { grantId: `grt_${PRIYA}_1`, parentId: `grt_${PRIYA}_1`, delegatorDid: "did:a", delegateeDid: "did:b", scope: [payments()], expiresAt: FAR };
        validateDelegationInput(base, NOW);
        assert.equal(codeOf(() => validateDelegationInput({ ...base, scope: [] }, NOW)).code, ErrorCode.INVALID_SHAPE);
        assert.equal(codeOf(() => validateDelegationInput({ ...base, expiresAt: NOW - 1 }, NOW)).code, ErrorCode.INVALID_SHAPE);
    });
});

describe("attenuation (§3.4)", () => {
    const escalation = (child, expiry = FAR) => attenuationEscalation(child, expiry, apScope(), FAR);

    const rejected = {
        "an added action": [[{ ...payments(), actions: ["schedule_payment", "refund"] }], "scope[0] actions"],
        "a different resource": [[{ ...payments(), resource: "payment" }], "scope[0] resource"],
        "a dropped key": [[{ resource: "payments", actions: ["schedule_payment"], constraints: { max_payment_minor: { kind: "number", value: 1 } } }], "scope[0] constraint allowed_vendors dropped"],
        "a ceiling loosened by 1": [[payments(1_000_001)], "scope[0] constraint max_payment_minor"],
        "an extra list value": [[payments(1, ["acme-corp", "globex"])], "scope[0] constraint allowed_vendors"],
        "a kind mismatch": [[payments(1, ["acme-corp"], { max_payment_minor: { kind: "string", value: "1" } })], "scope[0] constraint max_payment_minor"],
        "a changed ref": [[{ ...apScope()[2], constraints: { ...apScope()[2].constraints, policy: { kind: "ref", value: "policy:v2" } } }], "scope[0] constraint policy"],
        "two parent entries welded": [[{ resource: "payments", actions: ["schedule_payment", "lookup_vendor"], constraints: payments().constraints }], "scope[0] actions"],
        "an expiry one second late": [[payments()], "expiresAt", FAR + 1],
    };
    for (const [label, [child, expected, expiry]] of Object.entries(rejected)) {
        test(`rejects ${label}`, () => assert.equal(escalation(child, expiry), expected));
    }

    test("names the failing entry", () => {
        assert.equal(escalation([{ resource: "erp", actions: ["lookup_vendor"], constraints: {} }, payments(2_000_000)]), "scope[1] constraint max_payment_minor");
    });

    test("accepts equal scopes, lower ceilings, subsets and added keys", () => {
        assert.ok(isNarrower(apScope(), FAR, apScope(), FAR));
        assert.ok(isNarrower([payments(999_999, ["initech"])], FAR, apScope(), FAR));
        assert.ok(isNarrower([payments(1, [], { memo: { kind: "boolean", value: true } })], FAR, apScope(), FAR));
        assert.equal(entryEscalation(payments(), apScope()[1]), "");
    });
});

describe("local resolver (§3.7)", () => {
    const G = `grt_${PRIYA}_1`;
    const D1 = `del_${PLANNER}_1`;
    const D2 = `del_${WORKER}_1`;
    const grant = (overrides = {}) => ({
        version: 1, grantId: G, context: "ap", grantorDid: "did:priya", grantees: ["did:planner"], scope: apScope(),
        maxDelegationDepth: 2, createdAt: NOW - 10, expiresAt: FAR, status: "active", revokedAt: null, ...overrides,
    });
    const link = (id, parentId, depth, delegator, delegatee, overrides = {}) => ({
        version: 1, delegationId: id, grantId: G, parentId, depth, delegatorDid: delegator, delegateeDid: delegatee,
        scope: [payments()], canDelegate: true, createdAt: NOW - 5, expiresAt: FAR, status: "active", revokedAt: null, ...overrides,
    });
    const source = (records) => ({
        getGrant: async (id) => records[id] ?? null,
        getDelegation: async (id) => records[id] ?? null,
    });
    const chain = (overrides = {}) => source({
        [G]: grant(overrides.grant),
        [D1]: link(D1, G, 1, "did:planner", "did:worker", overrides.d1),
        [D2]: link(D2, D1, 2, "did:worker", "did:sub", { scope: [payments(100)], ...overrides.d2 }),
    });
    const rejects = (promise, code) => assert.rejects(promise, (error) => error.code === code);

    test("resolves a grant and a two-hop chain", async () => {
        assert.deepEqual((await resolveAuthority(G, NOW, chain())).actorBinding, ["did:planner"]);
        const authority = await resolveAuthority(D2, NOW, chain());
        assert.deepEqual(authority, {
            grantId: G, context: "ap", grantorDid: "did:priya", actorBinding: ["did:sub"], scope: [payments(100)],
            maxDelegationDepth: 2, expiresAt: FAR, chain: [D2, D1, G],
        });
    });

    test("liveness: revoked, expired (exclusive) and unknown version", async () => {
        await rejects(resolveAuthority(D2, NOW, chain({ d1: { status: "revoked" } })), ErrorCode.DELEGATION_REVOKED);
        await rejects(resolveAuthority(D2, NOW, chain({ grant: { status: "revoked" } })), ErrorCode.GRANT_REVOKED);
        await rejects(resolveAuthority(D2, FAR, chain()), ErrorCode.DELEGATION_EXPIRED);
        assert.ok(await resolveAuthority(D2, FAR - 1, chain()));
        await rejects(resolveAuthority(G, NOW, chain({ grant: { version: 2 } })), ErrorCode.UNSUPPORTED_VERSION);
    });

    test("unknown refs", async () => {
        await rejects(resolveAuthority(`grt_${PRIYA}_9`, NOW, chain()), ErrorCode.UNKNOWN_GRANT);
        await rejects(resolveAuthority(`del_${PRIYA}_9`, NOW, chain()), ErrorCode.UNKNOWN_DELEGATION);
    });

    // Part VII: planted records. The registry stores what it is sent
    // (§3.3), so these can exist on chain; none may resolve.
    const planted = {
        "a parent that may not delegate": { d1: { canDelegate: false } },
        "a skipped depth": { d2: { depth: 3 } },
        "a delegator that isn't the parent's delegatee": { d2: { delegatorDid: "did:mallory" } },
        "a link spliced from another tree": { d2: { grantId: `grt_${PRIYA}_2` } },
        "a first delegator who isn't a grantee": { d1: { delegatorDid: "did:mallory" } },
        "a widened scope": { d2: { scope: [payments(900_000)] } },
        "a child outliving its parent": { d1: { expiresAt: FAR - 10 } },
        "a chain deeper than the grant allows": { grant: { maxDelegationDepth: 1 } },
        "a missing parent": { d2: { parentId: `del_${PLANNER}_9` } },
        "a source returning a different record than asked for": { d1: { delegationId: `del_${PLANNER}_2` } },
        "a depth of 0": { d1: { depth: 0 } },
        "a depth past the §2.8 limit": { d2: { depth: 17 } },
        "a link with an empty scope": { d2: { scope: [] } },
        "a link with an empty action list": { d2: { scope: [{ ...payments(100), actions: [] }] } },
        "a link repeating a (resource, action) pair": { d2: { scope: [payments(100), payments(50)] } },
        "a link with an ill-typed constraint": { d2: { scope: [payments(100, ["acme-corp"], { cap: { kind: "number", value: -1 } })] } },
        "a root with no grantees": { grant: { grantees: [] } },
        "a root with duplicate grantees": { grant: { grantees: ["did:planner", "did:planner"] } },
        "a root with an empty context": { grant: { context: "" } },
        "a root with an oversized context": { grant: { context: "c".repeat(257) } },
        "a link with an oversized delegatee": { d2: { delegateeDid: "d".repeat(257) } },
        "a root over MAX_SCOPE_BYTES": { grant: { scope: [...apScope(), { resource: "big", actions: ["a"], constraints: { k: { kind: "strings", value: Array.from({ length: 64 }, (_, i) => `${i}`.padEnd(256, "v")) }, l: { kind: "strings", value: Array.from({ length: 64 }, (_, i) => `${i}`.padEnd(256, "w")) } } }] } },
    };
    for (const [label, overrides] of Object.entries(planted)) {
        test(`BROKEN_CHAIN for ${label}`, () => rejects(resolveAuthority(D2, NOW, chain(overrides)), ErrorCode.BROKEN_CHAIN));
    }

    test("BROKEN_CHAIN for a malformed grant resolved directly", () => rejects(resolveAuthority(G, NOW, chain({ grant: { scope: [] } })), ErrorCode.BROKEN_CHAIN));

    test("BROKEN_CHAIN when the source can't decode a stored record", async () => {
        const broken = { ...chain(), getDelegation: async () => fromWireDelegationScope([{ ...wire(), kind: 9 }]) };
        await rejects(resolveAuthority(D2, NOW, broken), ErrorCode.BROKEN_CHAIN);
    });
});

const wire = () => ({ key: "max", kind: 2, text: "", number: 5, flag: false, texts: [], numbers: [] });
const fromWireDelegationScope = (constraints) => fromWireScope([{ resource: "r", actions: ["a"], constraints }]);

describe("codec", () => {
    test("scope round-trips through the wire form", () => {
        assert.deepEqual(fromWireScope(toWireScope(apScope())), apScope());
    });

    test("a stored scope is decoded strictly (§3.7)", () => {
        const cases = {
            "an unknown kind": [{ ...wire(), kind: 9 }],
            "an empty key": [{ ...wire(), key: "" }],
            "a field outside its kind": [{ ...wire(), text: "x" }],
            "a repeated key": [wire(), { ...wire(), number: 9 }],
        };
        for (const [label, constraints] of Object.entries(cases)) {
            assert.equal(codeOf(() => fromWireDelegationScope(constraints)).code, ErrorCode.INVALID_SHAPE, label);
        }
    });
});

describe("did:moi (MoiIdentity)", () => {
    test("an account's DID, and back", () => {
        assert.equal(didOf(`0x${PRIYA.toUpperCase()}`), `did:moi:${PRIYA}`);
        assert.equal(homeOf(`did:moi:${PRIYA.toUpperCase()}`), `0x${PRIYA}`);
        assert.ok(isMoiDid(`did:moi:${PRIYA}`));
    });

    test("anything else isn't a did:moi DID", () => {
        for (const bad of ["did:priya", `did:moi:0x${PRIYA}`, `did:moi:${PRIYA.slice(2)}`, `did:moi:${"z".repeat(64)}`, `did:moi:${PRIYA}x`]) {
            assert.equal(isMoiDid(bad), false, bad);
            assert.equal(codeOf(() => homeOf(bad)).code, ErrorCode.INVALID_ARGUMENT, bad);
        }
        assert.equal(codeOf(() => didOf("0x1234")).code, ErrorCode.INVALID_ARGUMENT);
    });
});

describe("default logic ids", () => {
    const load = (env) => {
        const script = 'import("../dist/index.js").then((m) => console.log(JSON.stringify([m.REGISTRY_LOGIC_ID, m.IDENTITY_LOGIC_ID])))';
        const { MOI_AUTHORITY_REGISTRY_LOGIC_ID: _r, MOI_IDENTITY_LOGIC_ID: _i, ...base } = process.env;
        const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL(".", import.meta.url), env: { ...base, ...env } });
        return JSON.parse(String(out));
    };

    test("the devnet deployment, unless the environment says otherwise", () => {
        assert.deepEqual(load({}), [
            "0x20000000da714779e4a5a3e9aad5e280ce90a026757ef8ca0c2a8d2400000000",
            "0x20000000928c74bb345d4bdc726dfe22ed485742c6640a9df86d71b300000000",
        ]);
    });

    test("MOI_AUTHORITY_REGISTRY_LOGIC_ID and MOI_IDENTITY_LOGIC_ID override them", () => {
        assert.deepEqual(load({ MOI_AUTHORITY_REGISTRY_LOGIC_ID: "0xaa", MOI_IDENTITY_LOGIC_ID: "0xbb" }), ["0xaa", "0xbb"]);
    });
});
