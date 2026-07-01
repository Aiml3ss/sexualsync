import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createReviewToken,
  findReviewToken,
  consumeReviewToken,
  isTokenActive,
  revokeReviewerTokens,
} from "../../functions/api/_tokens.js";
import { makeStateEnv } from "./helpers.mjs";

const mk = (env) => createReviewToken(env, {
  workspaceId: "w1",
  requestId: "r1",
  reviewerEmail: "Reviewer@X.com",
});

test("a created token can be found by its value and is active", async () => {
  const env = makeStateEnv();
  const created = await mk(env);
  assert.ok(created.token, "raw token value returned to caller");
  const found = await findReviewToken(env, created.token);
  assert.equal(found.id, created.id);
  assert.equal(found.reviewerEmail, "reviewer@x.com");
  assert.ok(isTokenActive(found));
});

test("consuming a token twice succeeds once then returns null", async () => {
  const env = makeStateEnv();
  const created = await mk(env);
  const first = await consumeReviewToken(env, created.id);
  assert.ok(first && first.consumedAt);
  const second = await consumeReviewToken(env, created.id);
  assert.equal(second, null);
});

// Edge case #4 from the review: two isolates submitting the same review link at
// once must not both succeed. The CAS coordinator guarantees exactly one win.
test("concurrent consume of the same token resolves exactly once", async () => {
  const env = makeStateEnv();
  const created = await mk(env);

  const results = await Promise.all([
    consumeReviewToken(env, created.id),
    consumeReviewToken(env, created.id),
    consumeReviewToken(env, created.id),
  ]);

  const winners = results.filter(Boolean);
  assert.equal(winners.length, 1, "exactly one consume may win");
  assert.ok(winners[0].consumedAt);
});

test("creating a second token for the same request drops the prior unconsumed one", async () => {
  const env = makeStateEnv();
  const a = await mk(env);
  const b = await mk(env);
  // The old token value should no longer resolve; the new one should.
  assert.equal(await findReviewToken(env, a.token), null);
  assert.equal((await findReviewToken(env, b.token)).id, b.id);
});

// Revocation gap: a member who leaves a workspace must have their outstanding
// review tokens killed immediately, scoped to just them (the workspace survives).
test("revokeReviewerTokens removes only the named reviewer's tokens in that workspace", async () => {
  const env = makeStateEnv();
  const alice = await createReviewToken(env, { workspaceId: "w1", requestId: "rA", reviewerEmail: "Alice@X.com" });
  const bob = await createReviewToken(env, { workspaceId: "w1", requestId: "rB", reviewerEmail: "bob@x.com" });
  const aliceElsewhere = await createReviewToken(env, { workspaceId: "w2", requestId: "rA", reviewerEmail: "alice@x.com" });

  // Mixed-case input must match the lowercased stored reviewerEmail.
  const result = await revokeReviewerTokens(env, "w1", "ALICE@x.com");
  assert.equal(result, true);

  assert.equal(await findReviewToken(env, alice.token), null, "alice's w1 token is revoked");
  assert.ok(await findReviewToken(env, bob.token), "a co-member's token survives");
  assert.ok(await findReviewToken(env, aliceElsewhere.token), "the same reviewer's token in another workspace survives");
});

// Empty-reviewer guard: an unbound caller must not mass-revoke tokens whose
// reviewerEmail normalizes to "".
test("revokeReviewerTokens with an empty reviewer revokes nothing", async () => {
  const env = makeStateEnv();
  const created = await mk(env);
  const result = await revokeReviewerTokens(env, "w1", "");
  assert.equal(result, false);
  assert.ok(await findReviewToken(env, created.token), "no tokens revoked when reviewer is empty");
});
