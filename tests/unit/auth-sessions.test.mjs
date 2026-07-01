import { test } from "node:test";
import assert from "node:assert/strict";
import { createAppSessionToken, verifyAppSession } from "../../functions/api/_app_session.js";
import { onRequest } from "../../functions/api/auth/sessions.js";
import { makeKvEnv } from "./helpers.mjs";

const SECRET = "auth-sessions-secret-0123456789abcdef";

function env() {
  return {
    ...makeKvEnv(),
    APP_SESSION_SECRET: SECRET,
    PUBLIC_SIGNUPS_OPEN: "1"
  };
}

async function requestWithSession(env, body) {
  const token = await createAppSessionToken(env, { email: "a@b.com", name: "Alex" });
  const headers = { cookie: `sxs-session=${encodeURIComponent(token)}` };
  if (body) headers["content-type"] = "application/json";
  return {
    token,
    request: new Request("https://example.com/api/auth/sessions", {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined
    })
  };
}

test("session endpoint returns current revocable session metadata", async () => {
  const e = env();
  const { request } = await requestWithSession(e);
  const response = await onRequest({ env: e, request });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.current.email, "a@b.com");
  assert.equal(body.current.revocable, true);
  assert.equal(typeof body.current.sessionId, "string");
  assert.ok(body.current.sessionId.length > 0);
});

test("session endpoint can revoke all app sessions for the user", async () => {
  const e = env();
  const { token, request } = await requestWithSession(e, { action: "revoke_all" });
  const response = await onRequest({ env: e, request });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie")?.startsWith("sxs-session=;"), true);
  assert.deepEqual(await response.json(), { ok: true, revoked: "all" });

  const stale = new Request("https://example.com/", {
    headers: { cookie: `sxs-session=${encodeURIComponent(token)}` }
  });
  assert.equal(await verifyAppSession(stale, e), null);
});
