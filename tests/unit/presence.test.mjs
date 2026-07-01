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
