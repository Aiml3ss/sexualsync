import { test } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../../functions/api/_kv.js";
import { mutateKey } from "../../functions/api/_state.js";
import { encodeStoredJson } from "../../functions/api/_encrypted_store.js";

const SECRET = "encrypted-store-test-secret-0123456789";

function decodeB64(value) {
  return Buffer.from(value, "base64").toString("utf8");
}

class MemoryKV {
  constructor() {
    this.map = new Map();
  }

  async get(key, opts = {}) {
    if (!this.map.has(key)) return null;
    const value = this.map.get(key);
    const type = typeof opts === "string" ? opts : opts?.type || "text";
    if (type === "json") return JSON.parse(value);
    if (type === "arrayBuffer") return new TextEncoder().encode(value).buffer;
    return value;
  }

  async put(key, value) {
    this.map.set(key, String(value));
  }

  async delete(key) {
    this.map.delete(key);
  }
}

test("DB-primary JSON stores are encrypted at rest and transparent on read", async () => {
  const env = { STORE: new MemoryKV(), DATA_ENCRYPTION_KEY_V1: SECRET };
  const store = getStore(env, "sexualsync-request-board");
  const value = [{ id: "req-1", categories: ["private act"], note: "sensitive request note" }];

  await store.setJSON("requests", value);

  const raw = env.STORE.map.get("sexualsync-request-board:requests");
  assert.ok(raw.includes("__sexualsyncEncryptedJson"));
  assert.equal(raw.includes("private act"), false);
  assert.equal(raw.includes("sensitive request note"), false);
  assert.deepEqual(await store.get("requests", { type: "json" }), value);
});

test("legacy plaintext JSON still reads during migration", async () => {
  const env = { STORE: new MemoryKV(), DATA_ENCRYPTION_KEY_V1: SECRET };
  env.STORE.map.set("sexualsync-approved-acts:acts", JSON.stringify([{ id: "act-1", label: "Legacy plaintext" }]));

  const value = await getStore(env, "sexualsync-approved-acts").get("acts", { type: "json" });

  assert.deepEqual(value, [{ id: "act-1", label: "Legacy plaintext" }]);
});

test("pre-public store prefixes read through neutral aliases", async () => {
  const env = { STORE: new MemoryKV(), DATA_ENCRYPTION_KEY_V1: SECRET };
  const oldRequestStore = decodeB64("YW5zLWtlbW15LXJlcXVlc3QtYm9hcmQ=");
  const legacyRows = [{ id: "req-old", note: "old prefix row" }];

  env.STORE.map.set(`${oldRequestStore}:requests`, JSON.stringify(legacyRows));

  assert.deepEqual(
    await getStore(env, "sexualsync-request-board").get("requests", { type: "json" }),
    legacyRows
  );
});

test("new store prefixes win over aliases and deletes purge both", async () => {
  const env = { STORE: new MemoryKV(), DATA_ENCRYPTION_KEY_V1: SECRET };
  const oldRequestStore = decodeB64("YW5zLWtlbW15LXJlcXVlc3QtYm9hcmQ=");
  const store = getStore(env, "sexualsync-request-board");

  env.STORE.map.set(`${oldRequestStore}:requests`, JSON.stringify([{ id: "req-old" }]));
  await store.setJSON("requests", [{ id: "req-new" }]);

  assert.deepEqual(await store.get("requests", { type: "json" }), [{ id: "req-new" }]);
  await store.delete("requests");
  assert.equal(env.STORE.map.has("sexualsync-request-board:requests"), false);
  assert.equal(env.STORE.map.has(`${oldRequestStore}:requests`), false);
});

test("sensitive non-DB-primary stores can be encrypted without becoming app_data stores", async () => {
  const env = { STORE: new MemoryKV(), DATA_ENCRYPTION_KEY_V1: SECRET };
  await getStore(env, "push").setJSON("subscriptions:room", [{ endpoint: "https://push.example/device" }]);

  const raw = env.STORE.map.get("push:subscriptions:room");
  assert.ok(raw.includes("__sexualsyncEncryptedJson"));
  assert.equal(raw.includes("push.example"), false);
  assert.deepEqual(await getStore(env, "push").get("subscriptions:room", { type: "json" }), [{ endpoint: "https://push.example/device" }]);
});

