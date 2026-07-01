import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RUNTIME_TARGET,
  RUNTIME_CLOUDFLARE,
  RUNTIME_NODE,
  RUNTIME_TARGETS,
  isCloudflareRuntime,
  isRecognizedRuntimeTarget,
  isSelfHostNodeRuntime,
  runtimeTarget
} from "../../functions/api/_runtime.js";
import { getStore } from "../../functions/api/_kv.js";

// --- The contract that protects the live Cloudflare deployment --------------

test("runtime default is cloudflare", () => {
  assert.equal(DEFAULT_RUNTIME_TARGET, RUNTIME_CLOUDFLARE);
  // No env at all, empty env, and env without the key all resolve to cloudflare.
  assert.equal(runtimeTarget(undefined), "cloudflare");
  assert.equal(runtimeTarget(null), "cloudflare");
  assert.equal(runtimeTarget({}), "cloudflare");
  assert.equal(runtimeTarget({ SELF_HOST_TARGET: "" }), "cloudflare");
  assert.equal(isCloudflareRuntime({}), true);
  assert.equal(isSelfHostNodeRuntime({}), false);
});

test("unrecognized SELF_HOST_TARGET falls back to cloudflare (typo can't divert prod)", () => {
  for (const bogus of ["nodejs", "aws", "1", "true", "CLOUDFLARE ", "  ", "self-host"]) {
    assert.equal(runtimeTarget({ SELF_HOST_TARGET: bogus }), "cloudflare", `\`${bogus}\` should fall back`);
    assert.equal(isCloudflareRuntime({ SELF_HOST_TARGET: bogus }), true);
  }
});

test("SELF_HOST_TARGET=node is recognized but only when explicitly set", () => {
  const nodeEnv = { SELF_HOST_TARGET: "node" };
  assert.equal(runtimeTarget(nodeEnv), RUNTIME_NODE);
  assert.equal(isSelfHostNodeRuntime(nodeEnv), true);
  assert.equal(isCloudflareRuntime(nodeEnv), false);
  // Case/whitespace tolerant so operator config isn't brittle.
  assert.equal(runtimeTarget({ SELF_HOST_TARGET: "  NODE  " }), RUNTIME_NODE);
});

test("isRecognizedRuntimeTarget flags exactly the known targets", () => {
  assert.equal(isRecognizedRuntimeTarget("cloudflare"), true);
  assert.equal(isRecognizedRuntimeTarget("node"), true);
  assert.equal(isRecognizedRuntimeTarget("Node"), true);
  assert.equal(isRecognizedRuntimeTarget("postgres"), false);
  assert.equal(isRecognizedRuntimeTarget(""), false);
  assert.equal(isRecognizedRuntimeTarget(undefined), false);
  assert.deepEqual([...RUNTIME_TARGETS], ["cloudflare", "node"]);
});

// --- Recognized-but-not-wired: selecting node must not change existing wiring -

test("selecting node does not alter the existing storage backend wiring", async () => {
  // _kv.js keys off DATA_BACKEND, never SELF_HOST_TARGET. Proving that here
  // guarantees the runtime marker is inert: a node-targeted env still produces
  // the default KV-backed store, exactly as the live Cloudflare path does.
  const map = new Map();
  const STORE = {
    async get(key, type) {
      if (!map.has(key)) return null;
      const t = typeof type === "string" ? type : type?.type;
      return t === "json" ? JSON.parse(map.get(key)) : map.get(key);
    },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); }
  };

  const cfStore = getStore({ STORE, ALLOW_PLAINTEXT_AT_REST: "1" }, "sexualsync-vault");
  const nodeStore = getStore({ STORE, SELF_HOST_TARGET: "node", ALLOW_PLAINTEXT_AT_REST: "1" }, "sexualsync-vault");

  await cfStore.setJSON("vault:probe", { ok: true });
  // Same KV-backed store regardless of SELF_HOST_TARGET: the node env reads the
  // value the cloudflare env wrote, against the same binding.
  assert.deepEqual(await nodeStore.get("vault:probe", { type: "json" }), { ok: true });
});
