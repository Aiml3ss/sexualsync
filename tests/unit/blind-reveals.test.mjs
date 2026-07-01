import { test } from "node:test";
import assert from "node:assert/strict";
import { publicReveal } from "../../functions/api/blind-reveals.js";

const workspace = {
  id: "w1",
  members: [
    { email: "alex@example.test", displayName: "Alex", status: "active" },
    { email: "jordan@example.test", displayName: "Jordan", status: "active" },
  ],
};

test("archived Blind Reveals still expose entries for Recent Reveals", () => {
  const pub = publicReveal({
    id: "blind-1",
    workspaceId: "w1",
    prompt: "What should we reopen?",
    status: "archived",
    createdAt: "2026-05-23T00:00:00.000Z",
    updatedAt: "2026-05-23T00:10:00.000Z",
    revealedAt: "2026-05-23T00:05:00.000Z",
    archivedAt: "2026-05-23T00:10:00.000Z",
    entries: {
      "alex@example.test": {
        email: "alex@example.test",
        name: "Alex",
        text: "Mine stays readable.",
        createdAt: "2026-05-23T00:01:00.000Z",
        updatedAt: "2026-05-23T00:01:00.000Z",
      },
      "jordan@example.test": {
        email: "jordan@example.test",
        name: "Jordan",
        text: "Theirs stays readable.",
        createdAt: "2026-05-23T00:02:00.000Z",
        updatedAt: "2026-05-23T00:02:00.000Z",
      },
    },
  }, workspace, "alex@example.test");

  assert.equal(pub.status, "archived");
  assert.equal(pub.entries.length, 2);
  assert.deepEqual(pub.entries.map((entry) => entry.text).sort(), [
    "Mine stays readable.",
    "Theirs stays readable.",
  ]);
});
