import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRateLimit } from "../../functions/api/_rate_limit.js";

// In-memory env stub with a `STORE` binding but NO `STATE` binding, so
// checkRateLimit's mutateKey runs through the local-mutation-lock fallback
// (the dev / KV-only path). The store mimics the subset of the Cloudflare KV
// surface getStore() uses: JSON written as a stringified value, read back with
// a "json" type hint. `throws` flips get() into a failure to exercise the
// fail-open / fail-closed branches.
function makeEnv({ throws = false } = {}) {
  const map = new Map();
  const STORE = {
    async get(key, type) {
      if (throws) throw new Error("kv unavailable");
      const raw = map.has(key) ? map.get(key) : null;
      if (raw == null) return null;
      const t = typeof type === "string" ? type : type?.type;
      if (t === "json") { try { return JSON.parse(raw); } catch { return null; } }
      return raw;
    },
    async put(key, value) {
      if (throws) throw new Error("kv unavailable");
      map.set(key, String(value));
    },
    async delete(key) { map.delete(key); },
  };
  return { STORE, __map: map };
}

const consume = (env, overrides = {}) => checkRateLimit(env, {
  bucket: "invite-send",
  key: "a@x.com",
  limit: 3,
  windowSeconds: 60,
  ...overrides,
});

test("no-op (allows) when STORE binding is absent", async () => {
  const r = await checkRateLimit({}, { bucket: "b", key: "k", limit: 1, windowSeconds: 60 });
  assert.equal(r.ok, true);
});

test("no-op (allows) when a required field is missing", async () => {
  const env = makeEnv();
  assert.equal((await checkRateLimit(env, { bucket: "b", key: "k", windowSeconds: 60 })).ok, true);
  assert.equal((await checkRateLimit(env, { bucket: "b", key: "k", limit: 1 })).ok, true);
});

// (1) Sequential calls allow exactly `limit`, then reject with a retryAfter.
test("sequential calls allow exactly the limit, then reject", async () => {
  const env = makeEnv();
  const limit = 3;

  for (let i = 0; i < limit; i += 1) {
    const r = await consume(env, { limit });
    assert.equal(r.ok, true, `call ${i + 1} of ${limit} must be allowed`);
  }

  const blocked = await consume(env, { limit });
  assert.equal(blocked.ok, false, "the call past the limit must be rejected");
  assert.ok(blocked.retryAfter >= 1, "a rejection reports retryAfter seconds");
  assert.ok(blocked.retryAfter <= 60, "retryAfter never exceeds the window");

  // Still blocked on subsequent over-limit attempts (counter does not advance
  // past the ceiling, and the window has not reset).
  assert.equal((await consume(env, { limit })).ok, false);
});

// (2) THE RACE FIX: limit*2 concurrent calls must allow AT MOST `limit`.
// Before the atomic mutateKey, each isolate read the same pre-increment count
// and all slipped under the ceiling (effective limit ~= limit + concurrency).
test("concurrent calls allow at most the limit (the check-then-set race is closed)", async () => {
  const env = makeEnv();
  const limit = 5;

  const results = await Promise.all(
    Array.from({ length: limit * 2 }, () => consume(env, { limit })),
  );

  const allowed = results.filter((r) => r.ok).length;
  const rejected = results.filter((r) => !r.ok).length;
  assert.ok(allowed <= limit, `at most ${limit} may be allowed, got ${allowed}`);
  assert.equal(allowed, limit, `exactly ${limit} should win under contention, got ${allowed}`);
  assert.equal(rejected, limit, `the other ${limit} must be rejected, got ${rejected}`);
  results.filter((r) => !r.ok).forEach((r) => assert.ok(r.retryAfter >= 1));
});

// (3) After windowSeconds elapses the window resets and calls are allowed
// again. Expiry is logical (encoded in windowStart, reset in-transform), not a
// KV TTL — so we advance Date.now() rather than waiting in real time.
test("window reset after windowSeconds allows again", async () => {
  const env = makeEnv();
  const limit = 2;
  const windowSeconds = 60;
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;

  try {
    // Exhaust the window.
    assert.equal((await consume(env, { limit, windowSeconds })).ok, true);
    assert.equal((await consume(env, { limit, windowSeconds })).ok, true);
    assert.equal((await consume(env, { limit, windowSeconds })).ok, false);

    // Just before the window elapses: still blocked.
    clock += windowSeconds * 1000 - 1;
    assert.equal((await consume(env, { limit, windowSeconds })).ok, false);

    // Window has now fully elapsed: a fresh window starts and the call passes.
    clock += 1;
    assert.equal((await consume(env, { limit, windowSeconds })).ok, true,
      "a new window must allow requests again");
    // And the fresh window enforces the limit anew.
    assert.equal((await consume(env, { limit, windowSeconds })).ok, true);
    assert.equal((await consume(env, { limit, windowSeconds })).ok, false);
  } finally {
    Date.now = realNow;
  }
});

// Best-effort buckets fail OPEN on a store error so a transient blip doesn't
// block legitimate use.
test("fails OPEN on a store error by default", async () => {
  const env = makeEnv({ throws: true });
  const r = await consume(env, { failClosed: false });
  assert.equal(r.ok, true);
});

// Sensitive buckets opt into failing CLOSED so a store blip can't disable
// throttling.
test("fails CLOSED on a store error when failClosed is set", async () => {
  const env = makeEnv({ throws: true });
  const r = await consume(env, { failClosed: true });
  assert.equal(r.ok, false);
  assert.ok(r.retryAfter >= 1);
});
