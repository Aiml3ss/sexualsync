// Sexualsync self-host edition — Node HTTP server.
//
// Runs the EXISTING Cloudflare Pages Functions (functions/**), the EXISTING
// Pages middleware (functions/_middleware.js), and the EXISTING static web
// build (dist/) on a plain Node server. The product handlers are not modified:
// they receive the same `onRequest(context)` contract and an `env` whose
// STORE/VAULT_MEDIA bindings are filesystem adapters.
//
// This file does not touch — and is never imported by — the Cloudflare build
// or deploy. It is the entry point for `npm run selfhost:serve`.

import http from "node:http";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildRouter } from "./lib/router.mjs";
import { createStaticServer } from "./lib/static.mjs";
import { buildEnv, describeEnv } from "./lib/env-bindings.mjs";
import { nodeRequestToWeb, sendWebResponse } from "./lib/http-bridge.mjs";
import { RoomRegistry, createRoomsNamespace } from "./lib/ws-room.mjs";
import { attachWebSocket } from "./lib/ws-protocol.mjs";
import { loadHeaderRules } from "./lib/headers.mjs";
import { getAuthenticatedIdentity, normalizeEmail } from "../functions/api/_auth.js";
import { authorizeWorkspaceAccess, workspaceIdFromRequest } from "../functions/api/_workspaces.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const LOOPBACK_LISTEN_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// Hosts the bridge will trust in an X-Forwarded-Host header, derived from the
// operator's declared public origin(s). Same precedence as the email link
// helper (functions/api/_origin.js): PUBLIC_BASE_URL and AUTH_BASE_URL. Empty
// when neither is set, which preserves the legacy "trust any forwarded host"
// behaviour for zero-config / local runs.
function configuredHostAllowlist(env, envOverrides = {}) {
  const hosts = new Set();
  for (const key of ["PUBLIC_BASE_URL", "AUTH_BASE_URL"]) {
    const raw = String(envOverrides[key] ?? env[key] ?? "").trim();
    if (!raw) continue;
    try {
      const host = new URL(raw).host.toLowerCase();
      if (host) hosts.add(host);
    } catch { /* ignore a malformed base URL — it just doesn't widen the allowlist */ }
  }
  return hosts;
}

