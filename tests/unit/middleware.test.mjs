import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../../functions/_middleware.js";
import { createAppSessionToken } from "../../functions/api/_app_session.js";
import { makeStateEnv } from "./helpers.mjs";

const SECRET = "middleware-session-secret-0123456789abcdef";

function ctx(request, env = {}) {
  let nextCalled = false;
  const context = {
    env,
    request,
    next: async () => { nextCalled = true; return new Response("ok"); },
  };
  return { context, calledNext: () => nextCalled };
}

const apiPost = (origin) => new Request("https://sexualsync.io/api/invite", {
  method: "POST",
  headers: origin === null ? {} : { origin },
});

test("blocks a cross-origin API mutation", async () => {
  const { context, calledNext } = ctx(apiPost("https://evil.example"));
  const res = await onRequest(context);
  assert.equal(res.status, 403);
  assert.equal(calledNext(), false);
});

test("allows a same-origin API mutation", async () => {
  const { context, calledNext } = ctx(apiPost("https://sexualsync.io"));
  const res = await onRequest(context);
  assert.equal(res.status, 200);
  assert.equal(calledNext(), true);
});

test("allows an API mutation with no Origin header (Bearer / cron clients)", async () => {
  const { context, calledNext } = ctx(apiPost(null));
  await onRequest(context);
  assert.equal(calledNext(), true);
});

test("does not touch safe methods even cross-origin", async () => {
  const req = new Request("https://sexualsync.io/api/profile", {
    method: "GET",
    headers: { origin: "https://evil.example" },
  });
  const { context, calledNext } = ctx(req);
  await onRequest(context);
  assert.equal(calledNext(), true);
});

test("still 404s retired paths", async () => {
  const { context } = ctx(new Request("https://sexualsync.io/legacy.html"));
  const res = await onRequest(context);
  assert.equal(res.status, 404);
});

test("adds a CSP nonce to HTML navigations", async () => {
  const request = new Request("https://sexualsync.io/");
  const context = {
    request,
    next: async () => new Response("<html><head><link rel=\"preload\" as=\"script\" href=\"/_next/static/chunks/app.js\"><style>.x{color:red}</style></head><body><script>window.x=1</script></body></html>", {
      headers: { "content-type": "text/html; charset=utf-8", "content-length": "168" },
    }),
  };
  const res = await onRequest(context);
  const csp = res.headers.get("content-security-policy") || "";
  const nonce = res.headers.get("x-csp-nonce") || "";
  const body = await res.text();
  assert.match(csp, /'strict-dynamic'/);
  assert.ok(nonce.length >= 20);
  assert.ok(csp.includes(`'nonce-${nonce}'`));
  assert.ok(body.includes(`<script nonce="${nonce}">`));
  assert.ok(body.includes(`<style nonce="${nonce}">`));
  assert.ok(body.includes(`<link nonce="${nonce}" rel="preload" as="script"`));
  assert.equal(res.headers.get("content-length"), null);
});

test("redirects protected app pages before unauthenticated shell load", async () => {
  const { context, calledNext } = ctx(new Request("https://sexualsync.io/sexboard"));
  const res = await onRequest(context);
  assert.equal(res.status, 302);
  assert.equal(calledNext(), false);
  assert.match(res.headers.get("location") || "", /\/signin/);
});

test("allows protected app pages for private-preview owner-room sessions", async () => {
  const env = {
    ...makeStateEnv(),
    APP_SESSION_SECRET: SECRET,
    PRIVATE_PREVIEW_MODE: "1",
    SEXUALSYNC_ADMIN_EMAIL: "owner@example.com",
    PRIVATE_PREVIEW_ALLOWED_EMAILS: "partner@example.com",
  };
  await env.__kv.put("sex-exploration-platform:workspaces", JSON.stringify([{
    id: "owner-room",
    status: "active",
    members: [
      { email: "owner@example.com", status: "active" },
      { email: "partner@example.com", status: "active" },
    ],
  }]));
  const token = await createAppSessionToken(env, { email: "partner@example.com", provider: "email" });
  const { context, calledNext } = ctx(new Request("https://sexualsync.io/sexboard", {
    headers: { cookie: `sxs-session=${encodeURIComponent(token)}` },
  }), env);
  const res = await onRequest(context);
  assert.equal(res.status, 200);
  assert.equal(calledNext(), true);
});

test("clears stale protected app sessions outside private preview", async () => {
  const env = {
    ...makeStateEnv(),
    APP_SESSION_SECRET: SECRET,
    PRIVATE_PREVIEW_MODE: "1",
    SEXUALSYNC_ADMIN_EMAIL: "owner@example.com",
  };
  const token = await createAppSessionToken(env, { email: "stranger@example.com", provider: "email" });
  const { context, calledNext } = ctx(new Request("https://sexualsync.io/space/vault", {
    headers: { cookie: `sxs-session=${encodeURIComponent(token)}` },
  }), env);
  const res = await onRequest(context);
  assert.equal(res.status, 302);
  assert.equal(calledNext(), false);
  assert.match(res.headers.get("location") || "", /access=private-preview/);
  assert.match(res.headers.get("set-cookie") || "", /^sxs-session=;/);
});
