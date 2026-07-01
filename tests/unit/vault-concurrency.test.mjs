// Handler-level concurrency tests for the Vault, parallel to the
// request-board ones. Without the CAS coordinator wrapping the per-workspace
// vault list, two concurrent PATCHes (reactions on different clips, or a
// reaction + comment on different clips) would silently lose one write.

import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest as vault } from "../../functions/api/vault.js";
import { mutatePlatformState } from "../../functions/api/_workspaces.js";
import { mutateKey, readKey } from "../../functions/api/_state.js";
import { makeStateEnv } from "./helpers.mjs";

const ME = "local-preview@example.test";
const PARTNER = "partner@example.test";
const STORE = "sexualsync-vault";
const KEY = "vault:w1";

async function setup(items = []) {
  const e = makeStateEnv();
  e.ALLOW_LOCAL_PREVIEW = "1";
  await mutatePlatformState(e, () => ({
    profiles: [
      { id: "p1", email: ME, displayName: "Me" },
      { id: "p2", email: PARTNER, displayName: "Partner" }
    ],
    workspaces: [{
      id: "w1", name: "Room", displayName: "Room", status: "active", productMode: "couples",
      members: [
        { email: ME, role: "owner", status: "active", displayName: "Me" },
        { email: PARTNER, role: "partner", status: "active", displayName: "Partner" }
      ],
      settings: {}
    }],
    invites: []
  }));
  if (items.length) await mutateKey(e, STORE, KEY, () => ({ value: items }));
  return e;
}

const now = () => new Date().toISOString();

const vaultItem = (id, overrides = {}) => ({
  id,
  workspaceId: "w1",
  mediaKey: `vault/w1/${id}/video.enc`,
  mediaType: "video/mp4",
  mediaSize: 1024,
  durationMs: 1000,
  addedByEmail: PARTNER,
  addedByName: "Partner",
  addedAt: now(),
  updatedAt: now(),
  encryption: {
    version: "v1",
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA-256",
    iterations: 210000,
    salt: "c2FsdA",
    videoIv: "aXY"
  },
  displayTitle: id,
  title: { ciphertext: "Y3Q", iv: "aXY" },
  reactions: {},
  comments: [],
  moments: [],
  ...overrides
});

const call = (e, method, body, headers = {}) => vault({
  request: new Request("http://localhost/api/vault", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  }),
  env: e
});

async function readVaultRaw(e) {
  return (await readKey(e, STORE, KEY)) || [];
}

test("vault PATCH: concurrent reactions on different clips do NOT lose updates", async () => {
  const e = await setup([vaultItem("i1"), vaultItem("i2")]);

  const [a, b] = await Promise.all([
    call(e, "PATCH", { workspaceId: "w1", id: "i1", reaction: "fire" }),
    call(e, "PATCH", { workspaceId: "w1", id: "i2", reaction: "drool" })
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const stored = await readVaultRaw(e);
  const r1 = stored.find((it) => it.id === "i1").reactions[ME];
  const r2 = stored.find((it) => it.id === "i2").reactions[ME];
  assert.equal(r1, "fire", "i1's reaction must persist");
  assert.equal(r2, "drool", "i2's reaction must persist — both writes must survive");
});

test("vault PATCH: concurrent comment on one clip + reaction on another both survive", async () => {
  const e = await setup([vaultItem("i1"), vaultItem("i2")]);

  const comment = { ciphertext: "Y2lwaGVydGV4dA", iv: "aXY" };
  const [a, b] = await Promise.all([
    call(e, "PATCH", { workspaceId: "w1", id: "i1", action: "comment", comment }),
    call(e, "PATCH", { workspaceId: "w1", id: "i2", reaction: "wrecked" })
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const stored = await readVaultRaw(e);
  const i1 = stored.find((it) => it.id === "i1");
  const i2 = stored.find((it) => it.id === "i2");
  assert.equal(i1.comments.length, 1, "the comment on i1 must persist");
  assert.equal(i2.reactions[ME], "wrecked", "the reaction on i2 must persist");
});

test("vault PATCH: replaying a queued comment with the same idempotency key does not duplicate it", async () => {
  const e = await setup([vaultItem("i1")]);
  const comment = { ciphertext: "Y2lwaGVydGV4dA", iv: "aXY" };
  const headers = { "idempotency-key": "queued-vault-comment-1" };

  const first = await call(e, "PATCH", { workspaceId: "w1", id: "i1", action: "comment", comment }, headers);
  assert.equal(first.status, 200);
  const second = await call(e, "PATCH", { workspaceId: "w1", id: "i1", action: "comment", comment }, headers);
  assert.equal(second.status, 200);

  const stored = await readVaultRaw(e);
  const i1 = stored.find((it) => it.id === "i1");
  assert.equal(i1.comments.length, 1);
  assert.equal(i1.comments[0].body.ciphertext, comment.ciphertext);
});

test("vault PATCH on a missing item returns 404 without writing", async () => {
  const e = await setup([vaultItem("i1")]);
  const res = await call(e, "PATCH", { workspaceId: "w1", id: "nope", reaction: "fire" });
  assert.equal(res.status, 404);
  const stored = await readVaultRaw(e);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].reactions, {});
});
