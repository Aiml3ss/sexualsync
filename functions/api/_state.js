// Atomic read-modify-write for contended KV records.
//
// Cloudflare KV has no compare-and-swap, so the long-standing
// "read whole list -> mutate -> write whole list" pattern silently loses
// updates when two isolates mutate the same key at once. mutateKey() routes
// the read-modify-write through the StateStoreDurableObject CAS coordinator
// (see workers/room/src/index.js): it reads {version, value}, applies the
// caller's transform, then asks the DO to write only if the version still
// matches. On a version conflict it retries with the fresh value, so
// concurrent writers compose instead of clobbering.
//
// Safe rollout: when the STATE binding is absent (not yet deployed) or the
// store is served from a database backend (DATA_BACKEND=supabase/dual, where
// Postgres should provide atomicity), mutateKey falls back to the plain
// getStore() read-modify-write — same result, just without cross-isolate
// serialization. The on-KV data format is identical on both paths.

import { decodeStoredJson, encodeStoredJson } from "./_encrypted_store.js";
import { getStore, isDatabaseBackedStore } from "./_kv.js";

const DEFAULT_ATTEMPTS = 6;
const STATE_BASE_URL = "https://state.sexualsync.internal";
const LOCAL_MUTATION_LOCKS = new Map();

function stateNamespace(env) {
  const ns = env?.STATE;
  if (!ns || typeof ns.idFromName !== "function" || typeof ns.get !== "function") return null;
  return ns;
}

function canUseStateDo(env, storeName) {
  // Database-backed stores must not be CAS'd to raw KV — that would diverge
  // from the active Supabase backend. Let getStore() handle those.
  //
  // Encrypted-at-rest stores DO go through the coordinator: the worker decodes
  // the envelope after the DO read and re-encodes before the CAS write (the DO
  // only ever sees opaque values), so cross-isolate atomicity and at-rest
  // encryption hold together. Excluding encrypted stores here would silently
  // downgrade every product store to the per-isolate local lock — losing the
  // serialization guarantees callers (e.g. review-token single-use) rely on.
  if (isDatabaseBackedStore(env, storeName)) return false;
  return Boolean(stateNamespace(env));
}

function stateStub(env, fullKey) {
  const ns = stateNamespace(env);
  return ns.get(ns.idFromName(`state:${fullKey}`));
}

