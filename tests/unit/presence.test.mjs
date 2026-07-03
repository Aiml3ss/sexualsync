import { test } from "node:test";
import assert from "node:assert/strict";
import { readPresenceResponse } from "../../functions/api/space/presence.js";
import { makeStateEnv } from "./helpers.mjs";

// Presence is stamped as a side-effect of the sexboard GET. A backgrounded or
// realtime-driven refetch passes { stamp: false } so it READS presence (partner
// last-seen, streak) without marking the caller "active". That distinction is
// load-bearing: _notification_policy.js suppresses every real push to a recipient
// who looks active, while a manual push-test is suppression-exempt — which is the
// "test notification arrives but live ones don't" symptom these tests guard.

const WS = {
  id: "ws-presence",
  members: [
    { email: "me@test", status: "active", displayName: "Me" },
    { email: "partner@test", status: "active", displayName: "Partner" },
  ],
};

function decodeB64(value) {
  return Buffer.from(value, "base64").toString("utf8");
}

test("foreground-gate: stamp:false reads without marking the caller active", async () => {
  const env = makeStateEnv();
  await readPresenceResponse(env, WS, "me@test", { stamp: false });
  // The partner's view of "me" stays null until I'm genuinely (foreground) seen.
  const partnerView = await readPresenceResponse(env, WS, "partner@test", { stamp: false });
  assert.equal(partnerView.partner.lastSeen, null, "a hidden refetch must not stamp the caller active");
});

test("foreground-gate: default (stamp:true) marks the caller active", async () => {
  const env = makeStateEnv();
  await readPresenceResponse(env, WS, "me@test");
  const partnerView = await readPresenceResponse(env, WS, "partner@test", { stamp: false });
  assert.ok(partnerView.partner.lastSeen, "a foreground refetch stamps the caller active");
});

test("state-backed presence reads pre-public store aliases before stamping", async () => {
  const env = makeStateEnv();
  const oldPresenceStore = decodeB64("YW5zLWtlbW15LXByZXNlbmNl");
  const partnerSeen = "2026-06-01T12:00:00.000Z";
  env.__kv.map.set(`${oldPresenceStore}:presence:${WS.id}`, JSON.stringify({
    byEmail: { "partner@test": partnerSeen },
    opens: { "partner@test": { "2026-06-01": true } }
  }));

  const myView = await readPresenceResponse(env, WS, "me@test");

  assert.equal(myView.partner.lastSeen, partnerSeen);
  const migrated = JSON.parse(env.__kv.map.get(`sexualsync-presence:presence:${WS.id}`));
  assert.equal(migrated.byEmail["partner@test"], partnerSeen);
  assert.ok(migrated.byEmail["me@test"], "foreground stamp should migrate my seen time to the neutral store");
});

test("presence heals partial neutral records from pre-public aliases", async () => {
  const env = makeStateEnv();
  const oldPresenceStore = decodeB64("YW5zLWtlbW15LXByZXNlbmNl");
  const mySeen = "2026-06-02T12:00:00.000Z";
  const partnerSeen = "2026-06-01T12:00:00.000Z";
  env.__kv.map.set(`sexualsync-presence:presence:${WS.id}`, JSON.stringify({
    byEmail: { "me@test": mySeen },
    opens: { "me@test": { "2026-06-02": true } }
  }));
  env.__kv.map.set(`${oldPresenceStore}:presence:${WS.id}`, JSON.stringify({
    byEmail: { "partner@test": partnerSeen },
    opens: { "partner@test": { "2026-06-01": true } }
  }));

  const myView = await readPresenceResponse(env, WS, "me@test");

  assert.equal(myView.partner.lastSeen, partnerSeen);
  const healed = JSON.parse(env.__kv.map.get(`sexualsync-presence:presence:${WS.id}`));
  assert.ok(healed.byEmail["me@test"]);
  assert.equal(healed.byEmail["partner@test"], partnerSeen);
});
