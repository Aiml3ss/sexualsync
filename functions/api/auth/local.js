import { buildLaunchCookie, buildSessionCookie, createAppSessionToken, timingSafeEqual } from "../_app_session.js";
import { jsonResponse, normalizeEmail } from "../_auth.js";
import { checkRateLimit, constantTimeResponse, rateLimitResponse } from "../_rate_limit.js";
import { mutateKey, readKey } from "../_state.js";
import { localPasswordAuthEnabled, selfHostLocalPasswordAllowsEmail } from "./_local_password.js";

const LOCAL_AUTH_STORE = "sexualsync-local-auth";
const LOCAL_AUTH_KEY = "users";
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const HASH_ITERATIONS = 600_000;
const VERIFY_MIN_MS = 250;
const GENERIC_LOGIN_ERROR = "Email or password is incorrect.";

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeBytes(input) {
  const normalized = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function cleanPassword(value) {
  return String(value || "");
}

function passwordValid(password) {
  return password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;
}

function cleanName(value) {
  return String(value || "").trim().slice(0, 120);
}

function sameOriginPath(value) {
  if (!value) return "/sexboard";
  try {
    const url = new URL(value, "https://sexualsync.local");
    if (url.origin !== "https://sexualsync.local") return "/sexboard";
    if (!url.pathname.startsWith("/") || url.pathname.startsWith("/api/auth/")) return "/sexboard";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/sexboard";
  }
}

function clientIp(context) {
  return String(context.request.headers.get("cf-connecting-ip") || "").trim().toLowerCase() || "global";
}

function userKey(email) {
  return normalizeEmail(email);
}

function asUsers(value) {
  return Array.isArray(value) ? value : [];
}

async function hashPassword(password, saltBytes, iterations = HASH_ITERATIONS) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`sxs-local-password-v1\0${password}`),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
    key,
    256
  );
  return base64UrlEncodeBytes(new Uint8Array(bits));
}

async function makePasswordRecord({ email, password, name }) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const now = new Date().toISOString();
  return {
    email: userKey(email),
    name: cleanName(name),
    salt: base64UrlEncodeBytes(salt),
    passwordHash: await hashPassword(password, salt),
    iterations: HASH_ITERATIONS,
    createdAt: now,
    updatedAt: now
  };
}

async function verifyPassword(user, password) {
  try {
    const salt = base64UrlDecodeBytes(user?.salt);
    const iterations = Number(user?.iterations || 0);
    if (!salt.length || !Number.isFinite(iterations) || iterations < 100_000) return false;
    const actual = await hashPassword(password, salt, iterations);
    return timingSafeEqual(actual, String(user?.passwordHash || ""));
  } catch {
    return false;
  }
}

async function parseJson(request) {
  try { return await request.json(); }
  catch { return {}; }
}

async function applyLocalAuthRateLimit(context, email, mode) {
  const checks = [
    { bucket: `local-auth-${mode}-ip`, key: clientIp(context), limit: mode === "register" ? 12 : 30, windowSeconds: 15 * 60 },
    { bucket: `local-auth-${mode}-email`, key: email || "missing", limit: mode === "register" ? 5 : 12, windowSeconds: 15 * 60 }
  ];
  for (const check of checks) {
    const limited = await checkRateLimit(context.env, { ...check, failClosed: true });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
  }
  return null;
}

async function createSessionResponse(env, user, returnTo) {
  const sessionToken = await createAppSessionToken(env, {
    email: user.email,
    name: user.name || "",
    provider: "local"
  });
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "Set-Cookie": buildSessionCookie(sessionToken)
  });
  headers.append("Set-Cookie", buildLaunchCookie());
  return new Response(JSON.stringify({
    ok: true,
    email: user.email,
    returnTo: sameOriginPath(returnTo)
  }), { status: 200, headers });
}

async function register(context, payload) {
  const email = normalizeEmail(payload.email);
  const password = cleanPassword(payload.password);
  if (!validEmail(email)) return jsonResponse(400, { error: "Enter a valid email address." });
  if (!passwordValid(password)) return jsonResponse(400, { error: "Password must be 8-200 characters." });
  if (!selfHostLocalPasswordAllowsEmail(context.env, email)) {
    return jsonResponse(403, { error: "This email is not allowed on this private self-host." });
  }
  const limited = await applyLocalAuthRateLimit(context, email, "register");
  if (limited) return limited;

  const record = await makePasswordRecord({ email, password, name: payload.name });
  const result = await mutateKey(context.env, LOCAL_AUTH_STORE, LOCAL_AUTH_KEY, (current) => {
    const users = asUsers(current);
    if (users.some((user) => userKey(user.email) === email)) {
      return { value: users, result: { ok: false, reason: "exists" }, write: false };
    }
    return { value: [record, ...users], result: { ok: true, user: record } };
  });

  if (!result?.ok) return jsonResponse(409, { error: "Account already exists. Sign in instead." });
  return createSessionResponse(context.env, result.user, payload.returnTo);
}

async function login(context, payload) {
  const startedAt = Date.now();
  const email = normalizeEmail(payload.email);
  const password = cleanPassword(payload.password);
  if (!validEmail(email) || !passwordValid(password)) {
    return constantTimeResponse(startedAt, VERIFY_MIN_MS, jsonResponse(400, { error: GENERIC_LOGIN_ERROR }));
  }
  if (!selfHostLocalPasswordAllowsEmail(context.env, email)) {
    return constantTimeResponse(startedAt, VERIFY_MIN_MS, jsonResponse(403, { error: "This email is not allowed on this private self-host." }));
  }
  const limited = await applyLocalAuthRateLimit(context, email, "login");
  if (limited) return limited;

  const users = asUsers(await readKey(context.env, LOCAL_AUTH_STORE, LOCAL_AUTH_KEY));
  const user = users.find((item) => userKey(item.email) === email);
  if (!user || !(await verifyPassword(user, password))) {
    return constantTimeResponse(startedAt, VERIFY_MIN_MS, jsonResponse(400, { error: GENERIC_LOGIN_ERROR }));
  }
  const response = await createSessionResponse(context.env, user, payload.returnTo);
  return constantTimeResponse(startedAt, VERIFY_MIN_MS, response);
}

export async function onRequest(context) {
  if (!localPasswordAuthEnabled(context.env)) {
    return jsonResponse(404, { error: "API route not found." });
  }
  if (context.request.method.toUpperCase() !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }
  const payload = await parseJson(context.request);
  const mode = String(payload.mode || "login").trim().toLowerCase();
  if (mode === "register") return register(context, payload);
  return login(context, payload);
}
