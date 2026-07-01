import { test } from "node:test";
import assert from "node:assert/strict";
import { createAppSessionToken, verifyAppSession } from "../../functions/api/_app_session.js";
import { onRequest } from "../../functions/api/auth/logout.js";
import { makeKvEnv } from "./helpers.mjs";

const SECRET = "logout-session-secret-0123456789abcdef";

function context(method = "GET", env, cookie = "") {
  return {
    env,
    request: new Request("https://sexualsync.test/api/auth/logout", {
      method,
      headers: cookie ? { cookie } : {}
    }),
  };
}

function setCookies(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  return (response.headers.get("set-cookie") || "").split(/,(?=\s*[^;,\s]+=)/).map((item) => item.trim()).filter(Boolean);
}

test("GET logout clears cookies and redirects to the signed-out page", async () => {
  const response = await onRequest(context("GET"));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/signed-out");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const cookies = setCookies(response);
  // Self-host cookies are host-scoped; the clear is emitted without a Domain=
  // attribute (no Domain= is ever set).
  assert(cookies.some((cookie) => /^sxs-session=;/.test(cookie) && !cookie.includes("Domain=")));
  assert(cookies.every((cookie) => !(/^sxs-session=;/.test(cookie) && cookie.includes("Domain="))));
  assert(cookies.some((cookie) => /^sxs-refresh=;/.test(cookie)));
  assert(cookies.some((cookie) => /^sxs-oauth=;/.test(cookie) && cookie.includes("Path=/api/auth/google")));
});

test("POST logout keeps the JSON API response", async () => {
  const response = await onRequest(context("POST"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await response.json(), { ok: true });
});

test("logout revokes the current app session when the revocation store is available", async () => {
  const env = { ...makeKvEnv(), APP_SESSION_SECRET: SECRET };
  const token = await createAppSessionToken(env, { email: "a@b.com" });
  const cookie = `sxs-session=${encodeURIComponent(token)}`;
  const response = await onRequest(context("POST", env, cookie));
  assert.equal(response.status, 200);
  assert.equal(await verifyAppSession(new Request("https://sexualsync.test/", { headers: { cookie } }), env), null);
});
