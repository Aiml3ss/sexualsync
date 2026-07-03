// Handler-level tests for the requests-store conversion. Runs the real
// request-board onRequest against a CAS-backed env via the local-preview
// identity, with a two-partner workspace seeded so requests can be sent.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { onRequest as board, readRequestBoardForWorkspace } from "../../functions/api/request-board.js";
import { mutatePlatformState } from "../../functions/api/_workspaces.js";
import { mutateKey, readKey } from "../../functions/api/_state.js";
import { makeSessionToken, makeStateEnv } from "./helpers.mjs";

const ME = "local-preview@example.test";
const PARTNER = "partner@example.test";
const THIRD = "third@example.test";
const APP_SESSION_SECRET = "request-board-test-session-secret-123456";
const REQ_STORE = "sexualsync-request-board";
const WORKSPACE_ID = "w1";
// C3 — requests are keyed per workspace. Tests seed and read back the
// per-workspace key (`requests:${WORKSPACE_ID}`); the runtime writes only there.
const REQ_KEY = `requests:${WORKSPACE_ID}`;

async function setup(requests = [], extraMembers = []) {
  const e = makeStateEnv();
  e.ALLOW_LOCAL_PREVIEW = "1";
  const members = [
    { email: ME, role: "owner", status: "active", displayName: "Me" },
    { email: PARTNER, role: "partner", status: "active", displayName: "Partner" },
    ...extraMembers,
  ];
  await mutatePlatformState(e, () => ({
    profiles: members.map((member, index) => ({
      id: `p${index + 1}`,
      email: member.email,
      displayName: member.displayName,
    })),
    workspaces: [{
      id: "w1", name: "Room", displayName: "Room", status: "active", productMode: "couples",
      members,
      settings: {},
    }],
    invites: [],
  }));
  if (requests.length) await mutateKey(e, REQ_STORE, REQ_KEY, () => ({ value: requests }));
  return e;
}

const NOW = new Date().toISOString();
const req = (id, overrides = {}) => ({
  id, workspaceId: "w1", status: "sent",
  requesterEmail: ME, reviewerEmail: PARTNER, requester: "Me", reviewer: "Partner",
  categories: ["Massage"], timing: "Tonight", filming: "No", decisions: [], counters: [],
  createdAt: NOW, updatedAt: NOW, sentAt: NOW,
  ...overrides,
});

const call = (e, method, body, headers = {}) => board({
  request: new Request("http://localhost/api/request-board", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }),
  env: e,
});

async function callAs(e, email, method, body) {
  e.APP_SESSION_SECRET = APP_SESSION_SECRET;
  e.PUBLIC_SIGNUPS_OPEN = "1";
  const now = Math.floor(Date.now() / 1000);
  const token = await makeSessionToken(APP_SESSION_SECRET, {
    sid: `test-${email}`,
    provider: "email",
    email,
    name: email,
    iat: now,
    exp: now + 3600,
  });
  return board({
    request: new Request("https://app.example.test/api/request-board", {
      method,
      headers: {
        "content-type": "application/json",
        cookie: `sxs-session=${encodeURIComponent(token)}`,
      },
      body: JSON.stringify(body),
    }),
    env: e,
  });
}

async function readRequests(e) {
  return (await readKey(e, REQ_STORE, REQ_KEY)) || [];
}

async function readTokens(e) {
  return (await readKey(e, "sexualsync-review-tokens", "tokens")) || [];
}

test("sending a new request creates it as pending with a review token", async () => {
  const e = await setup();
  const res = await call(e, "POST", { workspaceId: "w1", categories: ["Massage"], timing: "Tonight", status: "sent" });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.request.status, "pending");
  assert.ok(body.reviewToken && body.reviewToken.token, "a review token is minted");
  assert.match(body.reviewToken.reviewUrl, /^http:\/\/localhost\/review\?token=/);

  const stored = await readRequests(e);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, "pending");
});

