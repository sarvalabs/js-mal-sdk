// Transport against a scripted network: each fake routine returns the
// simulation and send results a test sets up, and records what was sent.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Polorizer } from "js-polo";
import { LockType, Schema } from "js-moi-sdk";
import { Transport } from "../dist/transport.js";
import { ErrorCode } from "../dist/index.js";

const LOGIC = `0x20000000${"aa".repeat(24)}00000000`;
const SENDER = `0x00000000${"bb".repeat(24)}00000000`;
const OTHER = `0x00000000${"cc".repeat(24)}00000000`;
const THIRD = `0x00000000${"dd".repeat(24)}00000000`;

const exception = (error, cls = "string") => {
    const polorizer = new Polorizer();
    polorizer.polorize({ class: cls, error, revert: false, trace: [] }, Schema.PISA_EXCEPTION_SCHEMA);
    return `0x${Buffer.from(polorizer.bytes()).toString("hex")}`;
};
const receipt = ({ error, status = 0, fuel = 40_000 } = {}) => ({
    ix_hash: "0x01", ts_hash: "0x02", status, fuel_used: `0x${fuel.toString(16)}`,
    ix_operations: [{ status: error ? 1 : 0, data: { outputs: "0x", error: error ? exception(error) : "0x" } }],
});

/** A network that answers each simulation and send from the scripts given. */
const network = ({ simulations = [receipt()], sends = [receipt()], output = { ok: true } } = {}) => {
    const log = { calls: [], sends: [] };
    const next = (list) => (list.length > 1 ? list.shift() : list[0]);
    const routine = (...args) => ({
        call: async (option) => {
            log.calls.push({ args, option });
            const r = next(simulations);
            return { receipt: r, result: async () => ({ output, error: null }) };
        },
        send: async (option) => {
            log.sends.push({ args, option });
            const r = next(sends);
            return { hash: `0x${log.sends.length}`, wait: async () => r, result: async () => ({ output, error: null }) };
        },
    });
    const driver = { routines: { Do: routine } };
    const signer = {
        getIdentifier: async () => ({ toHex: () => SENDER }),
    };
    return { transport: new Transport(driver, signer, LOGIC, { retries: 2 }), log };
};

const rejectsWith = (promise, code, message) => assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
});

describe("participants", () => {
    test("leave out the sender and the logic; writes outrank reads; ids are deduplicated", async () => {
        const { transport } = network();
        const list = await transport.participants({
            read: [SENDER, LOGIC, OTHER, OTHER.toUpperCase().replace("0X", "0x"), THIRD],
            write: [THIRD],
        });
        assert.deepEqual(list, [
            { id: OTHER, lock_type: LockType.READ_LOCK },
            { id: THIRD, lock_type: LockType.MUTATE_LOCK },
        ]);
    });
});

