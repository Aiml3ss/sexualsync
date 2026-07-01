import { test } from "node:test";
import assert from "node:assert/strict";
import { attentionCountFor } from "../../functions/api/_attention.js";
import { mutatePlatformState } from "../../functions/api/_workspaces.js";
import { mutateKey } from "../../functions/api/_state.js";
import { makeStateEnv } from "./helpers.mjs";

// The badge count is for the RECIPIENT (the partner who receives the push).
const ME = "me@example.test";
const PARTNER = "partner@example.test";
const WS = "w1";
const REQUEST_STORE = "sexualsync-request-board";
const FANTASY_STORE = "sexualsync-ideas";

const member = (email, role = "partner") => ({ email, role, status: "active", displayName: email.split("@")[0] });

async function setup() {
  const env = makeStateEnv();
  await mutatePlatformState(env, () => ({
    profiles: [
      { id: "p1", email: ME, displayName: "Me" },
      { id: "p2", email: PARTNER, displayName: "Partner" },
    ],
    workspaces: [{
      id: WS, name: "Room", displayName: "Room", status: "active",
      productMode: "couples", members: [member(ME, "owner"), member(PARTNER)], settings: {},
    }],
    invites: [],
  }));
  return env;
}

const PILE_STORE = "sexualsync-pile";
const FUTURE = "2999-01-01T00:00:00.000Z";

const seedRequests = (env, list) => mutateKey(env, REQUEST_STORE, `requests:${WS}`, () => ({ value: list }));
const seedIdeas = (env, list) => mutateKey(env, FANTASY_STORE, `ideas:${WS}`, () => ({ value: list }));
const seedPile = (env, pile) => mutateKey(env, PILE_STORE, `pile:${WS}:active`, () => ({ value: pile }));

const req = (id, o = {}) => ({ id, workspaceId: WS, status: "sent", requesterEmail: PARTNER, reviewerEmail: ME, createdAt: "2026-01-01T00:00:00.000Z", ...o });
const idea = (id, o = {}) => ({ id, workspaceId: WS, addedByEmail: PARTNER, text: "x", tags: [], comments: [], reactions: [], statusHistory: [], createdAt: "2026-01-01T00:00:00.000Z", ...o });

test("attentionCountFor counts asks awaiting me + kinks needing my response (not mine, not answered)", async () => {
  const env = await setup();
  await seedRequests(env, [
    req("r1"),                                       // sent, I'm reviewer → counts
    req("r2", { status: "pending" }),                // pending, I'm reviewer → counts
    req("r3", { status: "completed" }),              // done → no
    req("r4", { reviewerEmail: PARTNER, requesterEmail: ME }), // I'm the requester → no
  ]);
  await seedIdeas(env, [
    idea("k1"),                                      // partner's, unanswered → counts
    idea("k2", { reactions: [{ by: ME, label: "Hell yeah" }] }), // I already reacted (valid catalog label) → no
    idea("k3", { addedByEmail: ME }),                // mine → no
  ]);

  assert.equal(await attentionCountFor(env, WS, ME), 3, "2 replyable asks I review + 1 unanswered partner kink");
});

test("attentionCountFor returns 0 when nothing needs me", async () => {
  const env = await setup();
  await seedRequests(env, [req("r1", { status: "completed" })]);
  await seedIdeas(env, [idea("k1", { addedByEmail: ME })]);
  assert.equal(await attentionCountFor(env, WS, ME), 0);
});

test("attentionCountFor is 0 for a blank/unknown recipient", async () => {
  const env = await setup();
  await seedRequests(env, [req("r1")]);
  assert.equal(await attentionCountFor(env, WS, ""), 0);
});

// Regression: the push badge previously counted only asks + kinks, so an active
// Pile / Blind Reveal needing the recipient showed as a lower number on the
// home-screen icon than the app's "Needs you" list. The badge must include them.
test("attentionCountFor counts an active Pile when I haven't dropped my acts", async () => {
  const env = await setup();
  // Partner dropped, I haven't, reveal still in the future → it needs me.
  await seedPile(env, { workspaceId: WS, revealAt: FUTURE, contributions: { [PARTNER]: ["Slow undressing"] } });
  assert.equal(await attentionCountFor(env, WS, ME), 1, "an active Pile with no drops from me counts toward the badge");
});

test("attentionCountFor does not count a Pile I've already dropped into (pre-reveal)", async () => {
  const env = await setup();
  // Both dropped, reveal still ahead → it's waiting on my partner, not me.
  await seedPile(env, { workspaceId: WS, revealAt: FUTURE, contributions: { [ME]: ["Slow undressing"], [PARTNER]: ["Shower together"] } });
  assert.equal(await attentionCountFor(env, WS, ME), 0, "once I've dropped, the Pile waits on my partner");
});

test("attentionCountFor adds the Pile on top of asks + kinks", async () => {
  const env = await setup();
  await seedRequests(env, [req("r1")]);                        // 1 ask awaiting me
  await seedIdeas(env, [idea("k1")]);                          // 1 kink needing me
  await seedPile(env, { workspaceId: WS, revealAt: FUTURE, contributions: { [PARTNER]: ["x"] } }); // + Pile
  assert.equal(await attentionCountFor(env, WS, ME), 3, "ask + kink + active Pile = 3");
});

// Regression: the Sexboard surfaces a Sex Quiz / Green Lights "Take it" handoff
// when the partner finished and you haven't, so the push badge must count it too
// (badge parity with web/src/app/sexboard/_sexboard-body.tsx buildHandoffs()).
const QUIZ_STORE = "sexualsync-sex-quiz";
const GL_STORE = "sexualsync-green-lights";
const SUBMITTED = "2026-01-01T00:00:00.000Z";
const submittedEntry = (email) => ({ email, name: email, submittedAt: SUBMITTED, ratings: {}, answers: {}, topPicks: [] });
const seedQuiz = (env, entries) => mutateKey(env, QUIZ_STORE, `sexQuiz:${WS}`, () => ({ value: { workspaceId: WS, status: "open", entries, fullReveal: {}, createdAt: SUBMITTED, updatedAt: SUBMITTED, revealedAt: "" } }));
const seedGL = (env, entries) => mutateKey(env, GL_STORE, `greenLights:${WS}`, () => ({ value: { workspaceId: WS, status: "open", entries, createdAt: SUBMITTED, updatedAt: SUBMITTED, revealedAt: "" } }));

test("attentionCountFor counts a Sex Quiz / Green Lights my partner finished and I haven't", async () => {
  const env = await setup();
  await seedQuiz(env, { [PARTNER]: submittedEntry(PARTNER) }); // partner in, I'm not → +1
  await seedGL(env, { [PARTNER]: submittedEntry(PARTNER) });   // partner in, I'm not → +1
  assert.equal(await attentionCountFor(env, WS, ME), 2, "quiz + green lights each need me");
});

test("attentionCountFor does not count a game I've already submitted", async () => {
  const env = await setup();
  await seedQuiz(env, { [ME]: submittedEntry(ME), [PARTNER]: submittedEntry(PARTNER) }); // both in → 0
  await seedGL(env, { [ME]: submittedEntry(ME) }); // I'm in, partner isn't → waiting on partner, not me → 0
  assert.equal(await attentionCountFor(env, WS, ME), 0, "submitted-by-me games never nag me");
});