async function doRequest(env, fullKey, path, payload) {
  const res = await stateStub(env, fullKey).fetch(`${STATE_BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

/**
 * Read the current value of a KV record. Returns the parsed JSON value (or null).
 */
// Reads go straight to KV. The coordinator holds only a version counter, so a
// DO round-trip on a read adds a hop with no consistency benefit (KV is the
// durable store and the DO writes to it). The version-aware read used for a
// compare-and-set lives inside mutateKey/mutateRecord, not here.
export async function readKey(env, storeName, key) {
  return getStore(env, storeName).get(key, { type: "json" });
}

/**
 * Read-your-writes variant of readKey. Cloudflare KV is eventually consistent
 * (a read can serve a ~60s-stale value after a write), so callers that need to
 * see the latest mutateKey write immediately (e.g. the Sexboard reading a game
 * you just submitted) route through the CAS DO, which now also holds the latest
 * single-key value in its strongly-consistent storage. Falls back to the plain
 * KV read when the coordinator is unavailable (self-host / DB-backed) or the DO
 * has no stored value yet (record written before this existed) — same on-KV
 * format, so the decode is identical to getStore()/readKey.
 */
export async function readKeyStrong(env, storeName, key) {
  if (!canUseStateDo(env, storeName)) {
    return getStore(env, storeName).get(key, { type: "json" });
  }
  const fullKey = `${storeName}:${key}`;
  try {
    const read = await doRequest(env, fullKey, "/state/read", { key: fullKey });
    if (read && read.ok) return await decodeStoredJson(env, fullKey, read.value ?? null);
  } catch {
    // Coordinator hiccup — fall back to KV rather than fail the read.
  }
  return getStore(env, storeName).get(key, { type: "json" });
}

/**
 * Atomically transform a KV record.
 *
 * @param transform (currentValue) => { value, result?, write? }
 *   - value: the new value to persist
 *   - result: what mutateKey returns to the caller (defaults to value)
 *   - write: set false to skip the write entirely (read-only outcome / no-op)
 * @returns the transform's `result` (or the new value if no result given)
 */
export async function mutateKey(env, storeName, key, transform, { attempts = DEFAULT_ATTEMPTS } = {}) {
  if (!canUseStateDo(env, storeName)) {
    return withLocalMutationLock(`${storeName}:${key}`, async () => {
      const store = getStore(env, storeName);
      const current = await store.get(key, { type: "json" });
      const { value, result, write = true } = transform(current) || {};
      if (write) await store.setJSON(key, value);
      return result === undefined ? value : result;
    });
  }

  const fullKey = `${storeName}:${key}`;
  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const read = await doRequest(env, fullKey, "/state/read", { key: fullKey });
    if (!read || !read.ok) { lastErr = new Error("state read failed"); continue; }
    // The DO hands back the raw KV value — an encrypted envelope when at-rest
    // encryption is active. Decode before the transform and re-encode before
    // the CAS write so the transform always sees plaintext JSON while KV only
    // ever holds envelopes (mirrors getStore()'s get/setJSON seam).
    const currentValue = await decodeStoredJson(env, fullKey, read.value ?? null);
    const { value, result, write = true } = transform(currentValue) || {};
    if (!write) return result === undefined ? currentValue : result;
    const cas = await doRequest(env, fullKey, "/state/cas", {
      key: fullKey,
      expectedVersion: read.version,
      value: await encodeStoredJson(env, fullKey, value),
    });
    if (cas && cas.ok) return result === undefined ? value : result;
    lastErr = new Error("state cas conflict");
  }
  throw lastErr || new Error(`mutateKey: exhausted attempts for ${fullKey}`);
}

// --- Multi-key records (e.g. platform state spans profiles/workspaces/invites) ---
//
// The transform receives the current values keyed by BARE key (no store prefix)
// and returns one of:
//   { abort: <anything> }                 -> no write; mutateRecord returns { ok:false, abort }
//   { values: { key: newVal, ... }, result? } -> writes only the listed keys
// On success returns { ok:true, result, values } where `values` is the merged
// post-write view. All listed keys live under one version, so the whole record
// mutates atomically.

function recordStub(env, recordName) {
  const ns = stateNamespace(env);
  return ns.get(ns.idFromName(`record:${recordName}`));
}

async function recordRequest(env, recordName, path, payload) {
  const res = await recordStub(env, recordName).fetch(`${STATE_BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// Reads go straight to KV (see readKey), in parallel across the record's keys.
export async function readRecord(env, _recordName, storeName, keys) {
  const store = getStore(env, storeName);
  const entries = await Promise.all(
    keys.map(async (k) => [k, await store.get(k, { type: "json" })]),
  );
  return Object.fromEntries(entries);
}

export async function mutateRecord(env, recordName, storeName, keys, transform, { attempts = DEFAULT_ATTEMPTS } = {}) {
  const applyWrites = async (writes) => {
    const store = getStore(env, storeName);
    for (const [k, v] of Object.entries(writes)) await store.setJSON(k, v);
  };

  if (!canUseStateDo(env, storeName)) {
    return withLocalMutationLock(`${storeName}:${recordName}`, async () => {
      const store = getStore(env, storeName);
      const current = {};
      for (const k of keys) current[k] = await store.get(k, { type: "json" });
      const out = transform(current) || {};
      if (out.abort !== undefined) return { ok: false, abort: out.abort };
      const writes = out.values || {};
      await applyWrites(writes);
      return { ok: true, result: out.result, values: { ...current, ...writes } };
    });
  }

  const fullKeys = keys.map((k) => `${storeName}:${k}`);
  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const read = await recordRequest(env, recordName, "/state/read", { keys: fullKeys });
    if (!read || !read.ok) { lastErr = new Error("record read failed"); continue; }
    // Decode each raw KV value (encrypted envelope when at-rest encryption is
    // active) so the transform sees plaintext; re-encode every write below.
    const current = {};
    await Promise.all(keys.map(async (k) => {
      current[k] = await decodeStoredJson(env, `${storeName}:${k}`, read.values?.[`${storeName}:${k}`] ?? null);
    }));

    const out = transform(current) || {};
    if (out.abort !== undefined) return { ok: false, abort: out.abort };

    const bareWrites = out.values || {};
    if (!Object.keys(bareWrites).length) {
      return { ok: true, result: out.result, values: current };
    }
    const fullWrites = {};
    for (const [k, v] of Object.entries(bareWrites)) {
      fullWrites[`${storeName}:${k}`] = await encodeStoredJson(env, `${storeName}:${k}`, v);
    }

    const cas = await recordRequest(env, recordName, "/state/cas", {
      keys: fullKeys,
      expectedVersion: read.version,
      values: fullWrites,
    });
    if (cas && cas.ok) {
      return { ok: true, result: out.result, values: { ...current, ...bareWrites } };
    }
    lastErr = new Error("record cas conflict");
  }
  throw lastErr || new Error(`mutateRecord: exhausted attempts for ${recordName}`);
}

async function withLocalMutationLock(name, task) {
  const prior = LOCAL_MUTATION_LOCKS.get(name) || Promise.resolve();
  const run = (async () => {
    await prior.catch(() => {});
    return task();
  })();
  const stored = run.catch(() => {});
  LOCAL_MUTATION_LOCKS.set(name, stored);
  try {
    return await run;
  } finally {
    if (LOCAL_MUTATION_LOCKS.get(name) === stored) LOCAL_MUTATION_LOCKS.delete(name);
  }
}
