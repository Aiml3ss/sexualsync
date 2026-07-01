import { buildLaunchCookie, buildSessionCookie, createAppSessionToken, timingSafeEqual } from "../../_app_session.js";
import { jsonResponse, normalizeEmail } from "../../_auth.js";
import { sendSignInCodeEmail, isEmailEnabled } from "../../_email.js";
import { checkRateLimit, constantTimeResponse, rateLimitResponse } from "../../_rate_limit.js";
import { mutateKey } from "../../_state.js";
import { PRIVATE_PREVIEW_DENIED_MESSAGE, privatePreviewAllowsIdentity } from "../_private_preview.js";

const EMAIL_AUTH_STORE = "sexualsync-email-auth";
const EMAIL_AUTH_KEY = "challenges";
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_CODE_LENGTH = 6;
const MAX_ATTEMPTS = 5;
const MAX_CHALLENGES = 600;
const VERIFY_MIN_MS = 250;
const CODE_HMAC_LABEL = "sxs-email-code-v1";

const GENERIC_SENT_MESSAGE = "If that email can receive sign-in codes, we sent one.";
const GENERIC_VERIFY_ERROR = "That code didn't work. Check the latest email and try again.";

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function readSessionSecret(env) {
  const secret = String(env?.APP_SESSION_SECRET || "").trim();
  return secret.length >= 32 ? secret : "";
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function cleanCode(value) {
  return String(value || "").replace(/\D+/g, "").slice(0, EMAIL_CODE_LENGTH);
}

function sameOriginPath(value) {
  const fallback = "/";
  if (!value) return fallback;
  try {
    const url = new URL(value, "https://sexualsync.local");
    if (url.origin !== "https://sexualsync.local") return fallback;
    if (!url.pathname.startsWith("/")) return fallback;
    if (url.pathname.startsWith("/api/auth/")) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

function clientIp(context) {
  return String(context.request.headers.get("cf-connecting-ip") || "").trim().toLowerCase() || "global";
}

async function hmacCode(env, email, code) {
  const secret = readSessionSecret(env);
  if (!secret) throw new Error("APP_SESSION_SECRET must be at least 32 characters.");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${CODE_HMAC_LABEL}:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const value = `${normalizeEmail(email)}\0${cleanCode(code)}`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function randomInt(max) {
  const limit = Math.floor(0xffffffff / max) * max;
  const bytes = new Uint32Array(1);
  do {
    crypto.getRandomValues(bytes);
  } while (bytes[0] >= limit);
  return bytes[0] % max;
}

function randomCode() {
  return String(randomInt(10 ** EMAIL_CODE_LENGTH)).padStart(EMAIL_CODE_LENGTH, "0");
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function pruneChallenges(challenges, now = Date.now()) {
  return asList(challenges)
    .filter((challenge) => {
      const expiresAt = new Date(challenge.expiresAt || 0).getTime();
      return Number.isFinite(expiresAt) && expiresAt > now - 24 * 60 * 60 * 1000;
    })
    .slice(0, MAX_CHALLENGES);
}

function isActiveChallenge(challenge, now = Date.now()) {
  if (!challenge || challenge.consumedAt) return false;
  const expiresAt = new Date(challenge.expiresAt || 0).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function emailAuthEnabled(env) {
  return Boolean(readSessionSecret(env) && isEmailEnabled(env));
}

async function parseJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function applyEmailStartRateLimit(context, email) {
  const env = context.env;
  const checks = [
    { bucket: "email-auth-start-ip", key: clientIp(context), limit: 8, windowSeconds: 15 * 60 },
    { bucket: "email-auth-start-email", key: email, limit: 4, windowSeconds: 30 * 60 }
  ];
  for (const check of checks) {
    const limited = await checkRateLimit(env, { ...check, failClosed: true });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
  }
  return null;
}

async function applyEmailVerifyRateLimit(context, email) {
  const env = context.env;
  const checks = [
    { bucket: "email-auth-verify-ip", key: clientIp(context), limit: 20, windowSeconds: 15 * 60 },
    { bucket: "email-auth-verify-email", key: email, limit: 10, windowSeconds: 15 * 60 }
  ];
  for (const check of checks) {
    const limited = await checkRateLimit(env, { ...check, failClosed: true });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
  }
  return null;
}

export async function createEmailAuthChallenge(env, { email, returnTo = "/" }) {
  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail)) throw new Error("A valid email is required.");
  const code = randomCode();
  const now = new Date();
  const challenge = {
    id: crypto.randomUUID(),
    email: normalizedEmail,
    codeHash: await hmacCode(env, normalizedEmail, code),
    returnTo: sameOriginPath(returnTo),
    attempts: 0,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS).toISOString(),
    consumedAt: ""
  };

  await mutateKey(env, EMAIL_AUTH_STORE, EMAIL_AUTH_KEY, (current) => {
    const challenges = pruneChallenges(current).filter((item) => {
      return !(item.email === normalizedEmail && isActiveChallenge(item));
    });
    return { value: [challenge, ...challenges].slice(0, MAX_CHALLENGES) };
  });

  return { ...challenge, code };
}

export async function verifyEmailAuthChallenge(env, { email, code }) {
  const normalizedEmail = normalizeEmail(email);
  const cleanedCode = cleanCode(code);
  if (!validEmail(normalizedEmail) || cleanedCode.length !== EMAIL_CODE_LENGTH) {
    return { ok: false };
  }
  const codeHash = await hmacCode(env, normalizedEmail, cleanedCode);
  const nowIso = new Date().toISOString();

  return mutateKey(env, EMAIL_AUTH_STORE, EMAIL_AUTH_KEY, (current) => {
    const challenges = pruneChallenges(current);
    const index = challenges.findIndex((challenge) => {
      return challenge.email === normalizedEmail && isActiveChallenge(challenge);
    });
    if (index === -1) return { value: challenges, result: { ok: false } };

    const challenge = challenges[index];
    if (Number(challenge.attempts || 0) >= MAX_ATTEMPTS) {
      const next = challenges.map((item, itemIndex) => {
        return itemIndex === index ? { ...item, consumedAt: nowIso } : item;
      });
      return { value: next, result: { ok: false } };
    }

    if (!timingSafeEqual(challenge.codeHash, codeHash)) {
      const attempts = Number(challenge.attempts || 0) + 1;
      const next = challenges.map((item, itemIndex) => {
        if (itemIndex !== index) return item;
        return {
          ...item,
          attempts,
          lastAttemptAt: nowIso,
          consumedAt: attempts >= MAX_ATTEMPTS ? nowIso : item.consumedAt || ""
        };
      });
      return { value: next, result: { ok: false } };
    }

    const consumed = { ...challenge, consumedAt: nowIso };
    const next = challenges.map((item, itemIndex) => itemIndex === index ? consumed : item);
    return {
      value: next,
      result: {
        ok: true,
        email: challenge.email,
        returnTo: sameOriginPath(challenge.returnTo)
      }
    };
  });
}

export async function startEmailSignIn(context) {
  const method = context.request.method.toUpperCase();
  if (method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }
  if (!emailAuthEnabled(context.env)) {
    return jsonResponse(503, { error: "Email sign-in is not configured." });
  }

  const payload = await parseJson(context.request);
  const email = normalizeEmail(payload.email);
  if (!validEmail(email)) {
    return jsonResponse(400, { error: "Enter a valid email address." });
  }
  // Rate-limit BEFORE the allowlist check so the 403 path can't be used as an
  // unthrottled allowlist-membership enumeration oracle (audit L7): the IP
  // bucket (8/15min) caps probing of which addresses are allowlisted.
  const limited = await applyEmailStartRateLimit(context, email);
  if (limited) return limited;

  if (!(await privatePreviewAllowsIdentity(context.env, email))) {
    return jsonResponse(403, { error: PRIVATE_PREVIEW_DENIED_MESSAGE });
  }

  const challenge = await createEmailAuthChallenge(context.env, {
    email,
    returnTo: payload.returnTo
  });
  const sent = await sendSignInCodeEmail(context.env, { to: email, code: challenge.code });
  if (!sent.ok) {
    return jsonResponse(502, { error: "Couldn't send the sign-in email. Try again soon." });
  }

  return jsonResponse(200, {
    ok: true,
    message: GENERIC_SENT_MESSAGE,
    expiresInSeconds: Math.floor(EMAIL_CODE_TTL_MS / 1000)
  });
}

export async function verifyEmailSignIn(context) {
  const startedAt = Date.now();
  const method = context.request.method.toUpperCase();
  if (method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }
  if (!emailAuthEnabled(context.env)) {
    return jsonResponse(503, { error: "Email sign-in is not configured." });
  }

  const payload = await parseJson(context.request);
  const email = normalizeEmail(payload.email);
  if (validEmail(email) && !(await privatePreviewAllowsIdentity(context.env, email))) {
    return constantTimeResponse(startedAt, VERIFY_MIN_MS, jsonResponse(403, { error: PRIVATE_PREVIEW_DENIED_MESSAGE }));
  }
  const limited = await applyEmailVerifyRateLimit(context, email || "missing");
  if (limited) return limited;

  const verified = await verifyEmailAuthChallenge(context.env, {
    email,
    code: payload.code
  });
  if (!verified.ok) {
    return constantTimeResponse(startedAt, VERIFY_MIN_MS, jsonResponse(400, { error: GENERIC_VERIFY_ERROR }));
  }

  const sessionToken = await createAppSessionToken(context.env, {
    email: verified.email,
    provider: "email"
  });
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "Set-Cookie": buildSessionCookie(sessionToken)
  });
  headers.append("Set-Cookie", buildLaunchCookie());
  const response = new Response(JSON.stringify({
    ok: true,
    returnTo: sameOriginPath(verified.returnTo)
  }), { status: 200, headers });
  return constantTimeResponse(startedAt, VERIFY_MIN_MS, response);
}
