import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest as fantasy, readFantasyBacklogForWorkspace } from "../../functions/api/fantasy-backlog.js";
import { mutatePlatformState } from "../../functions/api/_workspaces.js";
import { mutateKey, readKey } from "../../functions/api/_state.js";
import { makeStateEnv } from "./helpers.mjs";

const ME = "local-preview@example.test";
const PARTNER = "partner@example.test";
const STORE = "sexualsync-ideas";
const WORKSPACE_ID = "w1";
const IDEAS_KEY = `ideas:${WORKSPACE_ID}`;
const GRAVEYARD_KEY = `graveyard:${WORKSPACE_ID}`;
const NOW = new Date().toISOString();

const member = (email, role = "partner") => ({
  email,
  role,
  status: "active",
  displayName: email.split("@")[0],
});

function idea(id, overrides = {}) {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    text: "Private idea",
    tags: [],
    addedByEmail: ME,
    addedByName: "local-preview",
    createdAt: NOW,
    updatedAt: NOW,
    comments: [],
    reactions: [],
    statusHistory: [],
    ...overrides,
  };
}

async function setup(ideas = []) {
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
      settings: {},
    }],
    invites: [],
  }));
  if (ideas.length) await mutateKey(env, STORE, IDEAS_KEY, () => ({ value: ideas }));
  return env;
}

const call = (env, method, body, headers = {}) => fantasy({
  request: new Request("http://localhost/api/fantasy-backlog", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }),
  env,
});

async function readIdeas(env) {
  return (await readKey(env, STORE, IDEAS_KEY)) || [];
}

async function readGraveyard(env) {
  return (await readKey(env, STORE, GRAVEYARD_KEY)) || [];
}

test("a partner cannot archive someone else's kink directly through the API", async () => {
  const env = await setup([idea("i1", {
    addedByEmail: PARTNER,
    addedByName: "Partner",
  })]);

  const res = await call(env, "DELETE", { workspaceId: WORKSPACE_ID, id: "i1" });
  assert.equal(res.status, 403);
  assert.equal((await readIdeas(env)).length, 1);
  assert.equal((await readGraveyard(env)).length, 0);
});

test("a partner cannot restore someone else's archived kink", async () => {
  const env = await setup();
  await mutateKey(env, STORE, GRAVEYARD_KEY, () => ({
    value: [idea("i1", {
      addedByEmail: PARTNER,
      addedByName: "Partner",
      deletedAt: NOW,
      deletedByEmail: PARTNER,
    })],
  }));

  const res = await call(env, "PATCH", { workspaceId: WORKSPACE_ID, id: "i1", action: "restore" });

  assert.equal(res.status, 403);
  assert.equal((await readIdeas(env)).length, 0);
  const graveyard = await readGraveyard(env);
  assert.equal(graveyard.length, 1);
  assert.equal(graveyard[0].id, "i1");
});

test("replaying a queued kink create with the same idempotency key does not duplicate it", async () => {
  const env = await setup();
  const body = { workspaceId: WORKSPACE_ID, text: "Try blindfolds" };
  const headers = { "idempotency-key": "queued-kink-create-1" };

  const first = await call(env, "POST", body, headers);
  assert.equal(first.status, 201);
  const firstBody = await first.json();

  const second = await call(env, "POST", body, headers);
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.idempotent, true);
  assert.equal(secondBody.idea.id, firstBody.idea.id);

  const ideas = await readIdeas(env);
  assert.equal(ideas.length, 1);
  assert.equal(ideas[0].id, firstBody.idea.id);
});

test("replaying a queued kink comment with the same idempotency key does not duplicate it", async () => {
  const env = await setup([idea("i1", {
    addedByEmail: PARTNER,
    addedByName: "Partner",
  })]);
  const body = { workspaceId: WORKSPACE_ID, id: "i1", comment: "Yes, curious." };
  const headers = { "idempotency-key": "queued-kink-comment-1" };

  const first = await call(env, "PATCH", body, headers);
  assert.equal(first.status, 200);
  const second = await call(env, "PATCH", body, headers);
  assert.equal(second.status, 200);

  const ideas = await readIdeas(env);
  assert.equal(ideas[0].comments.length, 1);
  assert.equal(ideas[0].comments[0].text, "Yes, curious.");
});