test("replaying a queued Ask create with the same idempotency key does not duplicate or re-notify", async () => {
  const e = await setup();
  const body = { workspaceId: "w1", categories: ["Massage"], timing: "Tonight", status: "sent" };
  const headers = { "idempotency-key": "queued-ask-create-1" };

  const first = await call(e, "POST", body, headers);
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.equal(firstBody.request.status, "pending");
  assert.ok(firstBody.reviewToken?.token);

  const second = await call(e, "POST", body, headers);
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.emailResult?.reason, "idempotent-replay");
  assert.equal(secondBody.reviewToken, null);

  const stored = await readRequests(e);
  assert.equal(stored.length, 1, "only one Ask is stored");
  assert.equal(stored[0].id, firstBody.request.id);
  assert.equal(stored[0].reviewTokenId, firstBody.request.reviewTokenId);

  const tokens = await readTokens(e);
  assert.equal(tokens.length, 1, "only the original review token exists");
});

test("archiving a request transitions it to archived", async () => {
  const e = await setup([req("r1")]);
  const res = await call(e, "PATCH", { id: "r1", action: "archive", workspaceId: "w1" });
  assert.equal(res.status, 200);
  const stored = await readRequests(e);
  assert.equal(stored.find((r) => r.id === "r1").status, "archived");
});

test("either partner can pass an agreed request after it is on deck", async () => {
  const yesDecision = { label: "Massage", decision: "Yes", targetType: "act" };
  const e = await setup([
    req("mine", { status: "on_deck", decisions: [yesDecision] }),
    req("theirs", {
      status: "on_deck",
      requesterEmail: PARTNER,
      reviewerEmail: ME,
      requester: "Partner",
      reviewer: "Me",
      decisions: [yesDecision],
    }),
  ]);

  const mine = await call(e, "PATCH", { id: "mine", action: "pass", workspaceId: "w1" });
  const theirs = await call(e, "PATCH", { id: "theirs", action: "pass", workspaceId: "w1" });

  assert.equal(mine.status, 200);
  assert.equal(theirs.status, 200);
  const stored = await readRequests(e);
  assert.equal(stored.find((r) => r.id === "mine").status, "archived");
  assert.equal(stored.find((r) => r.id === "theirs").status, "archived");
  assert.equal(stored.find((r) => r.id === "mine").passedByEmail, ME);
  assert.equal(stored.find((r) => r.id === "theirs").passedByEmail, ME);
});

test("an active workspace member who is not requester or reviewer cannot change an Ask status", async () => {
  const yesDecision = { label: "Massage", decision: "Yes", targetType: "act" };
  const e = await setup(
    [req("r1", { status: "on_deck", decisions: [yesDecision] })],
    [{ email: THIRD, role: "partner", status: "active", displayName: "Third" }],
  );

  const res = await callAs(e, THIRD, "PATCH", { id: "r1", action: "completed", workspaceId: "w1" });

  assert.equal(res.status, 403);
  const stored = await readRequests(e);
  assert.equal(stored.find((r) => r.id === "r1").status, "on_deck");
  assert.equal(stored.find((r) => r.id === "r1").completedByEmail, undefined);
});

