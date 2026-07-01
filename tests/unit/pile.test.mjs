import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeOverlapLabels,
  onRequest as pile,
  pileDropCapMax,
  publicPile,
  randomPileMaxDropCount,
} from "../../functions/api/pile.js";
import { mutatePlatformState } from "../../functions/api/_workspaces.js";
import { mutateKey, readKey } from "../../functions/api/_state.js";
import { makeStateEnv } from "./helpers.mjs";

test("Pile stays active after reveal time until both partners have drops", () => {
  const pile = {
    revealAt: new Date(Date.now() - 60_000).toISOString(),
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    startedByEmail: "alex@example.test",
    maxDropCount: 3,
    targetDropCount: 3,
    contributions: {
      "alex@example.test": ["Kiss", "Massage"],
    },
  };

  const partnerView = publicPile(pile, "partner@example.test");

  assert.equal(partnerView.isRevealed, false);
  assert.deepEqual(partnerView.mine, []);
  assert.equal(partnerView.partnerLabels, null);
  assert.equal(partnerView.overlap, null);
  assert.equal(partnerView.partnerHasDropped, true);
});

test("Pile reveals after reveal time when both partners have drops", () => {
  const pile = {
    revealAt: new Date(Date.now() - 60_000).toISOString(),
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    startedByEmail: "alex@example.test",
    maxDropCount: 3,
    targetDropCount: 3,
    contributions: {
      "alex@example.test": ["Kiss", "Massage"],
      "partner@example.test": ["Kiss", "Dirty talk"],
    },
  };

  const partnerView = publicPile(pile, "partner@example.test");

  assert.equal(partnerView.isRevealed, true);
  assert.deepEqual(partnerView.overlap, ["Kiss"]);
  assert.deepEqual(partnerView.onlyMine, ["Dirty talk"]);
  assert.deepEqual(partnerView.partnerLabels, {
    "alex@example.test": ["Kiss", "Massage"],
  });
  // Regression: onlyTheirs used to diff against the FIRST contributor's set
  // (key order), so the non-starter viewer always saw [] here.
  assert.deepEqual(partnerView.onlyTheirs, ["Massage"], "non-starter viewer sees the partner's quiet drops");

  const alexView = publicPile(pile, "alex@example.test");
  assert.deepEqual(alexView.onlyTheirs, ["Dirty talk"], "starter viewer unchanged");
});

// --- handler-level: start guard + lock idempotency ---

const ME = "local-preview@example.test";
const PARTNER = "partner@example.test";
const STORE = "sexualsync-pile";

async function setupPileEnv() {
  const e = makeStateEnv();
  e.ALLOW_LOCAL_PREVIEW = "1";
  await mutatePlatformState(e, () => ({
    profiles: [
      { id: "p1", email: ME, displayName: "Me" },
      { id: "p2", email: PARTNER, displayName: "Partner" },
    ],
    workspaces: [{
      id: "w1", name: "Room", displayName: "Room", status: "active", productMode: "couples",
      members: [
        { email: ME, role: "owner", status: "active", displayName: "Me" },
        { email: PARTNER, role: "partner", status: "active", displayName: "Partner" },
      ],
      settings: {},
    }],
    invites: [],
  }));
  return e;
}

const callPile = (e, method, body) => pile({
  request: new Request("http://localhost/api/pile?workspaceId=w1", {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }),
  env: e,
});

