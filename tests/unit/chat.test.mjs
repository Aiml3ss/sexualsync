import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest as chat } from "../../functions/api/chat.js";
import { chatMediaKey } from "../../functions/api/chat-media.js";
import { mutatePlatformState } from "../../functions/api/_workspaces.js";
import { mutateKey, readKey } from "../../functions/api/_state.js";
import { makeStateEnv } from "./helpers.mjs";

const ME = "local-preview@example.test";
const PARTNER = "partner@example.test";
const STORE = "sexualsync-chat";
const WORKSPACE_ID = "w1";
const THREAD_KEY = `thread:${WORKSPACE_ID}`;

const member = (email, role = "partner") => ({
  email,
  role,
  status: "active",
  displayName: email.split("@")[0],
});

async function setup({ settings = {}, thread = null } = {}) {
  const env = makeStateEnv();
  env.ALLOW_LOCAL_PREVIEW = "1";
  await mutatePlatformState(env, () => ({
    profiles: [
      { id: "p1", email: ME, displayName: "Me" },
      { id: "p2", email: PARTNER, displayName: "Partner" },
    ],
    workspaces: [{
      id: WORKSPACE_ID,
      name: "Room",
      displayName: "Room",
      status: "active",
      productMode: "couples",
      members: [member(ME, "owner"), member(PARTNER)],
      settings,
    }],
    invites: [],
  }));
  if (thread) await mutateKey(env, STORE, THREAD_KEY, () => ({ value: thread }));
  return env;
}

const call = (env, method, body, headers = {}) => chat({
  request: new Request("http://localhost/api/chat", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "GET" ? undefined : JSON.stringify(body),
  }),
  env,
});

const readThread = async (env) => (await readKey(env, STORE, THREAD_KEY)) || { seq: 0, messages: [], readCursors: {} };

// Minimal R2 mock that records deletes, so we can prove unsend destroys the blob.
function mockBucket() {
  const store = new Map();
  const deletes = [];
  return {
    async put(key, value) { store.set(key, value); },
    async get(key) { const v = store.get(key); return v === undefined ? null : { body: v }; },
    async delete(key) { deletes.push(key); store.delete(key); },
    _deletes: deletes,
    _store: store,
  };
}

test("a sent message lands in the thread with a monotonic seq", async () => {
  const env = await setup();
  const res = await call(env, "POST", { workspaceId: WORKSPACE_ID, text: "hey you" });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.message.text, "hey you");
  assert.equal(body.message.seq, 1);
  assert.equal(body.message.email, ME);
  const stored = await readThread(env);
  assert.equal(stored.messages.length, 1);
  assert.equal(stored.seq, 1);
});

test("a message can reply to another: replyToId is persisted and returned", async () => {
  const env = await setup({
    thread: {
      seq: 1,
      readCursors: {},
      messages: [{ id: "m1", email: PARTNER, name: "Partner", at: "2026-01-01T00:00:00.000Z", seq: 1, text: "you up?", reactions: [] }],
    },
  });
  const res = await call(env, "POST", { workspaceId: WORKSPACE_ID, text: "always", replyToId: "m1" });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.message.replyToId, "m1", "the reply reference is returned to the client");
  const stored = await readThread(env);
  const reply = stored.messages.find((m) => m.text === "always");
  assert.equal(reply.replyToId, "m1", "the reply reference is persisted on the message");
});

test("an idempotency-key replays the same message instead of duplicating", async () => {
  const env = await setup();
  const headers = { "idempotency-key": "abc-123" };
  const first = await (await call(env, "POST", { workspaceId: WORKSPACE_ID, text: "once" }, headers)).json();
  const second = await call(env, "POST", { workspaceId: WORKSPACE_ID, text: "once" }, headers);
  assert.equal(second.status, 200);
  const body = await second.json();
  assert.equal(body.idempotent, true);
  assert.equal(body.message.id, first.message.id);
  assert.equal((await readThread(env)).messages.length, 1);
});

test("reacting is a toggle: same emoji twice clears it", async () => {
  const env = await setup();
  const sent = await (await call(env, "POST", { workspaceId: WORKSPACE_ID, text: "react to me" })).json();
  const id = sent.message.id;
  const reacted = await (await call(env, "PATCH", { workspaceId: WORKSPACE_ID, id, action: "react", emoji: "🔥" })).json();
  assert.equal(reacted.message.reactions.length, 1);
  assert.equal(reacted.message.reactions[0].emoji, "🔥");
  const toggled = await (await call(env, "PATCH", { workspaceId: WORKSPACE_ID, id, action: "react", emoji: "🔥" })).json();
  assert.equal(toggled.message.reactions.length, 0);
});

test("only the author can edit or unsend a message", async () => {
  const env = await setup({
    thread: {
      seq: 1,
      messages: [{ id: "m1", seq: 1, email: PARTNER, name: "Partner", text: "theirs", at: new Date().toISOString(), reactions: [] }],
      readCursors: {},
    },
  });
  const edit = await call(env, "PATCH", { workspaceId: WORKSPACE_ID, id: "m1", text: "hacked" });
  assert.equal(edit.status, 403);
  const unsend = await call(env, "DELETE", { workspaceId: WORKSPACE_ID, id: "m1" });
  assert.equal(unsend.status, 403);
  assert.equal((await readThread(env)).messages[0].text, "theirs");
});