test("narration cache store is encrypted with the current HKDF envelope", async () => {
  const env = { STORE: new MemoryKV(), DATA_ENCRYPTION_KEY_V1: SECRET };
  const value = { text: "Private match narration", cachedAt: "2026-05-30T00:00:00.000Z" };

  await getStore(env, "sexualsync-narration-cache").setJSON("narrate:v4:private-cache-key", value);

  const raw = env.STORE.map.get("sexualsync-narration-cache:narrate:v4:private-cache-key");
  const envelope = JSON.parse(raw);
  assert.equal(envelope.format, "sxs-json-aes-gcm-v2");
  assert.ok(raw.includes("__sexualsyncEncryptedJson"));
  assert.equal(raw.includes("Private match narration"), false);
  assert.deepEqual(await getStore(env, "sexualsync-narration-cache").get("narrate:v4:private-cache-key", { type: "json" }), value);
});

test("generated and media lookup caches that can reveal room behavior are encrypted", async () => {
  const env = { STORE: new MemoryKV(), DATA_ENCRYPTION_KEY_V1: SECRET };

  await getStore(env, "sexualsync-redgifs-cache").setJSON("redgifs:v2:gif:test123", {
    hd: "https://media.redgifs.com/Test123.mp4"
  });
  await getStore(env, "sexualsync-push-body-cache").setJSON("pushbody:v1:room:request-sent", {
    items: ["left a request waiting for you."],
    nextIndex: 0
  });

  const redgifsRaw = env.STORE.map.get("sexualsync-redgifs-cache:redgifs:v2:gif:test123");
  const pushRaw = env.STORE.map.get("sexualsync-push-body-cache:pushbody:v1:room:request-sent");
  assert.ok(redgifsRaw.includes("__sexualsyncEncryptedJson"));
  assert.ok(pushRaw.includes("__sexualsyncEncryptedJson"));
  assert.equal(redgifsRaw.includes("Test123"), false);
  assert.equal(pushRaw.includes("request waiting"), false);
});

test("encodeStoredJson fails closed by default for a sensitive store with no key", async () => {
  // Secure-by-default: no key configured and no opt-out → refuse plaintext.
  await assert.rejects(
    () => encodeStoredJson({}, "sexualsync-vault:vault:ws-1", { secret: "intimate" }),
    /Refusing to write plaintext/
  );
  // Explicit opt-out: operator accepts keyless storage (e.g. disk/DB encryption).
  const passthrough = await encodeStoredJson({ ALLOW_PLAINTEXT_AT_REST: "1" }, "sexualsync-vault:vault:ws-1", { secret: "intimate" });
  assert.deepEqual(passthrough, { secret: "intimate" });
});

test("encodeStoredJson passes through a non-sensitive store with no key", async () => {
  const out = await encodeStoredJson({}, "sexualsync-push-stats:last-test:x", { state: "visible" });
  assert.deepEqual(out, { state: "visible" });
});

test("non-primary cache stores remain plaintext", async () => {
  const env = { STORE: new MemoryKV(), DATA_ENCRYPTION_KEY_V1: SECRET };
  await getStore(env, "sexualsync-push-stats").setJSON("last-test:room:user@example.test", { state: "visible" });

  assert.equal(env.STORE.map.get("sexualsync-push-stats:last-test:room:user@example.test"), "{\"state\":\"visible\"}");
});

test("encrypted mutateKey path stays encrypted and serializes local concurrent writes", async () => {
  const env = {
    STORE: new MemoryKV(),
    APP_SESSION_SECRET: SECRET,
    STATE: {
      idFromName() {
        throw new Error("raw State DO should not be used for encrypted stores");
      }
    }
  };

  await Promise.all([
    mutateKey(env, "sexualsync-review-tokens", "tokens", (current) => ({
      value: [...(Array.isArray(current) ? current : []), { id: "one" }]
    })),
    mutateKey(env, "sexualsync-review-tokens", "tokens", (current) => ({
      value: [...(Array.isArray(current) ? current : []), { id: "two" }]
    }))
  ]);

  const raw = env.STORE.map.get("sexualsync-review-tokens:tokens");
  assert.ok(raw.includes("__sexualsyncEncryptedJson"));
  assert.equal(raw.includes("\"one\""), false);
  assert.deepEqual(
    (await getStore(env, "sexualsync-review-tokens").get("tokens", { type: "json" })).map((item) => item.id).sort(),
    ["one", "two"]
  );
});