test("an agreed request can be completed and moves to history", async () => {
  const e = await setup([req("r1", {
    status: "on_deck",
    decisions: [{ label: "Massage", decision: "Yes", targetType: "act" }],
  })]);

  const res = await call(e, "PATCH", { id: "r1", action: "completed", workspaceId: "w1" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.request.status, "completed");
  assert.equal(body.activeRequests.find((r) => r.id === "r1"), undefined);
  assert.equal(body.history.find((r) => r.id === "r1").status, "completed");

  const stored = await readRequests(e);
  assert.equal(stored.find((r) => r.id === "r1").completedByEmail, ME);
});

test("revoking a pending request removes it (PATCH action=revoke)", async () => {
  const e = await setup([req("r1", { status: "pending" })]);
  const res = await call(e, "PATCH", { id: "r1", action: "revoke", workspaceId: "w1" });
  assert.equal(res.status, 200);
  const stored = await readRequests(e);
  assert.equal(stored.find((r) => r.id === "r1"), undefined);
});

test("revoking prunes the legacy global key so the board read can't resurrect it", async () => {
  // Regression: a pre-migration request that lives ONLY under the legacy global
  // "requests" key (not the per-workspace key). writeRequestsAtomic removes it
  // from the per-workspace key, but readRequests falls back to the legacy key
  // for any id it doesn't find there — so without an explicit legacy prune the
  // revoked Ask reappears on the next board load.
  const e = await setup(); // per-workspace key intentionally empty
  await mutateKey(e, REQ_STORE, "requests", () => ({ value: [req("r1", { status: "pending" })] }));

  const res = await call(e, "PATCH", { id: "r1", action: "revoke", workspaceId: "w1" });
  assert.equal(res.status, 200);

  const legacy = (await readKey(e, REQ_STORE, "requests")) || [];
  assert.equal(legacy.find((r) => r.id === "r1"), undefined, "legacy copy is pruned");

  const boardAfter = await readRequestBoardForWorkspace(e, "w1");
  assert.equal(boardAfter.requests.find((r) => r.id === "r1"), undefined, "request does not resurrect on board read");
});

test("assigned reviewer can reply to a sent request from Ask detail", async () => {
  const e = await setup([req("r1", {
    requesterEmail: PARTNER,
    reviewerEmail: ME,
    requester: "Partner",
    reviewer: "Me",
  })]);

  const res = await call(e, "PATCH", {
    id: "r1",
    action: "reply",
    workspaceId: "w1",
    decisions: [
      { label: "Counter option 1", decision: "Counter", counter: "Cuddle first", targetType: "act" },
      { label: "Timing: Tonight", decision: "Counter", counter: "Tomorrow", targetType: "timing" },
    ],
    note: "Slow start."
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.request.status, "reviewed");
  assert.equal(body.request.decisions[0].decision, "Counter");
  assert.equal(body.request.counters[0].counter, "Cuddle first");
  assert.equal(body.request.counters[1].counter, "Tomorrow");
  assert.equal(body.request.feedback, "Slow start.");

  const stored = await readRequests(e);
  const reviewed = stored.find((r) => r.id === "r1");
  assert.equal(reviewed.status, "reviewed");
  assert.equal(reviewed.reviewedByEmail, ME);
});

test("assigned reviewer can pass a sent request from Ask detail", async () => {
  const e = await setup([req("r1", {
    requesterEmail: PARTNER,
    reviewerEmail: ME,
    requester: "Partner",
    reviewer: "Me",
  })]);

  const res = await call(e, "PATCH", {
    id: "r1",
    action: "reply",
    workspaceId: "w1",
    decisions: [{ label: "Massage", decision: "No" }],
    note: "Not tonight."
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.request.status, "reviewed");
  assert.equal(body.request.decisions[0].decision, "No");
  assert.deepEqual(body.request.counters, []);
  assert.equal(body.request.feedback, "Not tonight.");
});

test("requester cannot use the direct reply action for their own sent request", async () => {
  const e = await setup([req("r1")]);
  const res = await call(e, "PATCH", {
    id: "r1",
    action: "reply",
    workspaceId: "w1",
    decisions: [{ label: "Massage", decision: "Yes" }]
  });
  assert.equal(res.status, 403);
});

test("reviewer can mark a sent Ask as maybe; it stays repliable and stamps maybeAt not reviewedAt", async () => {
  const e = await setup([req("r1", {
    requesterEmail: PARTNER, reviewerEmail: ME, requester: "Partner", reviewer: "Me",
  })]);

  const res = await call(e, "PATCH", { id: "r1", action: "maybe", workspaceId: "w1" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.request.status, "maybe");
  assert.equal(body.request.maybeByEmail, ME);
  assert.ok(body.request.maybeAt);
  // A maybe is NOT a final answer — no reviewedAt/decisions, so it still reads
  // as unanswered and stays available to convert.
  assert.equal(body.request.reviewedAt, undefined);
  assert.deepEqual(body.request.decisions, []);
  // Still surfaced as active (not history).
  assert.equal(body.activeRequests.some((r) => r.id === "r1"), true);

  const stored = await readRequests(e);
  assert.equal(stored.find((r) => r.id === "r1").status, "maybe");
});

test("requester cannot mark their own Ask as maybe", async () => {
  const e = await setup([req("r1")]); // ME is requester, PARTNER reviewer
  const res = await call(e, "PATCH", { id: "r1", action: "maybe", workspaceId: "w1" });
  assert.equal(res.status, 403);
});

test("cannot mark an already-reviewed Ask as maybe", async () => {
  const e = await setup([req("r1", {
    requesterEmail: PARTNER, reviewerEmail: ME, requester: "Partner", reviewer: "Me",
    status: "reviewed", reviewedByEmail: ME, reviewedAt: NOW,
    decisions: [{ label: "Massage", decision: "Yes", targetType: "act" }],
  })]);
  const res = await call(e, "PATCH", { id: "r1", action: "maybe", workspaceId: "w1" });
  assert.equal(res.status, 409);
});

test("a maybe can be converted to a real answer via reply (Decide now)", async () => {
  const e = await setup([req("r1", {
    requesterEmail: PARTNER, reviewerEmail: ME, requester: "Partner", reviewer: "Me",
    status: "maybe", maybeByEmail: ME, maybeAt: NOW,
  })]);

  const res = await call(e, "PATCH", {
    id: "r1", action: "reply", workspaceId: "w1",
    decisions: [{ label: "Massage", decision: "Yes", targetType: "act" }],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.request.status, "reviewed");
  assert.equal(body.request.decisions[0].decision, "Yes");
  assert.equal(body.request.reviewedByEmail, ME);
});

test("GET expires a maybe once its timing window passes", async () => {
  const oldSentAt = "2026-04-01T06:30:00.000Z";
  const now = "2026-06-06T15:00:00.000Z";
  const e = await setup([req("r-maybe-old", {
    requesterEmail: PARTNER, reviewerEmail: ME, requester: "Partner", reviewer: "Me",
    status: "maybe", timing: "Tomorrow",
    sentAt: oldSentAt, createdAt: oldSentAt, updatedAt: "2026-06-06T14:00:00.000Z",
    maybeByEmail: ME, maybeAt: "2026-04-01T07:00:00.000Z",
  })]);

  mock.timers.enable({ apis: ["Date"], now: new Date(now) });
  try {
    const res = await board({ request: new Request("http://localhost/api/request-board?workspaceId=w1"), env: e });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.activeRequests.some((r) => r.id === "r-maybe-old"), false);
    const expired = (await readRequests(e)).find((r) => r.id === "r-maybe-old");
    assert.equal(expired.status, "expired");
    assert.equal(expired.expiredReason, "unanswered_stale");
  } finally {
    mock.timers.reset();
  }
});

// THE core race: two different requests edited at once must both survive.
// Without the CAS coordinator, one blind write clobbers the other.
test("concurrent edits to different requests do NOT lose updates", async () => {
  const e = await setup([req("r1"), req("r2")]);

  const [a, b] = await Promise.all([
    call(e, "PATCH", { id: "r1", action: "archive", workspaceId: "w1" }),
    call(e, "PATCH", { id: "r2", action: "archive", workspaceId: "w1" }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const stored = await readRequests(e);
  assert.equal(stored.find((r) => r.id === "r1").status, "archived");
  assert.equal(stored.find((r) => r.id === "r2").status, "archived", "both archives must persist");
});

test("auto-expire on GET expires an agreed request past its timing window", async () => {
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const e = await setup([req("r1", {
    status: "on_deck",
    sentAt: threeDaysAgo,
    createdAt: threeDaysAgo,
    decisions: [{ label: "Massage", decision: "Yes", targetType: "act" }],
  })]);

  const res = await board({ request: new Request("http://localhost/api/request-board?workspaceId=w1"), env: e });
  assert.equal(res.status, 200);

  const stored = await readRequests(e);
  assert.equal(stored.find((r) => r.id === "r1").status, "expired");
});

test("pending Tomorrow request stays active through its response grace", async () => {
  const twoNightsAgo = "2026-06-05T06:30:00.000Z"; // Jun 4 11:30pm Los Angeles
  const morningAfterTomorrow = "2026-06-06T15:00:00.000Z"; // Jun 6 8:00am Los Angeles
  const e = await setup([req("r-pending-tomorrow", {
    status: "pending",
    timing: "Tomorrow",
    sentAt: twoNightsAgo,
    createdAt: twoNightsAgo,
    updatedAt: twoNightsAgo,
  })]);

  mock.timers.enable({ apis: ["Date"], now: new Date(morningAfterTomorrow) });
  try {
    const res = await board({ request: new Request("http://localhost/api/request-board?workspaceId=w1"), env: e });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.activeRequests.find((r) => r.id === "r-pending-tomorrow")?.status, "pending");

    const stored = await readRequests(e);
    assert.equal(stored.find((r) => r.id === "r-pending-tomorrow").status, "pending");
  } finally {
    mock.timers.reset();
  }
});

test("pending Tonight request expires by the next afternoon", async () => {
  const yesterdayAfternoon = "2026-06-07T23:52:00.000Z"; // Jun 7 4:52pm Los Angeles
  const nextMorning = "2026-06-08T15:00:00.000Z"; // Jun 8 8:00am Los Angeles
  const nextAfternoon = "2026-06-08T21:52:00.000Z"; // Jun 8 2:52pm Los Angeles
  const e = await setup([req("r-pending-tonight-next-day", {
    status: "pending",
    timing: "Tonight",
    sentAt: yesterdayAfternoon,
    createdAt: yesterdayAfternoon,
    updatedAt: yesterdayAfternoon,
  })]);

  mock.timers.enable({ apis: ["Date"], now: new Date(nextMorning) });
  try {
    const morningRes = await board({ request: new Request("http://localhost/api/request-board?workspaceId=w1"), env: e });
    assert.equal(morningRes.status, 200);
    const morningBody = await morningRes.json();
    assert.equal(morningBody.activeRequests.find((r) => r.id === "r-pending-tonight-next-day")?.status, "pending");
  } finally {
    mock.timers.reset();
  }

  mock.timers.enable({ apis: ["Date"], now: new Date(nextAfternoon) });
  try {
    const afternoonRes = await board({ request: new Request("http://localhost/api/request-board?workspaceId=w1"), env: e });
    assert.equal(afternoonRes.status, 200);
    const afternoonBody = await afternoonRes.json();
    assert.equal(afternoonBody.activeRequests.some((r) => r.id === "r-pending-tonight-next-day"), false);
    assert.equal(afternoonBody.history.find((r) => r.id === "r-pending-tonight-next-day")?.expiredReason, "unanswered_stale");
  } finally {
    mock.timers.reset();
  }
});

test("GET expires an unanswered Tonight request after its response grace", async () => {
  const twoNightsAgo = "2026-06-05T06:30:00.000Z"; // Jun 4 11:30pm Los Angeles
  const twoDaysLater = "2026-06-07T15:00:00.000Z"; // Jun 7 8:00am Los Angeles
  const e = await setup([req("r-stale-tonight", {
    status: "pending",
    timing: "Tonight",
    sentAt: twoNightsAgo,
    createdAt: twoNightsAgo,
    updatedAt: twoNightsAgo,
  })]);

  mock.timers.enable({ apis: ["Date"], now: new Date(twoDaysLater) });
  try {
    const res = await board({ request: new Request("http://localhost/api/request-board?workspaceId=w1"), env: e });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.activeRequests.some((r) => r.id === "r-stale-tonight"), false);
    assert.equal(body.history.find((r) => r.id === "r-stale-tonight")?.expiredReason, "unanswered_stale");

    const stored = await readRequests(e);
    const expired = stored.find((r) => r.id === "r-stale-tonight");
    assert.equal(expired.status, "expired");
    assert.equal(expired.expiredReason, "unanswered_stale");
  } finally {
    mock.timers.reset();
  }
});

test("GET restores a prematurely expired unanswered Tomorrow request", async () => {
  const twoNightsAgo = "2026-06-05T06:30:00.000Z"; // Jun 4 11:30pm Los Angeles
  const morningAfterTomorrow = "2026-06-06T15:00:00.000Z"; // Jun 6 8:00am Los Angeles
  const e = await setup([req("r-restore-pending", {
    status: "expired",
    timing: "Tomorrow",
    sentAt: twoNightsAgo,
    createdAt: twoNightsAgo,
    updatedAt: twoNightsAgo,
    expiredAt: morningAfterTomorrow,
    expiredReason: "timing_window_passed",
  })]);

  mock.timers.enable({ apis: ["Date"], now: new Date(morningAfterTomorrow) });
  try {
    const res = await board({ request: new Request("http://localhost/api/request-board?workspaceId=w1"), env: e });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.activeRequests.find((r) => r.id === "r-restore-pending")?.status, "pending");
    assert.equal(body.history.some((r) => r.id === "r-restore-pending"), false);

    const stored = await readRequests(e);
    const restored = stored.find((r) => r.id === "r-restore-pending");
    assert.equal(restored.status, "pending");
    assert.equal(restored.expiredAt, undefined);
    assert.equal(restored.expiredReason, undefined);
  } finally {
    mock.timers.reset();
  }
});

test("GET does not restore an old unanswered expired request", async () => {
  const oldSentAt = "2026-04-01T06:30:00.000Z";
  const oldExpiredAt = "2026-04-03T07:00:00.000Z";
  const now = "2026-06-06T15:00:00.000Z";
  const e = await setup([req("r-old-expired", {
    status: "expired",
    timing: "Tomorrow",
    sentAt: oldSentAt,
    createdAt: oldSentAt,
    updatedAt: oldExpiredAt,
    expiredAt: oldExpiredAt,
    expiredReason: "timing_window_passed",
  })]);

  mock.timers.enable({ apis: ["Date"], now: new Date(now) });
  try {
    const res = await board({ request: new Request("http://localhost/api/request-board?workspaceId=w1"), env: e });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.activeRequests.some((r) => r.id === "r-old-expired"), false);
    assert.equal(body.history.find((r) => r.id === "r-old-expired")?.status, "expired");

    const stored = await readRequests(e);
    assert.equal(stored.find((r) => r.id === "r-old-expired").status, "expired");
  } finally {
    mock.timers.reset();
  }
});

test("GET expires an old unanswered pending request as stale", async () => {
  const oldSentAt = "2026-04-01T06:30:00.000Z";
  const now = "2026-06-06T15:00:00.000Z";
  const e = await setup([req("r-old-pending", {
    status: "pending",
    timing: "Tomorrow",
    sentAt: oldSentAt,
    createdAt: oldSentAt,
    updatedAt: "2026-06-06T14:00:00.000Z",
  })]);

  mock.timers.enable({ apis: ["Date"], now: new Date(now) });
  try {
    const res = await board({ request: new Request("http://localhost/api/request-board?workspaceId=w1"), env: e });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.activeRequests.some((r) => r.id === "r-old-pending"), false);
    assert.equal(body.history.find((r) => r.id === "r-old-pending")?.expiredReason, "unanswered_stale");

    const stored = await readRequests(e);
    const expired = stored.find((r) => r.id === "r-old-pending");
    assert.equal(expired.status, "expired");
    assert.equal(expired.expiredReason, "unanswered_stale");
  } finally {
    mock.timers.reset();
  }
});

test("accepted Tomorrow timing counter stays active when it becomes tonight", async () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const e = await setup([req("r-counter", {
    status: "on_deck",
    timing: "Tomorrow",
    sentAt: twoDaysAgo,
    createdAt: twoDaysAgo,
    reviewedAt: yesterday,
    counterAcceptedAt: yesterday,
    acceptedCounters: [{ label: "Tomorrow", targetType: "timing" }],
    acceptedTimingCounter: { label: "Tomorrow", targetType: "timing" },
  })]);

  const res = await board({ request: new Request("http://localhost/api/request-board?workspaceId=w1"), env: e });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.activeRequests.find((r) => r.id === "r-counter")?.status, "on_deck");
  assert.equal(body.history.some((r) => r.id === "r-counter"), false);

  const stored = await readRequests(e);
  assert.equal(stored.find((r) => r.id === "r-counter").status, "on_deck");
});

