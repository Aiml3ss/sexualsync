import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEmailAuthChallenge,
  startEmailSignIn,
  verifyEmailAuthChallenge,
  verifyEmailSignIn,
} from "../../functions/api/auth/email/_email_auth.js";
import { createAppSessionToken, verifyAppSession } from "../../functions/api/_app_session.js";
import { getAuthenticatedIdentity } from "../../functions/api/_auth.js";
import { privatePreviewAllowsIdentity } from "../../functions/api/auth/_private_preview.js";
import { makeStateEnv } from "./helpers.mjs";

const SECRET = "s".repeat(40);

function env() {
  return {
    ...makeStateEnv(),
    APP_SESSION_SECRET: SECRET,
    RESEND_API_KEY: "test-resend-key",
  };
}

function request(body) {
  return new Request("https://sexualsync.io/api/auth/email/verify", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.10",
      origin: "https://sexualsync.io",
    },
    body: JSON.stringify(body),
  });
}

test("email auth challenge verifies once and preserves safe return paths", async () => {
  const testEnv = env();
  const challenge = await createEmailAuthChallenge(testEnv, {
    email: " Person@Example.COM ",
    returnTo: "/?invite=abc123",
  });

  const verified = await verifyEmailAuthChallenge(testEnv, {
    email: "person@example.com",
    code: challenge.code,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.email, "person@example.com");
  assert.equal(verified.returnTo, "/?invite=abc123");

  const replay = await verifyEmailAuthChallenge(testEnv, {
    email: "person@example.com",
    code: challenge.code,
  });
  assert.equal(replay.ok, false);
});

test("email auth rejects correct code after too many wrong attempts", async () => {
  const testEnv = env();
  const challenge = await createEmailAuthChallenge(testEnv, {
    email: "person@example.com",
    returnTo: "/sexboard",
  });

  for (let index = 0; index < 5; index += 1) {
    const wrong = await verifyEmailAuthChallenge(testEnv, {
      email: "person@example.com",
      code: "000000" === challenge.code ? "111111" : "000000",
    });
    assert.equal(wrong.ok, false);
  }

  const locked = await verifyEmailAuthChallenge(testEnv, {
    email: "person@example.com",
    code: challenge.code,
  });
  assert.equal(locked.ok, false);
});

test("email verify endpoint mints the same HttpOnly app session cookie", async () => {
  const testEnv = { ...env(), PUBLIC_SIGNUPS_OPEN: "1" };
  const challenge = await createEmailAuthChallenge(testEnv, {
    email: "person@example.com",
    returnTo: "https://evil.test/steal",
  });

  const response = await verifyEmailSignIn({
    env: testEnv,
    request: request({ email: "person@example.com", code: challenge.code }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.returnTo, "/");

  const cookie = response.headers.get("set-cookie") || "";
  assert.match(cookie, /sxs-session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);

  const session = await verifyAppSession(new Request("https://sexualsync.io/", {
    headers: { cookie },
  }), testEnv);
  assert.equal(session.email, "person@example.com");
  assert.equal(session.provider, "email");
});

test("email sign-in start is closed by default outside private preview allowlist", async () => {
  const testEnv = env();
  const response = await startEmailSignIn({
    env: testEnv,
    request: new Request("https://sexualsync.io/api/auth/email/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.11",
        origin: "https://sexualsync.io",
      },
      body: JSON.stringify({ email: "stranger@example.com", returnTo: "/sexboard" }),
    }),
  });

  assert.equal(response.status, 403);
  const body = await response.json();
  assert.match(body.error, /private preview/i);
});

test("email verify refuses non-allowlisted private-preview sign-ins", async () => {
  const testEnv = {
    ...env(),
    PRIVATE_PREVIEW_ALLOWED_EMAILS: "owner@example.com, partner@example.com",
  };
  const challenge = await createEmailAuthChallenge(testEnv, {
    email: "stranger@example.com",
    returnTo: "/sexboard",
  });

  const response = await verifyEmailSignIn({
    env: testEnv,
    request: request({ email: "stranger@example.com", code: challenge.code }),
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("set-cookie"), null);
  const body = await response.json();
  assert.match(body.error, /private preview/i);
});

test("private-preview mode blocks unrelated historical workspace members", async () => {
  const testEnv = {
    ...env(),
    PRIVATE_PREVIEW_MODE: "1",
    SEXUALSYNC_ADMIN_EMAIL: "owner@example.com",
  };
  await testEnv.__kv.put("sex-exploration-platform:workspaces", JSON.stringify([{
    id: "workspace-existing",
    status: "active",
    members: [{
      email: "person@example.com",
      role: "owner",
      status: "active",
    }],
  }]));
  const challenge = await createEmailAuthChallenge(testEnv, {
    email: "person@example.com",
    returnTo: "/sexboard",
  });

  const response = await verifyEmailSignIn({
    env: testEnv,
    request: request({ email: "person@example.com", code: challenge.code }),
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("private-preview mode blocks active owner-room members unless exactly allowlisted", async () => {
  const testEnv = {
    ...env(),
    PRIVATE_PREVIEW_MODE: "1",
    SEXUALSYNC_ADMIN_EMAIL: "owner@example.com",
  };
  await testEnv.__kv.put("sex-exploration-platform:workspaces", JSON.stringify([{
    id: "owner-room",
    status: "active",
    members: [
      {
        email: "owner@example.com",
        role: "owner",
        status: "active",
      },
      {
        email: "partner@example.com",
        role: "partner",
        status: "active",
      },
    ],
  }]));
  assert.equal(await privatePreviewAllowsIdentity(testEnv, "partner@example.com"), false);

  const challenge = await createEmailAuthChallenge(testEnv, {
    email: "partner@example.com",
    returnTo: "/sexboard",
  });
  const response = await verifyEmailSignIn({
    env: testEnv,
    request: request({ email: "partner@example.com", code: challenge.code }),
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("private-preview mode allows exact configured private emails", async () => {
  const testEnv = {
    ...env(),
    PRIVATE_PREVIEW_MODE: "1",
    SEXUALSYNC_ADMIN_EMAIL: "owner@example.com",
    PRIVATE_PREVIEW_ALLOWED_EMAILS: "partner@example.com",
  };
  assert.equal(await privatePreviewAllowsIdentity(testEnv, "partner@example.com"), true);

  const challenge = await createEmailAuthChallenge(testEnv, {
    email: "partner@example.com",
    returnTo: "/sexboard",
  });
  const response = await verifyEmailSignIn({
    env: testEnv,
    request: request({ email: "partner@example.com", code: challenge.code }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") || "", /sxs-session=/);
});

test("private-preview mode rejects stale app sessions outside the owner room", async () => {
  const testEnv = {
    ...env(),
    PRIVATE_PREVIEW_MODE: "1",
    SEXUALSYNC_ADMIN_EMAIL: "owner@example.com",
  };
  const sessionToken = await createAppSessionToken(testEnv, {
    email: "stranger@example.com",
    provider: "email",
  });
  const identity = await getAuthenticatedIdentity({
    env: testEnv,
    request: new Request("https://sexualsync.io/api/bootstrap", {
      headers: { cookie: `sxs-session=${encodeURIComponent(sessionToken)}` },
    }),
  });
  assert.equal(identity.ok, false);
  assert.equal(identity.response.status, 403);
});
