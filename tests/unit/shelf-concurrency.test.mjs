// Handler-level concurrency tests for the Inspiration Shelf, parallel to the
// vault + request-board CAS tests. Without the CAS coordinator wrapping the
// per-workspace shelf list, two partners reacting on different tiles at once
// (or a save racing a reaction) would silently lose one write.

import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest as shelf } from "../../functions/api/shelf.js";
import { mutatePlatformState } from "../../functions/api/_workspaces.js";
import { mutateKey, readKey } from "../../functions/api/_state.js";
import { makeStateEnv } from "./helpers.mjs";

const ME = "local-preview@example.test";
const PARTNER = "partner@example.test";
const STORE = "sexualsync-shelf";
const KEY = "shelf:w1";

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

const shelfItem = (id, overrides = {}) => ({
  id,
  type: "story",
  source: "url",
  sourceUrl: `https://example.test/${id}`,
  embedUrl: "",
  posterUrl: "",
  videoHdUrl: "",
  videoSdUrl: "",
  passageText: "",
  title: id,
  addedByEmail: PARTNER,
  addedByName: "Partner",
  addedAt: now(),
  reactions: {},
  ...overrides
});

const call = (e, method, body) => shelf({
  request: new Request("http://localhost/api/shelf", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }),
  env: e
});

async function readShelfRaw(e) {
  return (await readKey(e, STORE, KEY)) || [];
}

test("shelf PATCH: concurrent reactions on different tiles do NOT lose updates", async () => {
  const e = await setup([shelfItem("s1"), shelfItem("s2")]);

  const [a, b] = await Promise.all([
    call(e, "PATCH", { workspaceId: "w1", id: "s1", reaction: "fire" }),
    call(e, "PATCH", { workspaceId: "w1", id: "s2", reaction: "drool" })
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const stored = await readShelfRaw(e);
  const r1 = stored.find((it) => it.id === "s1").reactions[ME];
  const r2 = stored.find((it) => it.id === "s2").reactions[ME];
  assert.equal(r1, "fire", "s1's reaction must persist");
  assert.equal(r2, "drool", "s2's reaction must persist — both writes must survive");
});

test("shelf POST: concurrent saves both land", async () => {
  const e = await setup();
  const [a, b] = await Promise.all([
    call(e, "POST", { workspaceId: "w1", content: "https://example.test/a", title: "A" }),
    call(e, "POST", { workspaceId: "w1", content: "https://example.test/b", title: "B" })
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const stored = await readShelfRaw(e);
  const aPresent = stored.some((it) => it.sourceUrl === "https://example.test/a");
  const bPresent = stored.some((it) => it.sourceUrl === "https://example.test/b");
  assert.ok(aPresent && bPresent, "both saves must survive the race");
});

test("shelf DELETE non-owner is rejected without affecting other tiles", async () => {
  // PARTNER owns both tiles. Local-preview (ME) tries to delete one — should
  // 403 without erasing or perturbing the other.
  const e = await setup([shelfItem("s1"), shelfItem("s2")]);
  const res = await call(e, "DELETE", { workspaceId: "w1", id: "s1" });
  assert.equal(res.status, 403);
  const stored = await readShelfRaw(e);
  assert.equal(stored.length, 2, "no tile should be removed by a non-owner attempt");
});
