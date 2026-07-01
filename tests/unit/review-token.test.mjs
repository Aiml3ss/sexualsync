import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest as reviewToken } from "../../functions/api/review-token.js";
import { createReviewToken, findReviewToken } from "../../functions/api/_tokens.js";
import { mutatePlatformState } from "../../functions/api/_workspaces.js";
import { mutateKey, readKey } from "../../functions/api/_state.js";
import { makeStateEnv } from "./helpers.mjs";

const ME = "local-preview@example.test";
const PARTNER = "partner@example.test";
const REQ_STORE = "sexualsync-request-board";
const WORKSPACE_ID = "w1";
const REQ_KEY = `requests:${WORKSPACE_ID}`;
const NOW = new Date().toISOString();

const req = (id, overrides = {}) => ({
  id,
  workspaceId: WORKSPACE_ID,
  status: "pending",
  requesterEmail: PARTNER,
  reviewerEmail: ME,
  requester: "Partner",
  reviewer: "Me",
  requesterName: "Partner",
  reviewerName: "Me",
  categories: ["Massage"],
  timing: "Tonight",
  filming: "No",
  decisions: [],
  counters: [],
  createdAt: NOW,
  updatedAt: NOW,
  sentAt: NOW,
  ...overrides,
});

async function setup(requests = []) {
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
      members: [
        { email: ME, role: "owner", status: "active", displayName: "Me" },
        { email: PARTNER, role: "partner", status: "active", displayName: "Partner" },
      ],
      settings: {},
    }],
    invites: [],
  }));
  if (requests.length) await mutateKey(env, REQ_STORE, REQ_KEY, () => ({ value: requests }));
  return env;
}

const call = (env, body) => reviewToken({
  request: new Request("http://localhost/api/review-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }),
  env,
});

async function readRequests(env) {
  return (await readKey(env, REQ_STORE, REQ_KEY)) || [];
}

test("review links stop resolving once the request is no longer replyable", async () => {
  const env = await setup([req("r1", {
    status: "reviewed",
    reviewedAt: NOW,
    decisions: [{ label: "Massage", decision: "Yes", targetType: "act" }],
  })]);
  const token = await createReviewToken(env, {
    workspaceId: WORKSPACE_ID,
    requestId: "r1",
    reviewerEmail: ME,
  });

  const res = await call(env, { action: "resolve", token: token.token });
  assert.equal(res.status, 410);
});

test("token submit keeps the reviewed request durable even if token cleanup fails", async () => {
  const env = await setup([req("r1")]);
  const token = await createReviewToken(env, {
    workspaceId: WORKSPACE_ID,
    requestId: "r1",
    reviewerEmail: ME,
  });
  const originalPut = env.STORE.put.bind(env.STORE);
  env.STORE.put = async (key, value, options) => {
    if (String(key) === "sexualsync-review-tokens:tokens") {
      throw new Error("simulated token-store write failure");
    }
    return originalPut(key, value, options);
  };

  const res = await call(env, {
    token: token.token,
    decisions: [{ label: "Massage", decision: "Yes", targetType: "act" }],
  });
  assert.equal(res.status, 200);

  const stored = await readRequests(env);
  const reviewed = stored.find((item) => item.id === "r1");
  assert.equal(reviewed.status, "reviewed");
  assert.equal(reviewed.reviewedByEmail, ME);

  assert.ok(await findReviewToken(env, token.token), "token record remains because cleanup failed");
  const resolveAfter = await call(env, { action: "resolve", token: token.token });
  assert.equal(resolveAfter.status, 410, "stale active token still cannot reveal a reviewed request");
});