test("a kink comment author can edit their own comment", async () => {
  const env = await setup([idea("i1", {
    addedByEmail: PARTNER,
    addedByName: "Partner",
    comments: [{
      id: "c1",
      email: ME,
      name: "Me",
      text: "Original thought",
      at: NOW,
    }],
  })]);

  const res = await call(env, "PATCH", {
    workspaceId: WORKSPACE_ID,
    id: "i1",
    action: "update_comment",
    commentId: "c1",
    comment: "Edited thought",
  });
  assert.equal(res.status, 200);

  const ideas = await readIdeas(env);
  assert.equal(ideas[0].comments.length, 1);
  assert.equal(ideas[0].comments[0].text, "Edited thought");
  assert.equal(ideas[0].comments[0].editedByEmail, ME);
  assert.ok(ideas[0].comments[0].editedAt);
});

test("a partner cannot edit someone else's kink comment", async () => {
  const env = await setup([idea("i1", {
    addedByEmail: PARTNER,
    addedByName: "Partner",
    comments: [{
      id: "c1",
      email: PARTNER,
      name: "Partner",
      text: "Leave this alone",
      at: NOW,
    }],
  })]);

  const res = await call(env, "PATCH", {
    workspaceId: WORKSPACE_ID,
    id: "i1",
    action: "update_comment",
    commentId: "c1",
    comment: "Edited by the wrong person",
  });
  assert.equal(res.status, 403);

  const ideas = await readIdeas(env);
  assert.equal(ideas[0].comments[0].text, "Leave this alone");
});

test("the kink author can archive their own kink", async () => {
  const env = await setup([idea("i1")]);

  const res = await call(env, "DELETE", { workspaceId: WORKSPACE_ID, id: "i1" });
  assert.equal(res.status, 200);
  assert.equal((await readIdeas(env)).length, 0);
  const graveyard = await readGraveyard(env);
  assert.equal(graveyard.length, 1);
  assert.equal(graveyard[0].deletedByEmail, ME);
});

test("an archived kink that still lingers in the legacy global ideas key is NOT resurrected on read", async () => {
  // Reproduces "I archived them but they still show": rows that predate the
  // per-workspace keying live in the legacy global "ideas" key, which the read
  // unions in as a fallback. Archiving removes the row from the per-workspace
  // key and tombstones it in the graveyard, but deliberately never rewrites the
  // legacy key — so the read boundary must drop tombstoned ideas itself.
  const env = await setup();
  // Seed the row ONLY in the legacy global key (bare "ideas"), as a pre-migration row would be.
  await mutateKey(env, STORE, "ideas", () => ({ value: [idea("legacy-1"), idea("legacy-2")] }));

  // Archive one of them through the real API.
  const res = await call(env, "DELETE", { workspaceId: WORKSPACE_ID, id: "legacy-1" });
  assert.equal(res.status, 200);

  // The canonical Sexboard/bootstrap read must not show the archived idea, even
  // though its stale copy is still sitting in the legacy global key.
  const view = await readFantasyBacklogForWorkspace(env, WORKSPACE_ID, ME, { workspaceIds: [WORKSPACE_ID] });
  const activeIds = view.ideas.map((i) => i.id).sort();
  assert.deepEqual(activeIds, ["legacy-2"], "archived legacy idea resurrected into active ideas");
  assert.ok(view.graveyard.some((i) => i.id === "legacy-1"), "archived idea should be tombstoned in the graveyard");
  // The legacy global key is a read-only fallback — archiving must not rewrite it.
  assert.equal((await readKey(env, STORE, "ideas")).length, 2, "legacy global ideas key should be left untouched");
});