test("GET restores a previously expired accepted Tomorrow timing counter", async () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const e = await setup([req("r-restore", {
    status: "expired",
    timing: "Tomorrow",
    sentAt: twoDaysAgo,
    createdAt: twoDaysAgo,
    reviewedAt: yesterday,
    counterAcceptedAt: yesterday,
    acceptedCounters: [{ label: "Tomorrow", targetType: "timing" }],
    acceptedTimingCounter: { label: "Tomorrow", targetType: "timing" },
    expiredAt: new Date().toISOString(),
    expiredReason: "timing_window_passed",
  })]);

  const res = await board({ request: new Request("http://localhost/api/request-board?workspaceId=w1"), env: e });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.activeRequests.find((r) => r.id === "r-restore")?.status, "on_deck");
  assert.equal(body.history.some((r) => r.id === "r-restore"), false);

  const stored = await readRequests(e);
  const restored = stored.find((r) => r.id === "r-restore");
  assert.equal(restored.status, "on_deck");
  assert.equal(restored.expiredAt, undefined);
  assert.equal(restored.expiredReason, undefined);
});

test("GET restores an encrypted accepted counter expired by the old tonight window", async () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const encryptedBox = {
    __sxsRoomEncrypted: true,
    version: "sxs-room-e2ee-v1",
    algorithm: "AES-GCM",
    iv: "aXY=",
    ciphertext: "Y291Y2gtaGVhZA==",
  };
  const e = await setup([req("r-encrypted-restore", {
    status: "expired",
    timing: "Tonight",
    sentAt: twoDaysAgo,
    createdAt: twoDaysAgo,
    reviewedAt: yesterday,
    counterAcceptedAt: yesterday,
    decisions: [{ label: "Encrypted content", decision: "Counter", targetType: "timing" }],
    encryptedReply: encryptedBox,
    expiredAt: new Date().toISOString(),
    expiredReason: "timing_window_passed",
  })]);

  const res = await board({ request: new Request("http://localhost/api/request-board?workspaceId=w1"), env: e });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.activeRequests.find((r) => r.id === "r-encrypted-restore")?.status, "on_deck");

  const stored = await readRequests(e);
  const restored = stored.find((r) => r.id === "r-encrypted-restore");
  assert.equal(restored.status, "on_deck");
  assert.equal(restored.expiredAt, undefined);
  assert.equal(restored.expiredReason, undefined);
});

