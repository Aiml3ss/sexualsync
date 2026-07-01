import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanDecisions, VALID_DECISIONS } from "../../functions/api/review-token.js";

test("only whitelisted decision values survive", () => {
  const out = cleanDecisions([
    { label: "Penetration", decision: "Yes" },
    { label: "Filming", decision: "DROP TABLE requests; --" }, // invalid -> "" -> filtered
    { label: "", decision: "No" },                              // no label -> filtered
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].decision, "Yes");
  assert.ok(VALID_DECISIONS.has(out[0].decision));
});

test("an item with only a counter or note is retained", () => {
  const out = cleanDecisions([{ label: "Toys", counter: "Maybe a blindfold" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].decision, "");
  assert.equal(out[0].counter, "Maybe a blindfold");
});

test("decisions are capped at MAX_DECISIONS (60)", () => {
  const big = Array.from({ length: 200 }, (_, i) => ({ label: `l${i}`, decision: "Yes" }));
  assert.ok(cleanDecisions(big).length <= 60);
});

test("oversized free-text fields are truncated", () => {
  const out = cleanDecisions([{ label: "x", decision: "Yes", note: "n".repeat(5000) }]);
  assert.ok(out[0].note.length <= 220);
});

test("non-array input yields an empty array", () => {
  assert.deepEqual(cleanDecisions(null), []);
  assert.deepEqual(cleanDecisions("nope"), []);
});
