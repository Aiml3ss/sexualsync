// Two-IDENTITY self-host smoke. Where selfhost/smoke.mjs drives a single
// local-preview identity, this boots the real server with NO local-preview and
// authenticates TWO distinct users (Alex + Blair) via genuine minted app
// sessions, then drives the Sex Quiz + Green Lights double-blind journey end to
// end over real HTTP through the real handlers + filesystem store:
//
//   A submits  ->  B's /api/sexboard shows the game "needs you"  (partner in,
//                  B isn't), and B still cannot see A's answers (double-blind)
//   B submits  ->  the round reveals for BOTH, the shared match is exposed, and
//                  the dashboard handoff clears.
//
// Plus the realtime path the single-identity smoke can't reach: a CROSS-ACTOR
// room broadcast — A's mutation fans out to B's live socket (the original smoke
// only has same-identity sockets, which dedupe).
//
// This is the wiring the mocked Playwright suite never touches (it stubs every
// /api/**): real browser-equivalent client -> real Functions -> real store ->
// the partner sees it. Zero credentials, throwaway data dir, never touches any
// live instance.
//
// Run with: npm run selfhost:smoke2

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createSelfHostServer } from "./server.mjs";
import { mutatePlatformState } from "../functions/api/_workspaces.js";
import { createAppSessionToken } from "../functions/api/_app_session.js";

const A = "alex@smoke.test";
const B = "blair@smoke.test";
const WS = "smoke-room";
// >= 32 chars: keys both the session HMAC and the at-rest envelope.
const SECRET = "selfhost-smoke2-app-session-secret-0000001";

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push([true, name]); console.log(`  ✔ ${name}`); })
    .catch((error) => { results.push([false, name]); console.log(`  x ${name}\n      ${error?.stack || error?.message || error}`); });
}

