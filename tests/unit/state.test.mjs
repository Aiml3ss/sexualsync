import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mutateKey,
  mutateRecord,
  readKey,
  readKeyStrong,
  readRecord,
} from "../../functions/api/_state.js";
import { makeStateEnv } from "./helpers.mjs";

// _state.js is the compare-and-set layer behind every contended KV write (Asks,
// Pile, quiz, green-lights, …) — 39 dependents, no direct test file. makeStateEnv
// runs the REAL StateStoreDurableObject over a serializing blockConcurrencyWhile,
// so these exercise the actual CAS path: the transform contract, no-lost-update
// under concurrency, and read-your-writes via the coordinator.

const STORE = "test-state";

test("readKey returns null for a missing key", async () => {
  const env = makeStateEnv();
  assert.equal(await readKey(env, STORE, "absent"), null);
});

test("mutateKey persists the transform's value and returns it (no result given)", async () => {
  const env = makeStateEnv();
  const out = await mutateKey(env, STORE, "k", (current) => {
    assert.equal(current, null, "first transform sees null");
    return { value: { n: 1 } };
  });
  assert.deepEqual(out, { n: 1 });
  assert.deepEqual(await readKey(env, STORE, "k"), { n: 1 });
});

test("mutateKey returns `result` when given, distinct from the stored value", async () => {
  const env = makeStateEnv();
  const out = await mutateKey(env, STORE, "k", () => ({ value: { stored: true }, result: "ok" }));
  assert.equal(out, "ok");
  assert.deepEqual(await readKey(env, STORE, "k"), { stored: true });
});

test("mutateKey with write:false leaves the record untouched and returns the chosen result", async () => {
  const env = makeStateEnv();
  await mutateKey(env, STORE, "k", () => ({ value: { n: 1 } }));
  const out = await mutateKey(env, STORE, "k", (current) => ({ value: { n: 99 }, result: current, write: false }));
  assert.deepEqual(out, { n: 1 }, "returns current value when not writing");
  assert.deepEqual(await readKey(env, STORE, "k"), { n: 1 }, "stored value unchanged");
});

test("sequential mutateKey sees the prior write", async () => {
  const env = makeStateEnv();
  await mutateKey(env, STORE, "c", (current) => ({ value: (current || 0) + 1 }));
  await mutateKey(env, STORE, "c", (current) => ({ value: (current || 0) + 1 }));
  assert.equal(await readKey(env, STORE, "c"), 2);
});

// NOTE: no-lost-update under *concurrent* mutateKey is intentionally asserted at
// the handler level (pile.test.mjs "double-tapped lock derives exactly one
// session"; request-board start/clobber tests) rather than here. The real
// Durable Object's blockConcurrencyWhile blocks ALL event delivery (incl.
// /state/read) for the whole CAS critical section; the unit harness's fake only
// chains the cas callbacks, so a high-fanout race in a direct test would expose
// that harness-fidelity gap, not a production behavior.

test("readKeyStrong returns the just-written value (read-your-writes via the DO)", async () => {
  const env = makeStateEnv();
  await mutateKey(env, STORE, "ryw", () => ({ value: { fresh: true } }));
  assert.deepEqual(await readKeyStrong(env, STORE, "ryw"), { fresh: true });
});

test("mutateRecord writes multiple keys atomically; readRecord reads them back", async () => {
  const env = makeStateEnv();
  const keys = ["a", "b"];
  const res = await mutateRecord(env, "rec", STORE, keys, () => ({
    values: { a: 1, b: 2 },
    result: "done",
  }));
  assert.equal(res.ok, true);
  assert.equal(res.result, "done");
  assert.deepEqual(await readRecord(env, "rec", STORE, keys), { a: 1, b: 2 });
});