function readConfig(overrides = {}) {
  const env = process.env;
  const envOverrides = overrides.envOverrides || {};
  const dataDir = path.resolve(overrides.dataDir || env.SELFHOST_DATA_DIR || path.join(repoRoot, "selfhost-data"));
  return {
    host: overrides.host || env.HOST || env.SELFHOST_HOST || "0.0.0.0",
    port: Number(overrides.port ?? env.PORT ?? 8788),
    dataDir,
    mediaDir: path.resolve(overrides.mediaDir || env.SELFHOST_MEDIA_DIR || path.join(dataDir, "media")),
    distDir: path.resolve(overrides.distDir || env.SELFHOST_DIST_DIR || path.join(repoRoot, "dist")),
    functionsDir: path.resolve(overrides.functionsDir || path.join(repoRoot, "functions")),
    trustProxy: String(overrides.trustProxy ?? env.TRUST_PROXY ?? "").toLowerCase() === "true",
    forwardedHostAllowlist: configuredHostAllowlist(env, envOverrides),
    envOverrides
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
function notFound() {
  return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
function methodNotAllowed() {
  return jsonResponse(405, { error: "Method not allowed." });
}

function isLoopbackListenHost(host) {
  return LOOPBACK_LISTEN_HOSTS.has(String(host || "").trim().toLowerCase());
}

function isSameOriginUpgrade(request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function hasPlaceholder(value, needles) {
  const text = String(value || "").toLowerCase();
  return needles.some((needle) => text.includes(needle));
}

function warnForSelfHostPlaceholders(env) {
  const warnings = [];
  if (hasPlaceholder(env.AUTH_BASE_URL, ["your-host.example"])) {
    warnings.push("AUTH_BASE_URL still points at your-host.example; set it to the public origin before OAuth/email sign-in.");
  }
  if (hasPlaceholder(env.PRIVATE_PREVIEW_ALLOWED_EMAILS, ["you@example.com", "partner@example.com"])) {
    warnings.push("PRIVATE_PREVIEW_ALLOWED_EMAILS still contains example addresses; replace them with the real couple emails.");
  }
  if (hasPlaceholder(env.LEGACY_MEMBERS_JSON, ["you@example.com", "partner@example.com"])) {
    warnings.push("LEGACY_MEMBERS_JSON still contains example addresses; replace them or remove it.");
  }
  for (const warning of warnings) console.warn(`[selfhost] WARNING: ${warning}`);
}

async function createPipeline(config, env) {
  const router = await buildRouter(config.functionsDir);
  let staticServer = null;
  let distAvailable = false;
  try {
    await fs.access(config.distDir);
    staticServer = createStaticServer(config.distDir);
    distAvailable = true;
  } catch { /* dist not built yet — API still works */ }

  // The Pages middleware is core security (CSP nonce, CSRF guard, auth gating).
  // Load it mandatorily; if it exists but cannot import, fail loudly (throw)
  // rather than silently serving without it.
  const middlewarePath = path.join(config.functionsDir, "_middleware.js");
  const middlewareExists = await fs.access(middlewarePath).then(() => true, () => false);
  const middleware = middlewareExists ? await import(pathToFileURL(middlewarePath).href) : null;

  const serveStatic = (url) => (staticServer ? staticServer.serve(url.pathname) : Promise.resolve(null));

  async function runRoute(request, waitUntil) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const match = await router.match(method, url.pathname);
    if (match && match.handler) {
      const ctx = {
        request,
        env,
        params: match.params,
        data: {},
        waitUntil,
        next: async () => (await serveStatic(url)) || notFound()
      };
      return match.handler(ctx);
    }
    if (match && !match.handler) return methodNotAllowed();
    return (await serveStatic(url)) || notFound();
  }

  async function handle(request) {
    const pending = [];
    const waitUntil = (p) => { try { pending.push(Promise.resolve(p).catch(() => {})); } catch { /* ignore */ } };
    let response;
    if (middleware && typeof middleware.onRequest === "function") {
      const ctx = { request, env, params: {}, data: {}, waitUntil, next: () => runRoute(request, waitUntil) };
      response = await middleware.onRequest(ctx);
    } else {
      response = await runRoute(request, waitUntil);
    }
    return { response, pending };
  }

  return { handle, router, distAvailable, middlewareLoaded: Boolean(middleware?.onRequest) };
}

export async function createSelfHostServer(overrides = {}) {
  const config = readConfig(overrides);
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.mkdir(config.mediaDir, { recursive: true });

  // Realtime room registry. The same instance both accepts WebSocket upgrades
  // (below) and backs `env.ROOMS` so the product handlers' HTTP broadcasts fan
  // out to connected sockets.
  const registry = new RoomRegistry();
  const env = buildEnv({
    dataDir: config.dataDir,
    mediaDir: config.mediaDir,
    rooms: createRoomsNamespace(registry),
    overrides: config.envOverrides
  });
  if (env.ALLOW_LOCAL_PREVIEW === "1" && !isLoopbackListenHost(config.host)) {
    throw new Error("ALLOW_LOCAL_PREVIEW=1 requires HOST=127.0.0.1, HOST=localhost, or HOST=::1; configure real auth before binding publicly.");
  }
  if (env.ALLOW_LOCAL_PREVIEW === "1" && config.trustProxy) {
    // Fail closed (security audit M3): with TRUST_PROXY=true the loopback check
    // that grants the unauthenticated local-preview identity is derived from the
    // client-supplied X-Forwarded-For, so a remote attacker behind the reverse
    // proxy could send `X-Forwarded-For: 127.0.0.1` and claim that identity. The
    // two flags are never a valid combination — refuse to boot rather than serve
    // a spoofable bypass. Local preview is loopback-only dev, never behind a proxy.
    throw new Error("ALLOW_LOCAL_PREVIEW=1 is incompatible with TRUST_PROXY=true: a spoofed X-Forwarded-For could claim the local-preview identity. Disable one of them.");
  }
  const pipeline = await createPipeline(config, env);
  // Apply the project's Cloudflare `_headers` rules (security headers + cache
  // control) that Node would otherwise drop. Never overrides the middleware's
  // per-request CSP nonce.
  const headerRules = await loadHeaderRules(path.join(repoRoot, "_headers"));
  const inflight = new Set();

  const server = http.createServer(async (req, res) => {
    try {
      const request = nodeRequestToWeb(req, { trustProxy: config.trustProxy, allowedHosts: config.forwardedHostAllowlist });
      const { response, pending } = await pipeline.handle(request);
      const finalResponse = headerRules.apply(response, new URL(request.url).pathname);
      await sendWebResponse(res, finalResponse);
      if (pending.length) {
        const settled = Promise.allSettled(pending);
        inflight.add(settled);
        settled.finally(() => inflight.delete(settled));
      }
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "selfhost.unhandled",
        method: req.method,
        path: String(req.url || "").split("?")[0],
        message: String(error?.message || error || "unknown").slice(0, 200)
      }));
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(JSON.stringify({ error: "Something went wrong. Please try again." }));
      } else {
        res.destroy();
      }
    }
  });

  // WebSocket upgrades for the live room. Node emits "upgrade" (not "request")
  // for these, so they bypass the HTTP pipeline. We authenticate with the SAME
  // handler code the Cloudflare socket proxy uses, then hand the socket to the
  // in-process room registry.
  server.on("upgrade", async (req, socket, head) => {
    const fail = (status, label) => {
      try { socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* ignore */ }
      try { socket.destroy(); } catch { /* ignore */ }
    };
    try {
      const request = nodeRequestToWeb(req, { trustProxy: config.trustProxy, allowedHosts: config.forwardedHostAllowlist });
      const url = new URL(request.url);
      if (url.pathname !== "/api/room/socket") return fail(404, "Not Found");
      if (!isSameOriginUpgrade(request)) return fail(403, "Forbidden");

      const ctx = { request, env };
      const identity = await getAuthenticatedIdentity(ctx);
      if (!identity.ok) return fail(401, "Unauthorized");

      const access = await authorizeWorkspaceAccess(ctx, identity, workspaceIdFromRequest(request));
      if (!access.ok) return fail(403, "Forbidden");

      const ws = attachWebSocket(req, socket, head);
      if (!ws) return;

      const at = new Date().toISOString();
      registry.connect(access.workspace.id, ws, {
        workspaceId: access.workspace.id,
        actorEmail: normalizeEmail(identity.email),
        actorName: access.actorName || identity.displayName || "Partner",
        lastEventSeq: Number(url.searchParams.get("lastEventSeq")) || 0,
        joinedAt: at,
        lastSeenAt: at
      });
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "selfhost.upgrade", message: String(error?.message || error).slice(0, 200) }));
      fail(500, "Internal Server Error");
    }
  });

  return { server, env, registry, config, pipeline, describe: () => describeEnv(env) };
}

