import { test } from "node:test";
import assert from "node:assert/strict";
import { createAppSessionToken, verifyAppSession } from "../../functions/api/_app_session.js";
import { getAuthenticatedIdentity } from "../../functions/api/_auth.js";
import { onRequest as localAuth } from "../../functions/api/auth/local.js";
import { makeStateEnv } from "./helpers.mjs";

const SECRET = "l".repeat(40);

function env(overrides = {}) {
  return {
    ...makeStateEnv(),
    SELF_HOST_TARGET: "node",
    APP_SESSION_SECRET: SECRET,
    ...overrides,
  };
}

function request(body) {
  return new Request("https://sexualsync.local/api/auth/local", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "127.0.0.1",
      origin: "https://sexualsync.local",
    },
    body: JSON.stringify(body),
  });
}

async function run(testEnv, body) {
  return localAuth({
    env: testEnv,
    request: request(body),
  });
}

function sessionCookie(response) {
  return response.headers.get("set-cookie") || "";
}

test("local password auth is self-host only", async () => {
  const response = await localAuth({
    env: { ...makeStateEnv(), APP_SESSION_SECRET: SECRET },
    request: request({
      mode: "register",
      email: "person@example.com",
      password: "correct horse",
    }),
  });
  assert.equal(response.status, 404);
});

test("register mints a local app session and preserves safe return paths", async () => {
  const testEnv = env();
  const response = await run(testEnv, {
    mode: "register",
    email: " Person@Example.COM ",
    password: "correct horse",
    name: "Person",
    returnTo: "/onboarding",
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.email, "person@example.com");
  assert.equal(body.returnTo, "/onboarding");

  const cookie = sessionCookie(response);
  assert.match(cookie, /sxs-session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);

  const session = await verifyAppSession(new Request("https://sexualsync.local/", {
    headers: { cookie },
  }), testEnv);
  assert.equal(session.email, "person@example.com");
  assert.equal(session.name, "Person");
  assert.equal(session.provider, "local");
});

test("login accepts the saved local password and rejects the wrong one", async () => {
  const testEnv = env();
  await run(testEnv, {
    mode: "register",
    email: "person@example.com",
    password: "correct horse",
  });

  const ok = await run(testEnv, {
    mode: "login",
    email: "person@example.com",
    password: "correct horse",
  });
  assert.equal(ok.status, 200);
  const session = await verifyAppSession(new Request("https://sexualsync.local/", {
    headers: { cookie: sessionCookie(ok) },
  }), testEnv);
  assert.equal(session.email, "person@example.com");
  assert.equal(session.provider, "local");

  const bad = await run(testEnv, {
    mode: "login",
    email: "person@example.com",
    password: "wrong password",
  });
  assert.equal(bad.status, 400);
  const body = await bad.json();
  assert.match(body.error, /incorrect/i);
});

test("local sessions bypass placeholder private-preview allowlists on self-host", async () => {
  const testEnv = env({
    PRIVATE_PREVIEW_MODE: "1",
    PRIVATE_PREVIEW_ALLOWED_EMAILS: "you@example.com,partner@example.com",
  });
  const response = await run(testEnv, {
    mode: "register",
    email: "stranger@example.com",
    password: "correct horse",
  });
  assert.equal(response.status, 200);

  const identity = await getAuthenticatedIdentity({
    env: testEnv,
    request: new Request("https://sexualsync.local/api/bootstrap", {
      headers: { cookie: sessionCookie(response) },
    }),
  });
  assert.equal(identity.ok, true);
  assert.equal(identity.email, "stranger@example.com");
  assert.equal(identity.provider, "local");
});

test("real self-host allowlists still gate local account creation", async () => {
  const testEnv = env({
    PRIVATE_PREVIEW_ALLOWED_EMAILS: "allowed@example.com",
  });
  const response = await run(testEnv, {
    mode: "register",
    email: "stranger@example.com",
    password: "correct horse",
  });
  assert.equal(response.status, 403);
});

test("real self-host allowlists still gate existing local sessions", async () => {
  const testEnv = env({
    PRIVATE_PREVIEW_ALLOWED_EMAILS: "allowed@example.com",
  });
  const token = await createAppSessionToken(testEnv, {
    email: "stranger@example.com",
    provider: "local",
  });
  const identity = await getAuthenticatedIdentity({
    env: testEnv,
    request: new Request("https://sexualsync.local/api/bootstrap", {
      headers: { cookie: `sxs-session=${encodeURIComponent(token)}` },
    }),
  });
  assert.equal(identity.ok, false);
  assert.equal(identity.response.status, 403);
});