describe("send", () => {
    test("sizes fuel from the simulation", async () => {
        const { transport, log } = network({ simulations: [receipt({ fuel: 40_000 })] });
        await transport.send("Do", [1]);
        assert.equal(log.sends[0].option.fuel_limit, Math.ceil(40_000 * 1.5) + 10_000);
        assert.equal(log.sends[0].option.fuel_price, 50);
    });

    test("a registry error in simulation is thrown and nothing is sent", async () => {
        const { transport, log } = network({ simulations: [receipt({ error: "NOT_HOLDER" })] });
        await rejectsWith(transport.send("Do", []), ErrorCode.NOT_HOLDER);
        assert.equal(log.sends.length, 0);
    });

    test("the error keeps the registry's detail", async () => {
        const { transport } = network({ simulations: [receipt({ error: "SCOPE_ESCALATION: scope[1] constraint max" })] });
        await rejectsWith(transport.send("Do", []), ErrorCode.SCOPE_ESCALATION, /^SCOPE_ESCALATION: scope\[1\] constraint max$/);
    });

    test("a simulation over the network's cap is sent at maxFuel", async () => {
        const { transport, log } = network({ simulations: [receipt({ error: "meter exhausted", fuel: 100_000 })] });
        await transport.send("Do", []);
        assert.equal(log.sends[0].option.fuel_limit, 5_000_000);
    });

    test("an error in the receipt is thrown with its code", async () => {
        const { transport } = network({ sends: [receipt({ error: "ALREADY_REVOKED" })] });
        await rejectsWith(transport.send("Do", []), ErrorCode.ALREADY_REVOKED);
    });

    test("discarded state changes raise STATE_REVERTED", async () => {
        const { transport } = network({ sends: [receipt({ status: 1 })] });
        await rejectsWith(transport.send("Do", []), ErrorCode.STATE_REVERTED, /discarded its state changes/);
    });

    test("a lock conflict is retried until it succeeds", async () => {
        const conflict = receipt({ error: "missing signature of extern origin actor", status: 1 });
        const { transport, log } = network({ sends: [conflict, conflict, receipt()] });
        const result = await transport.send("Do", []);
        assert.equal(log.sends.length, 3);
        assert.equal(result.hash, "0x3");
    });

    test("a lock conflict that persists is thrown after the retries", async () => {
        const conflict = receipt({ error: "missing signature of extern origin actor", status: 1 });
        const { transport, log } = network({ sends: [conflict] });
        await rejectsWith(transport.send("Do", []), ErrorCode.NETWORK_ERROR, /missing signature/);
        assert.equal(log.sends.length, 3);
    });

    test("other errors are not retried", async () => {
        const { transport, log } = network({ sends: [receipt({ error: "NOT_HOLDER" })] });
        await rejectsWith(transport.send("Do", []), ErrorCode.NOT_HOLDER);
        assert.equal(log.sends.length, 1);
    });

    test("participants are passed to both the simulation and the send", async () => {
        const { transport, log } = network();
        await transport.send("Do", [], { read: [OTHER], write: [THIRD] });
        const expected = [{ id: OTHER, lock_type: LockType.READ_LOCK }, { id: THIRD, lock_type: LockType.MUTATE_LOCK }];
        assert.deepEqual(log.calls[0].option.participants, expected);
        assert.deepEqual(log.sends[0].option.participants, expected);
    });
});

describe("call", () => {
    test("returns outputs, and throws registry errors", async () => {
        const { transport } = network({ output: { found: true } });
        assert.deepEqual(await transport.call("Do", []), { found: true });
    });
});

describe("submission", () => {
    test("one account's submissions go one at a time, so each gets its own sequence", async () => {
        const { transport, log } = network();
        let inFlight = 0, most = 0;
        const send = transport.driver.routines.Do;
        transport.driver.routines.Do = (...args) => {
            const routine = send(...args);
            return { ...routine, send: async (option) => {
                inFlight++;
                most = Math.max(most, inFlight);
                await new Promise((r) => setTimeout(r, 20));
                inFlight--;
                return routine.send(option);
            } };
        };
        await Promise.all([transport.send("Do", []), transport.send("Do", []), transport.send("Do", [])]);
        assert.equal(log.sends.length, 3);
        assert.equal(most, 1);
    });

    test("a failed submission doesn't block the next one", async () => {
        const { transport, log } = network();
        const send = transport.driver.routines.Do;
        let first = true;
        transport.driver.routines.Do = (...args) => {
            const routine = send(...args);
            return { ...routine, send: async (option) => {
                if (first) { first = false; throw new Error("connection reset"); }
                return routine.send(option);
            } };
        };
        await rejectsWith(transport.send("Do", []), ErrorCode.NETWORK_ERROR, /connection reset/);
        await transport.send("Do", []);
        assert.equal(log.sends.length, 1);
    });

    test("a receipt timeout is an AuthorityError that keeps the interaction hash", async () => {
        const { transport } = network();
        const send = transport.driver.routines.Do;
        transport.driver.routines.Do = (...args) => {
            const routine = send(...args);
            return { ...routine, send: async (option) => ({ ...(await routine.send(option)), wait: async () => { throw new Error("timeout waiting for receipt"); } }) };
        };
        await assert.rejects(transport.send("Do", []), (error) => {
            assert.equal(error.code, ErrorCode.NETWORK_ERROR);
            assert.equal(error.details.hash, "0x1");
            assert.equal(error.details.stage, "receipt");
            return true;
        });
    });
});
