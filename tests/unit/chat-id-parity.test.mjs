import { test } from "node:test";
import assert from "node:assert/strict";
import { idempotentId } from "../../functions/api/_idempotency.js";

// The Sext composer pre-computes a message id from the idempotency key so an
// optimistic bubble reconciles in place with the server's message (same id).
// web/src/lib/api.ts predictChatMessageId() MUST produce the same id the server
// derives here. These golden values pin the server hash; if it changes, the
// client predictor drifts and optimistic sends would briefly duplicate.
const CASES = [
  { workspaceId: "w1", email: "Local-Preview@Example.test", key: "abc-123-uuid", id: "msg_lj_n6QgrSX6v2HqBQ5hzURBz5n4GJLdI" },
  { workspaceId: "ws_42", email: "partner@example.test", key: "550e8400-e29b-41d4-a716-446655440000", id: "msg_QiI7yriSJU4IsVsHIOM08Q6ktNGyblI0" },
  { workspaceId: "", email: "x@y.z", key: "k", id: "msg_F4K-rjcXL8b8dNRZgFZnO2ozeKqvq7KP" },
];

// Inline copy of the CLIENT algorithm (predictChatMessageId). Kept here so this
// node test (which runs in CI, unlike the web vitest suite) guards parity end to
// end: server idempotentId == this client mirror == golden.
const encoder = new TextEncoder();
function cleanKeyClient(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 128);
}
function base64UrlFromBytes(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function clientPredict(workspaceId, actorEmail, key) {
  const cleaned = cleanKeyClient(key);
  if (!cleaned) return "";
  const email = String(actorEmail || "").trim().toLowerCase();
  const material = ["chat:message", workspaceId || "", email, "", cleaned].join("\0");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(material)));
  return `msg_${base64UrlFromBytes(digest).slice(0, 32)}`;
}

test("server idempotentId for chat messages matches the pinned golden ids", async () => {
  for (const c of CASES) {
    const id = await idempotentId({ namespace: "chat:message", key: c.key, prefix: "msg", workspaceId: c.workspaceId, actorEmail: c.email });
    assert.equal(id, c.id, `server id drifted for ${JSON.stringify(c)}`);
  }
});

test("the client predictor algorithm equals the server id (optimistic-send parity)", async () => {
  for (const c of CASES) {
    const server = await idempotentId({ namespace: "chat:message", key: c.key, prefix: "msg", workspaceId: c.workspaceId, actorEmail: c.email });
    const client = await clientPredict(c.workspaceId, c.email, c.key);
    assert.equal(client, server, `client/server id parity broke for ${JSON.stringify(c)}`);
  }
});