// Buffer WS messages from the moment the socket opens so a broadcast that lands
// before a waiter is attached is not missed.
function connect(url, cookie) {
  const ws = new WebSocket(url, cookie ? { headers: { cookie } } : undefined);
  const messages = [];
  const waiters = [];
  ws.addEventListener("message", (ev) => {
    let data;
    try { data = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
    messages.push(data);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].pred(data)) { waiters[i].resolve(data); waiters.splice(i, 1); }
    }
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws failed to open")), { once: true });
  });
  function waitFor(pred, timeoutMs = 3000) {
    const existing = messages.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for ws message")), timeoutMs);
      waiters.push({ pred, resolve: (d) => { clearTimeout(timer); resolve(d); } });
    });
  }
  return { ws, messages, opened, waitFor, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

const member = (email, role, displayName) => ({ email, role, status: "active", displayName });

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sexualsync-selfhost-smoke2-"));
  const distDir = path.join(dataDir, "dist");
  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(path.join(distDir, "index.html"), "<!doctype html><title>Sexualsync</title><body>smoke2</body>");

  const { server, env } = await createSelfHostServer({
    host: "127.0.0.1",
    dataDir,
    distDir,
    envOverrides: {
      // Deliberately NO ALLOW_LOCAL_PREVIEW: it short-circuits every loopback
      // request to one synthetic identity, which would defeat the whole point.
      APP_SESSION_SECRET: SECRET,
      PUBLIC_SIGNUPS_OPEN: "1",
      APP_VERSION: "sexualsync-selfhost-smoke2"
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`[smoke2] server up on ${base}`);
  console.log(`[smoke2] data dir: ${dataDir}`);

  // Seed a paired 2-person workspace directly. The invite/pairing flow has its
  // own coverage; this smoke is about the two-user GAME + realtime wiring, so we
  // start from an already-paired room. defaultWorkspaceId makes /api/sexboard
  // resolve it as each user's active workspace deterministically.
  await mutatePlatformState(env, () => ({
    profiles: [
      { id: "pa", email: A, displayName: "Alex", settings: { defaultWorkspaceId: WS } },
      { id: "pb", email: B, displayName: "Blair", settings: { defaultWorkspaceId: WS } }
    ],
    workspaces: [{
      id: WS, name: "Smoke Room", displayName: "Smoke Room", status: "active",
      productMode: "couples",
      members: [member(A, "owner", "Alex"), member(B, "partner", "Blair")],
      settings: {}
    }],
    invites: []
  }));

  const cookieA = `sxs-session=${encodeURIComponent(await createAppSessionToken(env, { email: A, provider: "email", name: "Alex" }))}`;
  const cookieB = `sxs-session=${encodeURIComponent(await createAppSessionToken(env, { email: B, provider: "email", name: "Blair" }))}`;

  const api = (cookie, p, init = {}) => fetch(`${base}${p}`, {
    ...init,
    headers: { origin: base, cookie, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) }
  });
  const sexboard = async (cookie) => (await api(cookie, "/api/sexboard")).json();
  const submitQuiz = (cookie, ratings) => api(cookie, "/api/sex-quiz", { method: "POST", body: JSON.stringify({ workspaceId: WS, action: "submit", ratings }) });
  const quizView = async (cookie) => (await api(cookie, `/api/sex-quiz?workspaceId=${encodeURIComponent(WS)}`)).json();
  const submitGL = (cookie, answers) => api(cookie, "/api/green-lights", { method: "POST", body: JSON.stringify({ workspaceId: WS, action: "submit", answers }) });
  const glView = async (cookie) => (await api(cookie, `/api/green-lights?workspaceId=${encodeURIComponent(WS)}`)).json();

  await check("two distinct users authenticate via minted sessions and resolve the same room", async () => {
    const a = await sexboard(cookieA);
    const b = await sexboard(cookieB);
    assert.equal(a.auth?.email, A, "A authenticates as Alex");
    assert.equal(b.auth?.email, B, "B authenticates as Blair");
    assert.equal(a.activeWorkspace?.id, WS, "A resolves the seeded room");
    assert.equal(b.activeWorkspace?.id, WS, "B resolves the seeded room");
  });

  await check("Sex Quiz two-user journey: blind -> needs-you -> reveal across real HTTP", async () => {
    let aBoard = await sexboard(cookieA);
    assert.equal(aBoard.sexboard.sexQuiz.mySubmitted, false, "nobody submitted yet (A)");
    assert.equal(aBoard.sexboard.sexQuiz.partnerSubmitted, false, "nobody submitted yet (partner)");

    const aSub = await submitQuiz(cookieA, { c1: { interest: "into" }, c2: { interest: "pass" } });
    assert.equal(aSub.status, 200, "A quiz submit ok");

    // B's dashboard now reports the quiz NEEDS B (partner in, B isn't).
    const bBoard = await sexboard(cookieB);
    assert.equal(bBoard.sexboard.sexQuiz.partnerSubmitted, true, "B sees that A submitted");
    assert.equal(bBoard.sexboard.sexQuiz.mySubmitted, false, "B has not submitted");
    assert.equal(bBoard.sexboard.sexQuiz.revealed, false, "round is still blind");

    // Double-blind across the wire: B cannot see A's answers before B submits.
    const bBlind = await quizView(cookieB);
    assert.deepEqual(bBlind.matches, [], "no matches leaked to B pre-submit");
    assert.equal(bBlind.partnerRatings, null, "A's ratings hidden from B pre-submit");

    // A is now waiting (A in, B not).
    aBoard = await sexboard(cookieA);
    assert.equal(aBoard.sexboard.sexQuiz.mySubmitted, true, "A submitted");
    assert.equal(aBoard.sexboard.sexQuiz.partnerSubmitted, false, "A waits on B");

    const bSub = await submitQuiz(cookieB, { c1: { interest: "into" }, c2: { interest: "into" } });
    assert.equal(bSub.status, 200, "B quiz submit ok");

    // Reveal opens for both; the shared c1 match is now visible to A.
    const aRevealed = await sexboard(cookieA);
    assert.equal(aRevealed.sexboard.sexQuiz.revealed, true, "A sees the reveal");
    const aView = await quizView(cookieA);
    assert.equal(aView.status, "revealed", "quiz status is revealed for A");
    assert.deepEqual(aView.matches.map((m) => m.cardId), ["c1"], "the shared c1 match reveals to A");
  });

  await check("Green Lights two-user journey across real HTTP (B-first)", async () => {
    const bSub = await submitGL(cookieB, { q1: { value: "agree" }, q2: { value: "depends" } });
    assert.equal(bSub.status, 200, "B green-lights submit ok");

    let aBoard = await sexboard(cookieA);
    assert.equal(aBoard.sexboard.greenLights.partnerSubmitted, true, "A sees B finished GL");
    assert.equal(aBoard.sexboard.greenLights.mySubmitted, false, "GL needs A");
    assert.equal(aBoard.sexboard.greenLights.revealed, false, "still blind");

    const aBlind = await glView(cookieA);
    assert.equal(Object.keys(aBlind.partnerAnswers || {}).length, 0, "B's answers hidden from A pre-submit");

    const aSub = await submitGL(cookieA, { q1: { value: "agree" }, q2: { value: "agree" } });
    assert.equal(aSub.status, 200, "A green-lights submit ok");

    aBoard = await sexboard(cookieA);
    assert.equal(aBoard.sexboard.greenLights.revealed, true, "GL reveals for A once both are in");
  });

  await check("realtime cross-actor fan-out: A's mutation reaches B's live socket", async () => {
    const wsUrl = `ws://127.0.0.1:${port}/api/room/socket?workspaceId=${encodeURIComponent(WS)}`;
    const sockA = connect(wsUrl, cookieA);
    const sockB = connect(wsUrl, cookieB);
    try {
      await sockA.opened;
      await sockB.opened;
      await sockA.waitFor((m) => m.type === "room.hello");
      const helloB = await sockB.waitFor((m) => m.type === "room.hello");
      // Distinct identities, so presence does NOT dedupe: B's hello should list A.
      assert.ok((helloB.online || []).includes(A), "B's room.hello lists the already-connected A (cross-actor presence)");

      // A creates a kink over HTTP; it must broadcast to B's socket.
      const created = await api(cookieA, "/api/fantasy-backlog", { method: "POST", body: JSON.stringify({ workspaceId: WS, text: "smoke2 kink: cross-actor fan-out" }) });
      assert.equal(created.status, 201, "A kink create persists + broadcasts");
      const id = (await created.json()).idea?.id;
      assert.ok(id, "create returns an id to match the broadcast");
      const evtB = await sockB.waitFor((m) => m.type === "room.event" && m.event?.entityId === id);
      assert.equal(evtB.event.resource, "fantasy-backlog", "B receives A's fantasy-backlog event");
      assert.equal(evtB.event.action, "created", "B receives the created action");
    } finally {
      sockA.close();
      sockB.close();
    }
  });

  await new Promise((resolve) => server.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });

  const failed = results.filter(([ok]) => !ok);
  console.log(`\n[smoke2] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.error("[smoke2] FAILED");
    process.exit(1);
  }
  console.log("[smoke2] two-user self-host journey OK");
}

main().catch((error) => {
  console.error("[smoke2] crashed:", error);
  process.exit(1);
});