export async function start(overrides = {}) {
  const instance = await createSelfHostServer(overrides);
  const { server, config, env, pipeline } = instance;

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  const address = server.address();
  const desc = describeEnv(env);

  console.log(`[selfhost] Sexualsync self-host edition listening on http://${config.host}:${address.port}`);
  console.log(`[selfhost] runtime target: ${desc.runtimeTarget}`);
  console.log(`[selfhost] data dir: ${config.dataDir}`);
  console.log(`[selfhost] media dir: ${config.mediaDir}`);
  console.log(`[selfhost] routes: ${pipeline.router.routes.length}, middleware: ${pipeline.middlewareLoaded}, static(dist): ${pipeline.distAvailable}`);
  console.log(`[selfhost] bindings: store=${desc.store} vaultMedia=${desc.vaultMedia} rooms=${desc.rooms} state=${desc.state}`);

  // APP_SESSION_SECRET is guaranteed by ensureSessionSecret (operator value, else
  // persisted, else freshly generated), so there is no missing-secret case to warn
  // about here — buildEnv logs when it generates or persists one.
  warnForSelfHostPlaceholders(env);
  if (!desc.googleAuth && !desc.email) {
    console.warn("[selfhost] no external auth provider configured; local email/password sign-in is enabled for this self-host.");
  }
  if (!String(env.RESEND_API_KEY || "").trim()) {
    console.warn("[selfhost] WARNING: Email delivery is off (no RESEND_API_KEY) — partner invites and notification emails won't be sent. Share the invite link shown in the app directly. Set RESEND_API_KEY to enable email.");
  }
  if (env.ALLOW_LOCAL_PREVIEW === "1") {
    console.warn("[selfhost] WARNING: ALLOW_LOCAL_PREVIEW=1 is for local testing only; dev identity is limited to localhost URL + loopback client IP.");
  }
  if (!pipeline.distAvailable) {
    console.warn("[selfhost] WARNING: dist/ not found — only /api/* is served. Run `npm run selfhost:build` to build the web UI.");
  }
  console.log(`[selfhost] realtime live room: ${desc.rooms ? "enabled (in-process registry; single-process)" : "disabled"}.`);

  const shutdown = () => {
    console.log("[selfhost] shutting down…");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return instance;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
  start().catch((error) => {
    console.error("[selfhost] failed to start:", error);
    process.exit(1);
  });
}
