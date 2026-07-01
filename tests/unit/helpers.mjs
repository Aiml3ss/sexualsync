// Shared test helpers for the node:test unit suites.
//
// makeKvEnv() returns an `env` whose STORE binding mimics the subset of the
// Cloudflare KV API the app uses (get/put/delete). The app's getStore() adapter
// stores JSON as stringified values and reads them back with a "json" type hint,
// so the fake parses on read accordingly.

import { StateStoreDurableObject } from "../../workers/room/src/index.js";

function makeFakeKv() {
  const map = new Map();
  return {
    map,
    async get(key, type) {
      const raw = map.has(key) ? map.get(key) : null;
      if (raw == null) return null;
      const t = typeof type === "string" ? type : type?.type;
      if (t === "json") { try { return JSON.parse(raw); } catch { return null; } }
      return raw;
    },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); },
  };
}

// Faithful stand-in for the Durable Object `state`: blockConcurrencyWhile
// serializes callbacks (as the real runtime does), which is what makes the
// CAS critical section atomic.
function makeFakeDurableState() {
  const storage = new Map();
  let chain = Promise.resolve();
  return {
    storage: {
      async get(k) { return storage.get(k); },
      async put(k, v) { storage.set(k, v); },
    },
    blockConcurrencyWhile(fn) {
      const run = chain.then(() => fn());
      chain = run.then(() => {}, () => {});
      return run;
    },
  };
}

// Builds an env whose STATE binding routes to real StateStoreDurableObject
// instances (one per idFromName), all sharing a single in-memory KV — so tests
// exercise the actual CAS code path, including concurrency.
export function makeStateEnv() {
  const kv = makeFakeKv();
  const instances = new Map();
  const instanceFor = (id) => {
    if (!instances.has(id)) {
      instances.set(id, new StateStoreDurableObject(makeFakeDurableState(), { STORE: kv }));
    }
    return instances.get(id);
  };
  const STATE = {
    idFromName: (name) => name,
    get: (id) => ({ fetch: (url, init) => instanceFor(id).fetch(new Request(url, init)) }),
  };
  // Tests exercise handler/CAS logic, not at-rest encryption (that has dedicated
  // coverage in encrypted-store.test.mjs). Opt into keyless storage so the
  // secure-by-default plaintext refusal doesn't fire here.
  return { STATE, STORE: kv, ALLOW_PLAINTEXT_AT_REST: "1", __kv: kv };
}

export function makeKvEnv() {
  const map = new Map();
  const STORE = {
    async get(key, type) {
      const raw = map.has(key) ? map.get(key) : null;
      if (raw == null) return null;
      const t = typeof type === "string" ? type : type?.type;
      if (t === "json") {
        try { return JSON.parse(raw); } catch { return null; }
      }
      return raw;
    },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); },
  };
  // Enables the local-preview identity in getAuthenticatedIdentity so handler
  // tests authenticate without cookie plumbing. Mirrors `npm run dev`.
  return { STORE, ALLOW_LOCAL_PREVIEW: "1", ALLOW_PLAINTEXT_AT_REST: "1", __map: map };
}

// Encodes like functions/api/_app_session.js so tests can craft tokens
// (e.g. an already-expired one) the public API won't otherwise produce.
function base64UrlBytes(bytes) {
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64UrlText(text) {
  return base64UrlBytes(new TextEncoder().encode(text));
}

export async function signSessionBody(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return base64UrlBytes(new Uint8Array(sig));
}

export async function makeSessionToken(secret, payload) {
  const body = base64UrlText(JSON.stringify(payload));
  const sig = await signSessionBody(secret, body);
  return `${body}.${sig}`;
}