test("participants can manually restore an expired Ask to Sexboard", async () => {
  const e = await setup([req("r-manual-restore", {
    status: "expired",
    expiredAt: new Date().toISOString(),
    expiredReason: "timing_window_passed",
  })]);

  const res = await call(e, "PATCH", { workspaceId: "w1", id: "r-manual-restore", action: "restore" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.request.status, "on_deck");
  assert.equal(body.request.expiredAt, undefined);
  assert.equal(body.activeRequests.find((r) => r.id === "r-manual-restore")?.status, "on_deck");
});

test("a manually restored Ask survives the next board read (does not re-expire)", async () => {
  // Regression: `restore` clears expiredAt and stamps restoredAt, but the timing
  // anchor ignored restoredAt — so an Ask whose ORIGINAL send is already past its
  // timing window re-expired on the very next GET (the restore button looked dead
  // for timing-expired Asks). A manual restore must open a fresh timing window.
  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const e = await setup([req("r-restore-flap", {
    status: "expired",
    timing: "Tonight",
    sentAt: fiveDaysAgo,
    createdAt: fiveDaysAgo,
    reviewedAt: fiveDaysAgo,
    expiredAt: fiveDaysAgo,
    expiredReason: "timing_window_passed",
  })]);

  const restoreRes = await call(e, "PATCH", { workspaceId: "w1", id: "r-restore-flap", action: "restore" });
  assert.equal(restoreRes.status, 200);
  assert.equal((await restoreRes.json()).request.status, "on_deck");

  // The flap only surfaced on the NEXT board read, where timing expiry recomputes.
  const getRes = await board({ request: new Request("http://localhost/api/request-board?workspaceId=w1"), env: e });
  assert.equal(getRes.status, 200);
  const after = await getRes.json();
  assert.equal(
    after.activeRequests.find((r) => r.id === "r-restore-flap")?.status,
    "on_deck",
    "restored Ask must stay on_deck, not re-expire against its stale original anchor"
  );
  assert.equal(after.history.some((r) => r.id === "r-restore-flap"), false);

  const stored = await readRequests(e);
  const restored = stored.find((r) => r.id === "r-restore-flap");
  assert.equal(restored.status, "on_deck");
  assert.equal(restored.expiredAt, undefined);
});

test("a counter accepted after a manual restore keeps a coherent timing anchor", async () => {
  // accept_counter stamps restoredAt == counterAcceptedAt, so the later-of
  // anchor logic must never see the two disagree. Pin that invariant.
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const e = await setup([req("r-restore-then-counter", {
    status: "expired",
    timing: "Tomorrow",
    sentAt: threeDaysAgo,
    createdAt: threeDaysAgo,
    reviewedAt: threeDaysAgo,
    decisions: [{ label: "Massage", decision: "Counter", counter: "Slow massage", targetType: "act" }],
    counters: [{ label: "Massage", counter: "Slow massage", targetType: "act" }],
    expiredAt: threeDaysAgo,
    expiredReason: "timing_window_passed",
  })]);

  const restoreRes = await call(e, "PATCH", { workspaceId: "w1", id: "r-restore-then-counter", action: "restore" });
  assert.equal(restoreRes.status, 200);

  const acceptRes = await call(e, "PATCH", { workspaceId: "w1", id: "r-restore-then-counter", action: "accept_counter" });
  assert.equal(acceptRes.status, 200);
  const accepted = (await acceptRes.json()).request;
  assert.equal(accepted.status, "on_deck");
  assert.equal(accepted.restoredAt, accepted.counterAcceptedAt, "accept_counter must keep restoredAt == counterAcceptedAt");

  // Survives the next read with the fresh counter-accepted window.
  const getRes = await board({ request: new Request("http://localhost/api/request-board?workspaceId=w1"), env: e });
  const after = await getRes.json();
  assert.equal(after.activeRequests.find((r) => r.id === "r-restore-then-counter")?.status, "on_deck");
});

// --- Room-encrypted (E2EE) Asks: the timing field is a placeholder ---

// Shape accepted by cleanRoomEncryptedBox — content is opaque to the server.
const E2EE_BOX = {
  __sxsRoomEncrypted: true,
  version: "sxs-room-e2ee-v1",
  algorithm: "AES-GCM",
  iv: "aXZpdml2aXZpdg==",
  ciphertext: "Y2lwaGVydGV4dA==",
};

test("an unanswered E2EE Ask is not staled on the placeholder Tonight clock", async () => {
  // Regression: encrypted Asks always submit timing:"Tonight" (the real timing
  // is inside the encrypted payload). The next-day-noon unanswered fast path
  // must not fire on the placeholder — a real "Next week" Ask would die in a day.
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const e = await setup([req("r-e2ee-pending", {
    status: "pending",
    timing: "Tonight",
    categories: ["[Encrypted Ask]"],
    encryptedPayload: E2EE_BOX,
    sentAt: twoDaysAgo,
    createdAt: twoDaysAgo,
  })]);

  const res = await board({ request: new Request("http://localhost/api/request-board?workspaceId=w1"), env: e });
  const body = await res.json();
  assert.equal(body.activeRequests.find((r) => r.id === "r-e2ee-pending")?.status, "pending",
    "placeholder-timing E2EE Ask must not expire as unanswered_stale in a day");
});

test("a reviewed E2EE Ask gets the most generous timing window, then expires", async () => {
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const e = await setup([
    req("r-e2ee-fresh", {
      status: "on_deck",
      timing: "Tonight",
      categories: ["[Encrypted Ask]"],
      encryptedPayload: E2EE_BOX,
      sentAt: threeDaysAgo,
      createdAt: threeDaysAgo,
      reviewedAt: threeDaysAgo,
    }),
    req("r-e2ee-old", {
      status: "on_deck",
      timing: "Tonight",
      categories: ["[Encrypted Ask]"],
      encryptedPayload: E2EE_BOX,
      sentAt: tenDaysAgo,
      createdAt: tenDaysAgo,
      reviewedAt: tenDaysAgo,
    }),
  ]);

  const res = await board({ request: new Request("http://localhost/api/request-board?workspaceId=w1"), env: e });
  const body = await res.json();
  assert.equal(body.activeRequests.find((r) => r.id === "r-e2ee-fresh")?.status, "on_deck",
    "3-day-old E2EE Ask survives (padded to the Next week window)");
  const old = body.history.find((r) => r.id === "r-e2ee-old");
  assert.equal(old?.status, "expired", "the padded window still ends — 10-day-old E2EE Ask expires");
});