test("start does not clobber an in-progress pile (replay is idempotent, conflict is 409)", async () => {
  const e = await setupPileEnv();
  const revealAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const first = await callPile(e, "POST", { workspaceId: "w1", action: "start", revealAt });
  assert.equal(first.status, 200);

  // Drop something so a clobber would be observable data loss.
  const drop = await callPile(e, "POST", { workspaceId: "w1", action: "drop", label: "Kiss" });
  assert.equal(drop.status, 200);

  // Same actor + same revealAt = an offline-queued replay → return the live pile.
  const replay = await callPile(e, "POST", { workspaceId: "w1", action: "start", revealAt });
  assert.equal(replay.status, 200);
  assert.deepEqual((await replay.json()).pile.mine, ["Kiss"], "replay must not reset contributions");

  // A different start while in progress is refused, not a silent wipe.
  const other = await callPile(e, "POST", {
    workspaceId: "w1", action: "start",
    revealAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(other.status, 409);
  const stored = await readKey(e, STORE, "pile:w1:active");
  assert.deepEqual(stored.contributions[ME], ["Kiss"], "in-progress pile survives");
});

test("double-tapped lock derives exactly one session", async () => {
  const e = await setupPileEnv();
  // Seed a revealed pile directly (reveal time passed, both partners dropped).
  await mutateKey(e, STORE, "pile:w1:active", () => ({
    value: {
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
      startedByEmail: ME,
      revealAt: new Date(Date.now() - 60_000).toISOString(),
      maxDropCount: 3,
      targetDropCount: 3,
      contributions: { [ME]: ["Kiss", "Massage"], [PARTNER]: ["Kiss"] },
    },
  }));

  const [a, b] = await Promise.all([
    callPile(e, "POST", { workspaceId: "w1", action: "lock" }),
    callPile(e, "POST", { workspaceId: "w1", action: "lock" }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const [bodyA, bodyB] = [await a.json(), await b.json()];
  assert.equal(bodyA.session.id, bodyB.session.id, "both taps resolve to the SAME claimed session");

  const sessions = await readKey(e, STORE, "pile:w1:sessions");
  assert.equal(sessions.length, 1, "exactly one locked session persisted");
  assert.equal(await readKey(e, STORE, "pile:w1:active"), null, "active pile cleared");
});

// --- pure drop-cap math (previously only exercised indirectly) ---

// pileDropCapMax = max(1, floor(actPool / 3)); never below 1 so a couple can
// always drop at least one act, even with an empty/garbage pool.
test("pileDropCapMax floors at 1 for tiny or invalid act pools", () => {
  for (const input of [0, 1, 2, -5, Number.NaN, undefined, null, "nope", {}]) {
    assert.equal(pileDropCapMax(input), 1, `expected 1 for ${String(input)}`);
  }
});

test("pileDropCapMax scales as floor(actPool / 3)", () => {
  assert.equal(pileDropCapMax(3), 1);
  assert.equal(pileDropCapMax(5), 1);
  assert.equal(pileDropCapMax(6), 2);
  assert.equal(pileDropCapMax(9), 3);
  assert.equal(pileDropCapMax(10), 3);
  assert.equal(pileDropCapMax(30), 10);
});

test("randomPileMaxDropCount stays within [1, pileDropCapMax]", () => {
  for (const pool of [1, 3, 6, 12, 30]) {
    const cap = pileDropCapMax(pool);
    for (let i = 0; i < 250; i += 1) {
      const value = randomPileMaxDropCount(pool);
      assert.ok(Number.isInteger(value), `integer for pool ${pool}`);
      assert.ok(value >= 1 && value <= cap, `${value} not in [1, ${cap}] for pool ${pool}`);
    }
  }
});

test("randomPileMaxDropCount can reach both ends of a wide range", () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) seen.add(randomPileMaxDropCount(30));
  assert.ok(seen.has(1), "should be able to draw the floor (1)");
  assert.ok(seen.has(10), "should be able to draw the cap (10)");
});

// --- computeOverlapLabels edge cases (publicPile covers the happy path) ---

test("computeOverlapLabels returns [] with fewer than two contributors", () => {
  assert.deepEqual(computeOverlapLabels(null), []);
  assert.deepEqual(computeOverlapLabels({}), []);
  assert.deepEqual(computeOverlapLabels({ contributions: {} }), []);
  assert.deepEqual(computeOverlapLabels({ contributions: { "a@x.test": ["x"] } }), []);
});

test("computeOverlapLabels intersects case-insensitively, in the first partner's casing", () => {
  const pile = {
    contributions: {
      "a@x.test": ["Slow Undressing", "Massage", "Filming"],
      "b@x.test": ["slow undressing", "massage", "Toys"],
    },
  };
  assert.deepEqual(computeOverlapLabels(pile), ["Slow Undressing", "Massage"]);
});

test("computeOverlapLabels requires the label in ALL contributors", () => {
  const pile = {
    contributions: {
      "a@x.test": ["shared", "onlyA"],
      "b@x.test": ["shared", "onlyB"],
      "c@x.test": ["shared"],
    },
  };
  assert.deepEqual(computeOverlapLabels(pile), ["shared"]);
  assert.deepEqual(
    computeOverlapLabels({ contributions: { "a@x.test": ["x"], "b@x.test": ["y"] } }),
    [],
    "no shared labels → empty",
  );
});
