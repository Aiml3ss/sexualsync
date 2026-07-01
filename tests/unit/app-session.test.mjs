import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAppSessionToken,
  revokeAllAppSessionsForEmail,
  revokeCurrentAppSession,
  verifyAppSession
} from "../../functions/api/_app_session.js";
import { makeKvEnv, makeSessionToken } from "./helpers.mjs";

const SECRET = "x".repeat(40);
const env = { APP_SESSION_SECRET: SECRET };
const reqWith = (cookie) => new Request("https://example.com/", { headers: { cookie } });

test("valid session round-trips and normalizes the email", async () => {
  const token = await createAppSessionToken(env, { email: "A@B.com", name: "Alex" });
  const s = await verifyAppSession(reqWith(`sxs-session=${encodeURIComponent(token)}`), env);
  assert.ok(s);
  assert.equal(s.email, "a@b.com");
  assert.equal(s.revocable, true);
});

test("email provider sessions round-trip as email sessions", async () => {
  const token = await createAppSessionToken(env, { email: "a@b.com", provider: "email" });
  const s = await verifyAppSession(reqWith(`sxs-session=${encodeURIComponent(token)}`), env);
  assert.ok(s);
  assert.equal(s.provider, "email");
});

test("local provider sessions round-trip as local sessions", async () => {
  const token = await createAppSessionToken(env, { email: "a@b.com", provider: "local" });
  const s = await verifyAppSession(reqWith(`sxs-session=${encodeURIComponent(token)}`), env);
  assert.ok(s);
  assert.equal(s.provider, "local");
});

test("tampered payload with reused signature is rejected", async () => {
  const token = await createAppSessionToken(env, { email: "a@b.com" });
  const sig = token.split(".")[1];
  const forgedBody = Buffer.from('{"email":"evil@x.com","exp":9999999999}').toString("base64url");
  const s = await verifyAppSession(reqWith(`sxs-session=${forgedBody}.${sig}`), env);
  assert.equal(s, null);
});

test("expired session is rejected even with a valid signature", async () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  const token = await makeSessionToken(SECRET, { email: "a@b.com", exp: past, iat: past - 10 });
  const s = await verifyAppSession(reqWith(`sxs-session=${token}`), env);
  assert.equal(s, null);
});

test("session signed with a different secret is rejected", async () => {
  const token = await createAppSessionToken(env, { email: "a@b.com" });
  const s = await verifyAppSession(reqWith(`sxs-session=${token}`), { APP_SESSION_SECRET: "y".repeat(40) });
  assert.equal(s, null);
});

test("a secret shorter than 32 chars cannot mint a token", async () => {
  await assert.rejects(() => createAppSessionToken({ APP_SESSION_SECRET: "short" }, { email: "a@b.com" }));
});

test("missing cookie yields null", async () => {
  const s = await verifyAppSession(reqWith(""), env);
  assert.equal(s, null);
});

test("revoking the current session blocks that session cookie", async () => {
  const revokeEnv = { ...makeKvEnv(), APP_SESSION_SECRET: SECRET };
  const token = await createAppSessionToken(revokeEnv, { email: "a@b.com" });
  const request = reqWith(`sxs-session=${encodeURIComponent(token)}`);
  const before = await verifyAppSession(request, revokeEnv);
  assert.ok(before);
  assert.equal(before.revocable, true);

  const revoked = await revokeCurrentAppSession(request, revokeEnv);
  assert.equal(revoked.email, "a@b.com");
  assert.equal(revoked.revocable, true);
  const after = await verifyAppSession(request, revokeEnv);
  assert.equal(after, null);
});

test("revoking all sessions blocks existing cookies for the email", async () => {
  const revokeEnv = { ...makeKvEnv(), APP_SESSION_SECRET: SECRET };
  const token = await createAppSessionToken(revokeEnv, { email: "a@b.com" });
  const request = reqWith(`sxs-session=${encodeURIComponent(token)}`);
  assert.ok(await verifyAppSession(request, revokeEnv));

  assert.equal(await revokeAllAppSessionsForEmail(revokeEnv, "A@B.COM"), true);
  assert.equal(await verifyAppSession(request, revokeEnv), null);
});

test("revoking all sessions also blocks legacy sid-less cookies", async () => {
  const revokeEnv = { ...makeKvEnv(), APP_SESSION_SECRET: SECRET };
  const now = Math.floor(Date.now() / 1000);
  const token = await makeSessionToken(SECRET, {
    email: "a@b.com",
    provider: "google",
    exp: now + 600,
    iat: now - 60
  });
  const request = reqWith(`sxs-session=${token}`);
  const before = await verifyAppSession(request, revokeEnv);
  assert.ok(before);
  assert.equal(before.revocable, false);

  assert.equal(await revokeAllAppSessionsForEmail(revokeEnv, "a@b.com", now), true);
  assert.equal(await verifyAppSession(request, revokeEnv), null);
});
