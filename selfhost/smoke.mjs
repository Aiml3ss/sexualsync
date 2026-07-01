// Boots the self-host server on an ephemeral port against a throwaway data
// directory and exercises the REAL Cloudflare handlers end-to-end over HTTP.
// Proves: the server boots, the file-based router resolves real routes, the
// Pages middleware runs, and the filesystem KV + R2 adapters round-trip through
// the genuine /api/health probe handler. No network, no external services.
//
// Run with: npm run selfhost:smoke

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { promises as fs } from "node:fs";
import { createSelfHostServer } from "./server.mjs";

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push([true, name]); console.log(`  ✔ ${name}`); })
    .catch((error) => { results.push([false, name]); console.log(`  x ${name}\n      ${error?.message || error}`); });
}

// Open a WebSocket and start buffering messages immediately so nothing sent on
// connect (e.g. room.hello) is missed before a waiter is attached.
function connect(url) {
  const ws = new WebSocket(url);
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

function rawUpgrade({ port, path: pathname = "/api/room/socket", origin = "" }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      const lines = [
        `GET ${pathname} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="
      ];
      if (origin) lines.push(`Origin: ${origin}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let data = "";
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error("raw upgrade timed out"));
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.includes("\r\n")) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("error", reject);
  });
}

async function main() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sexualsync-selfhost-smoke-"));
  // Tiny fixture web build so we can exercise static serving + the middleware's
  // CSP-nonce HTML rewrite without a full Next build.
  const distDir = path.join(dataDir, "dist");
  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(
    path.join(distDir, "index.html"),
    "<!doctype html><html><head><title>Sexualsync</title><link rel=\"preload\" as=\"script\" href=\"/app.js\"><script>window.__ok=1;</script></head><body>self-host</body></html>"
  );

  const { server } = await createSelfHostServer({
    host: "127.0.0.1",
    dataDir,
    distDir,
    envOverrides: {
      ALLOW_LOCAL_PREVIEW: "1",
    // Exercise the secure-by-default at-rest path: a real self-host sets this,
    // and encodeStoredJson now refuses plaintext for sensitive stores without it.
    APP_SESSION_SECRET: "selfhost-smoke-app-session-secret-000001",
      APP_VERSION: "sexualsync-selfhost-smoke"
      // No legacy/preconfigured workspace on purpose: the smoke creates one via
      // the real onboarding flow, exactly as a fresh public self-hoster would.
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`[smoke] server up on ${base}`);
  console.log(`[smoke] data dir: ${dataDir}`);

  await check("GET /api/health returns 200 with the self-host bindings", async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.service, "sexualsync");
    assert.equal(body.appVersion, "sexualsync-selfhost-smoke");
    assert.equal(body.bindings.store, true, "STORE (KV) binding should be present");
    assert.equal(body.bindings.vaultMedia, true, "VAULT_MEDIA (R2) binding should be present");
    assert.equal(body.bindings.rooms, true, "ROOMS should be present (in-process realtime registry)");
    assert.equal(body.bindings.state, false, "STATE should be absent (in-process lock fallback)");
  });

  await check("GET /api/health?probe=1 reports 200 with KV + R2 + ROOMS probes green", async () => {
    const res = await fetch(`${base}/api/health?probe=1`);
    const body = await res.json();
    assert.equal(res.status, 200, `health probe should be healthy: ${JSON.stringify(body.probes)}`);
    assert.equal(body.probes.kv.ok, true, `KV probe should succeed (put+get round-trip): ${JSON.stringify(body.probes.kv)}`);
    assert.equal(body.probes.vault.ok, true, `R2 probe should succeed (list): ${JSON.stringify(body.probes.vault)}`);
    assert.equal(body.probes.rooms.ok, true, `ROOMS probe should succeed (events): ${JSON.stringify(body.probes.rooms)}`);
    assert.equal(body.probes.state.present, false, "STATE absence should be reported, not fatal");
  });

  await check("GET /api/config returns 200 JSON", async () => {
    const res = await fetch(`${base}/api/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.appVersion, "sexualsync-selfhost-smoke");
    assert.equal(body.selfHost, true);
    assert.equal(body.runtimeTarget, "node");
    assert.equal(body.localPasswordAuthEnabled, true);
    assert.equal(typeof body.googleAuthEnabled, "boolean");
  });

  await check("unknown /api/* path hits the catch-all 404 (not a crash)", async () => {
    const res = await fetch(`${base}/api/this-route-does-not-exist`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "API route not found.");
  });

  await check("cross-origin API mutation is blocked by the Pages middleware", async () => {
    const res = await fetch(`${base}/api/config`, {
      method: "POST",
      headers: { origin: "https://evil.example" }
    });
    assert.equal(res.status, 403, "middleware CSRF guard should block cross-origin mutations");
  });

  await check("GET / serves the static web build with a per-request CSP nonce", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    assert.equal(res.headers.get("content-length"), null, "rewritten HTML must not keep the stale static file length");
    const csp = res.headers.get("content-security-policy") || "";
    assert.match(csp, /script-src[^;]*'nonce-/, "middleware should set a CSP with a script nonce");
    const nonce = (csp.match(/'nonce-([^']+)'/) || [])[1];
    assert.ok(nonce, "CSP should contain a nonce value");
    const body = await res.text();
    assert.ok(body.includes(`<script nonce="${nonce}">`), "the same nonce should be injected into the inline <script> tag");
    assert.ok(body.includes(`<link nonce="${nonce}" rel="preload" as="script"`), "script preload links need the same nonce under strict-dynamic");
  });

  await check("security headers from _headers are applied (and don't override the CSP nonce)", async () => {
    // On an API JSON response the middleware sets no CSP, so the static
    // _headers rules should supply the full security header set.
    const res = await fetch(`${base}/api/config`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("referrer-policy"), "same-origin");
    assert.match(res.headers.get("permissions-policy") || "", /camera=\(\)/);
    assert.ok(res.headers.get("strict-transport-security"), "HSTS should be set");
    assert.match(res.headers.get("content-security-policy") || "", /default-src 'self'/, "static CSP fallback applies where middleware sets none");

    // On HTML the middleware's per-request nonce CSP must win over the static one.
    const html = await fetch(`${base}/`);
    assert.match(html.headers.get("content-security-policy") || "", /'nonce-/, "HTML CSP should be the middleware nonce CSP, not the static fallback");
    assert.equal(html.headers.get("x-content-type-options"), "nosniff", "HTML still gets the static security headers");
  });

  let productWorkspaceId = "";

  await check("fresh user with no preconfigured room creates a workspace via /api/profile", async () => {
    // Exactly what a public self-hoster's first sign-in does. No legacy config.
    const res = await fetch(`${base}/api/profile`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ action: "create_workspace", ownerName: "Tester", workspaceName: "Our Room" })
    });
    assert.equal(res.status, 200, "create_workspace should succeed for a brand-new user");
    const body = await res.json();
    assert.ok(Array.isArray(body.workspaces) && body.workspaces.length >= 1, "a workspace should now exist for the new user");
    const mine = body.workspaces.find((w) => (w.members || []).some((m) => m.email === "local-preview@example.test"));
    assert.ok(mine, "the new user should be an active member of the workspace they created");
    productWorkspaceId = mine.id;
  });

  await check("product KV write+read: a kink persists and reads back through the filesystem store", async () => {
    // The health probe only round-trips a synthetic KV key. This drives a REAL
    // product write through mutateRecord/getStore (the seam every domain
    // resource — kinks, quiz, green-lights, chat — rides) and reads it back.
    assert.ok(productWorkspaceId, "need the onboarded workspace id");
    const post = await fetch(`${base}/api/fantasy-backlog`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ workspaceId: productWorkspaceId, text: "smoke kink: pinned over the desk" })
    });
    assert.equal(post.status, 201, "kink create should persist through the Node store adapter");
    const created = await post.json();
    assert.ok(created.idea && created.idea.id, "create returns the new idea");
    const get = await fetch(`${base}/api/fantasy-backlog?workspaceId=${encodeURIComponent(productWorkspaceId)}`, {
      headers: { origin: base }
    });
    assert.equal(get.status, 200);
    const list = await get.json();
    assert.ok((list.ideas || []).some((i) => i.id === created.idea.id), "the created kink reads back from the store adapter");
  });

  await check("product R2 byte round-trip: chat-media stores and returns encrypted bytes intact", async () => {
    // The health probe only LISTS R2; this PUTs real bytes (standing in for the
    // client's AES-GCM ciphertext) and GETs them back, proving the filesystem R2
    // adapter is byte-exact — the path Sext images and Vault media depend on.
    assert.ok(productWorkspaceId, "need the onboarded workspace id");
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37 + 11) & 0xff;
    const post = await fetch(`${base}/api/chat-media?workspaceId=${encodeURIComponent(productWorkspaceId)}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", origin: base },
      body: bytes
    });
    assert.equal(post.status, 201, "chat-media upload should store bytes in R2 on Node");
    const { mediaId } = await post.json();
    assert.ok(mediaId, "upload returns a mediaId");
    const got = await fetch(`${base}/api/chat-media?id=${encodeURIComponent(mediaId)}&workspaceId=${encodeURIComponent(productWorkspaceId)}`, {
      headers: { origin: base }
    });
    assert.equal(got.status, 200, "stored media should be retrievable");
    const back = new Uint8Array(await got.arrayBuffer());
    assert.equal(back.length, bytes.length, "byte length round-trips");
    let identical = back.length === bytes.length;
    for (let i = 0; identical && i < bytes.length; i += 1) if (back[i] !== bytes[i]) identical = false;
    assert.ok(identical, "every byte round-trips intact through the filesystem R2 adapter");
  });

  const wsClients = [];

  await check("realtime: WS connect → room.hello, and a product mutation fans out to both sockets", async () => {
    // The workspace created by the onboarding check above now backs realtime.
    const probe = await fetch(`${base}/api/room/socket`);
    assert.equal(probe.status, 200, "non-upgrade socket GET should authorize and return realtime info");
    const info = await probe.json();
    assert.equal(info.realtime, true);
    const workspaceId = info.workspaceId;
    assert.ok(workspaceId, "should resolve a workspace id for the local-preview identity");

    const wsUrl = `ws://127.0.0.1:${port}/api/room/socket?workspaceId=${encodeURIComponent(workspaceId)}`;
    const a = connect(wsUrl);
    wsClients.push(a);
    await a.opened;
    const helloA = await a.waitFor((m) => m.type === "room.hello");
    assert.equal(helloA.workspaceId, workspaceId);

    const b = connect(wsUrl);
    wsClients.push(b);
    await b.opened;
    const helloB = await b.waitFor((m) => m.type === "room.hello");
    // Presence is tracked across sockets: the second socket's hello lists the
    // already-connected actor. (Both sockets are the same local-preview identity,
    // so presence correctly DEDUPS — see the unit test for cross-actor fan-out.)
    assert.ok((helloB.online || []).includes("local-preview@example.test"), "hello.online should report the already-connected actor");

    // A real product mutation must fan out to BOTH live sockets (the core
    // realtime delivery path on Node). Match the new event by its entity id so a
    // replayed earlier event can't satisfy the assertion.
    const created = await fetch(`${base}/api/fantasy-backlog`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ workspaceId, text: "smoke kink: realtime fan-out" })
    });
    assert.equal(created.status, 201, "kink create should persist and broadcast a room event");
    const createdId = (await created.json()).idea?.id;
    assert.ok(createdId, "create returns an id to match the broadcast against");
    const evtA = await a.waitFor((m) => m.type === "room.event" && m.event?.entityId === createdId);
    const evtB = await b.waitFor((m) => m.type === "room.event" && m.event?.entityId === createdId);
    assert.equal(evtA.event.resource, "fantasy-backlog");
    assert.equal(evtB.event.action, "created");
  });

  await check("realtime: heartbeat over the live socket gets a room.pong", async () => {
    const probe = await (await fetch(`${base}/api/room/socket`)).json();
    const a = connect(`ws://127.0.0.1:${port}/api/room/socket?workspaceId=${encodeURIComponent(probe.workspaceId)}`);
    wsClients.push(a);
    await a.opened;
    await a.waitFor((m) => m.type === "room.hello");
    a.ws.send(JSON.stringify({ type: "heartbeat" }));
    const pong = await a.waitFor((m) => m.type === "room.pong");
    assert.equal(pong.type, "room.pong");
  });

  await check("realtime: upgrade to a non-member workspace is refused (not crashed)", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/room/socket?workspaceId=does-not-exist`);
    const outcome = await new Promise((resolve) => {
      ws.addEventListener("open", () => resolve("open"), { once: true });
      ws.addEventListener("error", () => resolve("error"), { once: true });
      ws.addEventListener("close", () => resolve("close"), { once: true });
      setTimeout(() => resolve("timeout"), 3000);
    });
    assert.ok(outcome === "error" || outcome === "close", `expected refused upgrade, got "${outcome}"`);
    try { ws.close(); } catch { /* ignore */ }
  });

  await check("realtime: cross-origin WebSocket upgrades are refused before live-room auth", async () => {
    const response = await rawUpgrade({
      port,
      path: "/api/room/socket",
      origin: "https://evil.example"
    });
    assert.match(response, /^HTTP\/1\.1 403 Forbidden/m);
  });

  for (const client of wsClients) client.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(dataDir, { recursive: true, force: true });

  const failed = results.filter(([ok]) => !ok);
  console.log(`\n[smoke] ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.error("[smoke] FAILED");
    process.exit(1);
  }
  console.log("[smoke] self-host server OK");
}

main().catch((error) => {
  console.error("[smoke] crashed:", error);
  process.exit(1);
});