test("editing my own message stamps editedAt and updates the text", async () => {
  const env = await setup();
  const sent = await (await call(env, "POST", { workspaceId: WORKSPACE_ID, text: "typo" })).json();
  const edited = await (await call(env, "PATCH", { workspaceId: WORKSPACE_ID, id: sent.message.id, text: "fixed" })).json();
  assert.equal(edited.message.text, "fixed");
  assert.ok(edited.message.editedAt);
});

test("unsending my message tombstones it and strips the text", async () => {
  const env = await setup();
  const sent = await (await call(env, "POST", { workspaceId: WORKSPACE_ID, text: "oops" })).json();
  const res = await call(env, "DELETE", { workspaceId: WORKSPACE_ID, id: sent.message.id });
  assert.equal(res.status, 200);
  const stored = await readThread(env);
  assert.equal(stored.messages[0].text, "");
  assert.ok(stored.messages[0].deletedAt);
});

test("unsending an image message strips the media key AND destroys the R2 blob (audit M2)", async () => {
  // Pre-2026 bug: unsend kept message.media (so the inline AES key survived for
  // E2EE-off rooms) and never deleted the R2 ciphertext — an "unsent" explicit
  // image stayed fully recoverable. This locks both halves of the fix.
  const env = await setup({
    thread: {
      seq: 1,
      readCursors: {},
      messages: [{
        id: "m1", email: ME, name: "Me", at: "2026-01-01T00:00:00.000Z", seq: 1,
        text: "",
        media: { mediaId: "img1", mediaType: "image/jpeg", mediaSize: 4096, key: "c2VjcmV0a2V5", iv: "aXZpdml2" },
        reactions: [],
      }],
    },
  });
  const bucket = mockBucket();
  const blobKey = chatMediaKey(WORKSPACE_ID, "img1");
  await bucket.put(blobKey, new Uint8Array([1, 2, 3, 4]));
  env.VAULT_MEDIA = bucket;

  const res = await call(env, "DELETE", { workspaceId: WORKSPACE_ID, id: "m1" });
  assert.equal(res.status, 200);

  const tombstone = (await readThread(env)).messages[0];
  assert.ok(tombstone.deletedAt, "message is tombstoned");
  assert.equal(tombstone.media, undefined, "the whole media object (incl. the inline AES key) is stripped from the record");
  assert.deepEqual(bucket._deletes, [blobKey], "the encrypted R2 blob is deleted exactly once");
  assert.equal(bucket._store.has(blobKey), false, "the ciphertext is no longer retrievable");
});

test("the read cursor advances and never goes backward", async () => {
  const env = await setup();
  await call(env, "POST", { workspaceId: WORKSPACE_ID, text: "a" });
  await call(env, "POST", { workspaceId: WORKSPACE_ID, text: "b" });
  const read = await (await call(env, "PATCH", { workspaceId: WORKSPACE_ID, action: "read", seq: 2 })).json();
  assert.equal(read.readCursors[ME], 2);
  // "Seen 9:42 PM" needs a read timestamp recorded when the cursor advances.
  assert.ok(read.readAt && typeof read.readAt[ME] === "string" && read.readAt[ME], "records when the cursor advanced");
  const back = await (await call(env, "PATCH", { workspaceId: WORKSPACE_ID, action: "read", seq: 1 })).json();
  assert.equal(back.readCursors[ME], 2);
});

test("a read cursor past the thread seq is clamped to what exists", async () => {
  const env = await setup();
  await call(env, "POST", { workspaceId: WORKSPACE_ID, text: "only one" });
  const read = await (await call(env, "PATCH", { workspaceId: WORKSPACE_ID, action: "read", seq: 999 })).json();
  assert.equal(read.readCursors[ME], 1);
});

test("an E2EE room rejects a plaintext message", async () => {
  const env = await setup({ settings: { roomE2eeEnabled: true } });
  const res = await call(env, "POST", { workspaceId: WORKSPACE_ID, text: "plaintext" });
  assert.equal(res.status, 400);
});

test("GET returns the thread and supports the after cursor", async () => {
  const env = await setup();
  await call(env, "POST", { workspaceId: WORKSPACE_ID, text: "one" });
  await call(env, "POST", { workspaceId: WORKSPACE_ID, text: "two" });
  const all = await (await call(env, "GET", null)).json();
  assert.equal(all.messages.length, 2);
  const afterRes = await chat({
    request: new Request(`http://localhost/api/chat?workspaceId=${WORKSPACE_ID}&after=1`, { method: "GET" }),
    env,
  });
  const after = await afterRes.json();
  assert.equal(after.messages.length, 1);
  assert.equal(after.messages[0].text, "two");
});
