import { test } from "node:test";
import assert from "node:assert/strict";
import { mutateKey, mutateRecord, readKey, readKeyStrong } from "../../functions/api/_state.js";
import { StateStoreDurableObject } from "../../workers/room/src/index.js";
import { makeStateEnv } from "./helpers.mjs";

// --- StateStoreDurableObject CAS semantics (the coordinator itself) ---

function doInstance() {
  const kvMap = new Map();
  const kv = {
    async get(key, type) {
      const raw = kvMap.has(key) ? kvMap.get(key) : null;
      if (raw == null) return null;
      return (typeof type === "string" ? type : type?.type) === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, val) { kvMap.set(key, String(val)); },
  };
  let chain = Promise.resolve();
  const state = {
    storage: { _m: new Map(), async get(k) { return this._m.get(k); }, async put(k, v) { this._m.set(k, v); } },
    blockConcurrencyWhile(fn) { const r = chain.then(() => fn()); chain = r.then(() => {}, () => {}); return r; },
  };
  return { obj: new StateStoreDurableObject(state, { STORE: kv }), kvMap };
}

const post = (obj, path, body) =>
  obj.fetch(new Request(`https://s.internal${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })).then((r) => r.json());

test("read of an unknown key returns version 0 and null", async () => {
  const { obj } = doInstance();
  const out = await post(obj, "/state/read", { key: "store:k" });
  assert.deepEqual(out, { ok: true, version: 0, value: null });
});

test("cas writes when the version matches and bumps the version", async () => {
  const { obj, kvMap } = doInstance();
  const cas = await post(obj, "/state/cas", { key: "store:k", expectedVersion: 0, value: [1, 2] });
  assert.deepEqual(cas, { ok: true, version: 1 });
  assert.equal(kvMap.get("store:k"), JSON.stringify([1, 2]));
  const read = await post(obj, "/state/read", { key: "store:k" });
  assert.deepEqual(read.value, [1, 2]);
});

test("cas with a stale version is rejected and does not write", async () => {
  const { obj, kvMap } = doInstance();
  await post(obj, "/state/cas", { key: "store:k", expectedVersion: 0, value: "first" });
  const stale = await post(obj, "/state/cas", { key: "store:k", expectedVersion: 0, value: "second" });
  assert.equal(stale.ok, false);
  assert.equal(stale.version, 1);
  assert.equal(JSON.parse(kvMap.get("store:k")), "first");
});

// --- mutateKey end-to-end (read -> transform -> cas, with retry) ---

test("mutateKey persists through the DO and is reread", async () => {
  const env = makeStateEnv();
  const out = await mutateKey(env, "teststore", "rec", () => ({ value: { n: 1 }, result: "ok" }));
  assert.equal(out, "ok");
  assert.deepEqual(await readKey(env, "teststore", "rec"), { n: 1 });
});

test("concurrent mutateKey calls do NOT lose updates", async () => {
  const env = makeStateEnv();
  await mutateKey(env, "teststore", "list", () => ({ value: [] }));

  await Promise.all([
    mutateKey(env, "teststore", "list", (cur) => ({ value: [...(cur || []), "a"] })),
    mutateKey(env, "teststore", "list", (cur) => ({ value: [...(cur || []), "b"] })),
    mutateKey(env, "teststore", "list", (cur) => ({ value: [...(cur || []), "c"] })),
  ]);

  const final = await readKey(env, "teststore", "list");
  assert.equal(final.length, 3, "all three writers must survive");
  assert.deepEqual([...final].sort(), ["a", "b", "c"]);
});

test("write:false skips the write and returns the result as a no-op", async () => {
  const env = makeStateEnv();
  await mutateKey(env, "teststore", "rec", () => ({ value: { v: 1 } }));
  const out = await mutateKey(env, "teststore", "rec", (cur) => ({ write: false, result: cur }));
  assert.deepEqual(out, { v: 1 });
});

test("mutateKey falls back to plain KV when STATE is absent", async () => {
  // No STATE binding -> uses getStore() read-modify-write. Still correct,
  // just not cross-isolate atomic.
  const { makeKvEnv } = await import("./helpers.mjs");
  const env = makeKvEnv();
  const out = await mutateKey(env, "teststore", "rec", () => ({ value: { n: 7 }, result: "fb" }));
  assert.equal(out, "fb");
  assert.deepEqual(await readKey(env, "teststore", "rec"), { n: 7 });
});

// --- At-rest encryption × CAS coordinator (regression) ---
//
// The at-rest encryption rollout originally excluded every encrypted store from
// the DO in canUseStateDo(), silently downgrading ALL product mutations to the
// per-isolate local lock — losing cross-isolate atomicity (incl. review-token
// single-use) while CI stayed green, because keyed tests took the local path
// and keyless tests took the DO path. mutateKey/mutateRecord now decode the
// envelope after the DO read and re-encode before the CAS write, so both
// properties hold at once. These tests pin that: encryption ON + STATE bound
// must still route through the DO, store envelopes in KV, and hand the
// transform plaintext.

const ENCRYPTED_STORE = "sexualsync-request-board"; // member of DATA_ENCRYPTED_STORES
const SECRET = "state-do-encrypted-cas-test-secret-0123456789abcdef";

function makeEncryptedStateEnv() {
  const env = makeStateEnv();
  env.APP_SESSION_SECRET = SECRET; // activates at-rest encryption (fallback key)
  let doCalls = 0;
  const origGet = env.STATE.get.bind(env.STATE);
  env.STATE.get = (id) => { doCalls += 1; return origGet(id); };
  return { env, doCalls: () => doCalls };
}

test("encrypted store: mutateKey routes through the DO and stores an envelope", async () => {
  const { env, doCalls } = makeEncryptedStateEnv();
  await mutateKey(env, ENCRYPTED_STORE, "cas-check", () => ({ value: [{ secret: "SENSITIVE-PLAINTEXT" }] }));

  assert.ok(doCalls() > 0, "mutation must use the StateStoreDurableObject, not the local lock");

  const raw = env.__kv.map.get(`${ENCRYPTED_STORE}:cas-check`);
  assert.ok(raw, "raw KV record exists");
  assert.ok(!raw.includes("SENSITIVE-PLAINTEXT"), "raw KV must not contain plaintext");
  const stored = JSON.parse(raw);
  assert.equal(stored.__sexualsyncEncryptedJson, true, "raw KV value is an encrypted envelope");

  // Transform sees decoded plaintext on the next mutation; readKey decodes too.
  const seen = await mutateKey(env, ENCRYPTED_STORE, "cas-check", (cur) => ({ write: false, result: cur }));
  assert.deepEqual(seen, [{ secret: "SENSITIVE-PLAINTEXT" }]);
  assert.deepEqual(await readKey(env, ENCRYPTED_STORE, "cas-check"), [{ secret: "SENSITIVE-PLAINTEXT" }]);
});

test("encrypted store: concurrent mutateKey calls still compose", async () => {
  const { env } = makeEncryptedStateEnv();
  await mutateKey(env, ENCRYPTED_STORE, "cas-list", () => ({ value: [] }));
  await Promise.all(["a", "b", "c"].map((tag) =>
    mutateKey(env, ENCRYPTED_STORE, "cas-list", (cur) => ({ value: [...(cur || []), tag] }))
  ));
  const final = await readKey(env, ENCRYPTED_STORE, "cas-list");
  assert.deepEqual([...final].sort(), ["a", "b", "c"]);
});

test("encrypted store: mutateRecord encrypts every written key and decodes the read view", async () => {
  const { env, doCalls } = makeEncryptedStateEnv();
  const out = await mutateRecord(env, "test-record", ENCRYPTED_STORE, ["alpha", "beta"], (cur) => {
    assert.deepEqual(cur, { alpha: null, beta: null });
    return { values: { alpha: { secret: "ALPHA-PLAIN" }, beta: ["BETA-PLAIN"] }, result: "wrote" };
  });
  assert.equal(out.ok, true);
  assert.equal(out.result, "wrote");
  assert.deepEqual(out.values.alpha, { secret: "ALPHA-PLAIN" });
  assert.ok(doCalls() > 0, "record mutation must use the DO");

  for (const key of ["alpha", "beta"]) {
    const raw = env.__kv.map.get(`${ENCRYPTED_STORE}:${key}`);
    assert.ok(!raw.includes("PLAIN"), `raw KV for ${key} must not contain plaintext`);
    assert.equal(JSON.parse(raw).__sexualsyncEncryptedJson, true, `${key} stored as envelope`);
  }

  // Second pass sees decoded current values.
  await mutateRecord(env, "test-record", ENCRYPTED_STORE, ["alpha", "beta"], (cur) => {
    assert.deepEqual(cur.alpha, { secret: "ALPHA-PLAIN" });
    assert.deepEqual(cur.beta, ["BETA-PLAIN"]);
    return { values: {} };
  });
});

// --- Read-your-writes: the DO now mirrors the single-key value into its own
// strongly-consistent storage so /state/read can serve it before KV propagates
// (Cloudflare KV is eventually consistent). ---

test("single-key read serves the DO-held value even when KV is stale", async () => {
  const { obj, kvMap } = doInstance();
  await post(obj, "/state/cas", { key: "store:k", expectedVersion: 0, value: { n: 1 } });
  // Simulate KV eventual-consistency lag by stomping the KV copy with a stale value.
  kvMap.set("store:k", JSON.stringify({ n: 999 }));
  const out = await post(obj, "/state/read", { key: "store:k" });
  assert.deepEqual(out.value, { n: 1 }, "read returns the strongly-consistent DO value, not stale KV");
});

test("multi-key read still reads KV (independent records, no DO value mirror)", async () => {
  const { obj, kvMap } = doInstance();
  await post(obj, "/state/cas", { keys: ["a", "b"], expectedVersion: 0, values: { a: 1, b: 2 } });
  kvMap.set("a", JSON.stringify(99));
  const out = await post(obj, "/state/read", { keys: ["a", "b"] });
  assert.deepEqual(out.values, { a: 99, b: 2 }, "multi-key keeps reading KV directly");
});

test("readKeyStrong reads the fresh DO value while readKey sees stale KV", async () => {
  const env = makeStateEnv();
  await mutateKey(env, "test-store", "k1", () => ({ value: { n: 1 } }));
  env.__kv.map.set("test-store:k1", JSON.stringify({ n: 999 })); // KV goes stale
  assert.deepEqual(await readKey(env, "test-store", "k1"), { n: 999 }, "readKey reads stale KV");
  assert.deepEqual(await readKeyStrong(env, "test-store", "k1"), { n: 1 }, "readKeyStrong reads fresh DO value");
});
