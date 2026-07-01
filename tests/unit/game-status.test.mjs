// Two-user journey + double-blind privacy coverage for the Sex Quiz and Green
// Lights games — previously the only two core game handlers with NO unit test.
//
// Drives the REAL onRequest handlers for both partners (signed session tokens,
// CAS-backed env) through the full blind->submit->reveal loop, then asserts:
//   1. readSexQuizStatus / readGreenLightsStatus (the Sexboard handoff + push
//      badge readers) report the right needs-you / waiting / revealed state.
//   2. The double-blind contract holds: a partner's answers are NEVER exposed
//      until BOTH have submitted, and the status readers carry no answer data
//      at all — even after reveal.
//   3. A workspace with 3+ active members never reveals (the ambiguous-partner
//      defense in publicQuiz / the status readers).

import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest as quizRequest, readSexQuizStatus, publicQuiz } from "../../functions/api/sex-quiz.js";
import { onRequest as glRequest, readGreenLightsStatus, publicGreenLights } from "../../functions/api/green-lights.js";
import { mutatePlatformState } from "../../functions/api/_workspaces.js";
import { mutateKey, readKey } from "../../functions/api/_state.js";
import { makeSessionToken, makeStateEnv } from "./helpers.mjs";

const ME = "me@example.test";
const PARTNER = "jordan@example.test";
const THIRD = "third@example.test";
const WS = "w1";
const APP_SESSION_SECRET = "game-status-test-session-secret-1234567890";
const QUIZ_STORE = "sexualsync-sex-quiz";
const GL_STORE = "sexualsync-green-lights";
const QUIZ_KEY = `sexQuiz:${WS}`;
const GL_KEY = `greenLights:${WS}`;

const member = (email, role, displayName) => ({ email, role, status: "active", displayName });
const COUPLE = [member(ME, "owner", "Me"), member(PARTNER, "partner", "Jordan")];
const workspace = { id: WS, name: "Room", displayName: "Room", status: "active", productMode: "couples", members: COUPLE, settings: {} };

async function setup(members = COUPLE) {
  const e = makeStateEnv();
  e.ALLOW_LOCAL_PREVIEW = "1";
  await mutatePlatformState(e, () => ({
    profiles: members.map((m, i) => ({ id: `p${i + 1}`, email: m.email, displayName: m.displayName })),
    workspaces: [{ ...workspace, members }],
    invites: [],
  }));
  return e;
}

// Drive a game handler as a specific signed-in partner (mirrors the real cookie
// session the browser sends; lets us submit as ME vs PARTNER independently).
async function submitAs(handler, e, email, body) {
  e.APP_SESSION_SECRET = APP_SESSION_SECRET;
  e.PUBLIC_SIGNUPS_OPEN = "1";
  const now = Math.floor(Date.now() / 1000);
  const token = await makeSessionToken(APP_SESSION_SECRET, {
    sid: `test-${email}`, provider: "email", email, name: email, iat: now, exp: now + 3600,
  });
  return handler({
    request: new Request("https://app.example.test/api/game", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `sxs-session=${encodeURIComponent(token)}` },
      body: JSON.stringify({ workspaceId: WS, action: "submit", ...body }),
    }),
    env: e,
  });
}

const STATUS_KEYS = ["mySubmitted", "partnerSubmitted", "revealed", "status"];

test("Sex Quiz: partner-first stays blind until I submit, then reveals matches", async () => {
  const e = await setup();

  // Nothing started → neither side needs anyone.
  assert.deepEqual(
    await readSexQuizStatus(e, workspace, ME),
    { status: "open", mySubmitted: false, partnerSubmitted: false, revealed: false },
  );

  // Partner submits first (likes c1, passes c2).
  const pRes = await submitAs(quizRequest, e, PARTNER, {
    ratings: { c1: { interest: "into" }, c2: { interest: "pass" } }, topPicks: ["c1"],
  });
  assert.equal(pRes.status, 200, "partner submit accepted");

  // Now it NEEDS ME (partner in, I'm not) and nothing is revealed yet.
  assert.deepEqual(
    await readSexQuizStatus(e, workspace, ME),
    { status: "open", mySubmitted: false, partnerSubmitted: true, revealed: false },
    "partner submitted, I haven't -> needs me, still blind",
  );

  // PRIVACY: before I submit, my view must leak nothing about the partner.
  const blindRecord = await readKey(e, QUIZ_STORE, QUIZ_KEY);
  const blindView = publicQuiz(blindRecord, workspace, ME);
  assert.equal(blindView.status, "open", "not revealed pre-submit");
  assert.deepEqual(blindView.matches, [], "no matches leaked pre-submit");
  assert.equal(blindView.partnerRatings, null, "partner ratings hidden pre-submit");
  assert.deepEqual(blindView.partnerTopPicks, [], "partner top picks hidden pre-submit");
  assert.equal(blindView.syncScore, null, "no sync score pre-submit");

  // I submit (also into c1) → both in → reveal opens.
  const myRes = await submitAs(quizRequest, e, ME, {
    ratings: { c1: { interest: "into" }, c2: { interest: "into" } }, topPicks: ["c1"],
  });
  assert.equal(myRes.status, 200, "my submit accepted");

  const revealed = await readSexQuizStatus(e, workspace, ME);
  assert.deepEqual(revealed, { status: "revealed", mySubmitted: true, partnerSubmitted: true, revealed: true });
  // The handoff/badge reader NEVER carries answer data, even after reveal.
  assert.deepEqual(Object.keys(revealed).sort(), STATUS_KEYS, "status reader exposes booleans only");

  // Post-reveal my view computes the shared "into" match (c1).
  const openRecord = await readKey(e, QUIZ_STORE, QUIZ_KEY);
  const openView = publicQuiz(openRecord, workspace, ME);
  assert.equal(openView.status, "revealed");
  assert.deepEqual(openView.matches.map((m) => m.cardId), ["c1"], "c1 is the both-into match");
  assert.notEqual(openView.syncScore, null, "sync score computed once revealed");
});

test("Green Lights: my submit first leaves me waiting, partner's submit reveals", async () => {
  const e = await setup();

  // I answer first → I'm waiting on the partner; still blind.
  const myRes = await submitAs(glRequest, e, ME, { answers: { q1: { value: "agree" }, q2: { value: "depends" } } });
  assert.equal(myRes.status, 200, "my submit accepted");
  assert.deepEqual(
    await readGreenLightsStatus(e, workspace, ME),
    { status: "open", mySubmitted: true, partnerSubmitted: false, revealed: false },
    "I'm in, partner isn't -> waiting on partner",
  );
  // Mirror side: from the partner's seat it NEEDS them.
  assert.deepEqual(
    await readGreenLightsStatus(e, workspace, PARTNER),
    { status: "open", mySubmitted: false, partnerSubmitted: true, revealed: false },
  );

  // PRIVACY: partner's view leaks nothing of mine before they answer.
  const blindRecord = await readKey(e, GL_STORE, GL_KEY);
  const partnerBlind = publicGreenLights(blindRecord, workspace, PARTNER);
  assert.equal(partnerBlind.status, "open", "not revealed pre-submit");
  assert.equal(Object.keys(partnerBlind.partnerAnswers).length, 0, "my answers hidden from partner pre-submit");

  // Partner answers → both in → reveal opens for both.
  const pRes = await submitAs(glRequest, e, PARTNER, { answers: { q1: { value: "agree" }, q2: { value: "agree" } } });
  assert.equal(pRes.status, 200, "partner submit accepted");

  const revealed = await readGreenLightsStatus(e, workspace, ME);
  assert.deepEqual(revealed, { status: "revealed", mySubmitted: true, partnerSubmitted: true, revealed: true });
  assert.deepEqual(Object.keys(revealed).sort(), STATUS_KEYS, "status reader exposes booleans only");
});

// Belt-and-suspenders matrix: seed the store directly and confirm both readers
// map every (mine, partner) combination to the right needs-you / waiting state.
test("status readers map every submission combination", async () => {
  const entry = (email, submitted) => ({ email, name: email, submittedAt: submitted ? "2026-06-01T00:00:00.000Z" : "" });
  const seed = async (e, store, key, mineIn, partnerIn, status = "open") =>
    mutateKey(e, store, key, () => ({
      value: {
        workspaceId: WS, status,
        entries: { [ME]: entry(ME, mineIn), [PARTNER]: entry(PARTNER, partnerIn) },
        createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z",
        revealedAt: status === "revealed" ? "2026-06-01T00:00:00.000Z" : "",
      },
    }));

  for (const [reader, store, key] of [
    [readSexQuizStatus, QUIZ_STORE, QUIZ_KEY],
    [readGreenLightsStatus, GL_STORE, GL_KEY],
  ]) {
    const e = await setup();
    await seed(e, store, key, false, false);
    assert.deepEqual((await reader(e, workspace, ME)), { status: "open", mySubmitted: false, partnerSubmitted: false, revealed: false });
    await seed(e, store, key, true, false);
    assert.deepEqual((await reader(e, workspace, ME)), { status: "open", mySubmitted: true, partnerSubmitted: false, revealed: false }, "waiting on partner");
    await seed(e, store, key, false, true);
    assert.deepEqual((await reader(e, workspace, ME)), { status: "open", mySubmitted: false, partnerSubmitted: true, revealed: false }, "needs me");
    await seed(e, store, key, true, true, "revealed");
    assert.deepEqual((await reader(e, workspace, ME)), { status: "revealed", mySubmitted: true, partnerSubmitted: true, revealed: true });
  }
});

// A workspace with 3+ active members has an ambiguous "partner", so the reveal
// must never open — defends the double-blind even if an extra member slips in.
test("3+ active members never reveal (ambiguous-partner defense)", async () => {
  const members = [...COUPLE, member(THIRD, "partner", "Third")];
  const ws = { ...workspace, members };
  const e = await setup(members);
  // Everyone submits.
  for (const who of [ME, PARTNER, THIRD]) {
    await submitAs(quizRequest, e, who, { ratings: { c1: { interest: "into" } } });
  }
  const status = await readSexQuizStatus(e, ws, ME);
  assert.equal(status.revealed, false, "never reveal with an ambiguous third member");
  const view = publicQuiz(await readKey(e, QUIZ_STORE, QUIZ_KEY), ws, ME);
  assert.deepEqual(view.matches, [], "no overlap exposed with 3+ members");
  assert.equal(view.partnerRatings, null);
});
