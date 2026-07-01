import { getStore } from "./_kv.js";

const SESSION_COOKIE = "sxs-session";
const LAUNCH_COOKIE = "sxs-launch";
const SESSION_REVOCATION_STORE = "sexualsync-session-revocations";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncodeText(text) {
  return base64UrlEncodeBytes(new TextEncoder().encode(text));
}

function base64UrlDecodeText(input) {
  const normalized = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function readSecret(env) {
  const secret = String(env?.APP_SESSION_SECRET || "").trim();
  return secret.length >= 32 ? secret : "";
}

async function hmac(env, value) {
  const secret = readSecret(env);
  if (!secret) throw new Error("APP_SESSION_SECRET must be at least 32 characters.");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function randomSessionId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncodeBytes(bytes);
}

function revocationStore(env) {
  if (!env?.STORE) return null;
  try { return getStore(env, SESSION_REVOCATION_STORE); }
  catch { return null; }
}

async function sha256Id(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value || "")));
  return base64UrlEncodeBytes(new Uint8Array(digest));
}

async function userRevocationKey(email) {
  return `user:${await sha256Id(String(email || "").trim().toLowerCase())}`;
}

function sessionRevocationKey(sessionId) {
  return `session:${String(sessionId || "").replace(/[^a-z0-9:_-]/gi, "").slice(0, 120)}`;
}

async function revokedBeforeForEmail(env, email) {
  const store = revocationStore(env);
  if (!store || !email) return 0;
  try {
    const value = await store.get(await userRevocationKey(email), { type: "text" });
    const number = Number(value || 0);
    return Number.isFinite(number) ? Math.floor(number) : 0;
  } catch {
    return 0;
  }
}

async function sessionIdRevoked(env, sessionId) {
  const store = revocationStore(env);
  if (!store || !sessionId) return false;
  try {
    return Boolean(await store.get(sessionRevocationKey(sessionId), { type: "text" }));
  } catch {
    return false;
  }
}

async function payloadRevoked(env, payload) {
  const email = String(payload?.email || "").trim().toLowerCase();
  const sid = String(payload?.sid || "");
  // Both checks run on EVERY authenticated request — read the two independent
  // revocation keys in parallel instead of paying two serial KV round-trips.
  const [sidRevoked, revokedBefore] = await Promise.all([
    sid ? sessionIdRevoked(env, sid) : false,
    revokedBeforeForEmail(env, email),
  ]);
  if (sidRevoked) return true;
  return Boolean(revokedBefore && Number(payload?.iat || 0) <= revokedBefore);
}

export function timingSafeEqual(a, b) {
  const left = new TextEncoder().encode(String(a || ""));
  const right = new TextEncoder().encode(String(b || ""));
  let diff = left.length ^ right.length;
  const max = Math.max(left.length, right.length);
  for (let index = 0; index < max; index += 1) {
    diff |= (left[index] || 0) ^ (right[index] || 0);
  }
  return diff === 0;
}

export function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = header.match(new RegExp("(?:^|; )" + escaped + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : "";
}

export async function createAppSessionToken(env, claims) {
  const now = Math.floor(Date.now() / 1000);
  const provider = String(claims.provider || "google").trim().toLowerCase();
  const sessionProvider = provider === "email" || provider === "local" ? provider : "google";
  const payload = {
    sid: randomSessionId(),
    provider: sessionProvider,
    email: String(claims.email || "").trim().toLowerCase(),
    name: String(claims.name || "").trim().slice(0, 120),
    picture: String(claims.picture || "").trim().slice(0, 500),
    iat: now,
    exp: now + SESSION_MAX_AGE
  };
  if (!payload.email) throw new Error("Session email is required.");
  const body = base64UrlEncodeText(JSON.stringify(payload));
  const signature = await hmac(env, body);
  return `${body}.${signature}`;
}

async function readVerifiedSessionPayload(request, env, { checkRevocation = true } = {}) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !readSecret(env)) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  let expected = "";
  try { expected = await hmac(env, body); }
  catch { return null; }
  if (!timingSafeEqual(signature, expected)) return null;
  let payload = null;
  try { payload = JSON.parse(base64UrlDecodeText(body)); }
  catch { return null; }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  if (!payload.email || typeof payload.email !== "string") return null;
  if (checkRevocation && await payloadRevoked(env, payload)) return null;
  return payload;
}

export async function verifyAppSession(request, env) {
  const payload = await readVerifiedSessionPayload(request, env);
  if (!payload) return null;
  return {
    email: payload.email.trim().toLowerCase(),
    name: payload.name || "",
    picture: payload.picture || "",
    provider: payload.provider || "google",
    sessionId: payload.sid || "",
    issuedAt: payload.iat || 0,
    expiresAt: payload.exp || 0,
    revocable: Boolean(payload.sid)
  };
}

export async function revokeAppSessionById(env, sessionId, expiresAt = 0) {
  const store = revocationStore(env);
  if (!store || !sessionId) return false;
  const ttl = Math.max(60, Math.floor(Number(expiresAt || 0) - Math.floor(Date.now() / 1000)));
  try {
    await store.put(sessionRevocationKey(sessionId), "1", { expirationTtl: ttl });
    return true;
  } catch {
    return false;
  }
}

export async function revokeAllAppSessionsForEmail(env, email, revokedBefore = Math.floor(Date.now() / 1000)) {
  const store = revocationStore(env);
  const normalized = String(email || "").trim().toLowerCase();
  if (!store || !normalized) return false;
  try {
    await store.put(await userRevocationKey(normalized), String(Math.floor(Number(revokedBefore) || 0)));
    return true;
  } catch {
    return false;
  }
}

export async function revokeCurrentAppSession(request, env) {
  const payload = await readVerifiedSessionPayload(request, env, { checkRevocation: false });
  if (!payload) return null;
  if (payload.sid) await revokeAppSessionById(env, payload.sid, payload.exp);
  return {
    email: String(payload.email || "").trim().toLowerCase(),
    sessionId: payload.sid || "",
    issuedAt: payload.iat || 0,
    expiresAt: payload.exp || 0,
    revocable: Boolean(payload.sid)
  };
}

export function buildSessionCookie(token, maxAge = SESSION_MAX_AGE) {
  const expires = new Date(Date.now() + maxAge * 1000).toUTCString();
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    `Expires=${expires}`,
    "Secure",
    "SameSite=Lax",
    "HttpOnly"
  ].join("; ");
}

export function buildLaunchCookie(maxAge = 2 * 60) {
  const expires = new Date(Date.now() + maxAge * 1000).toUTCString();
  return [
    `${LAUNCH_COOKIE}=1`,
    "Path=/",
    `Max-Age=${maxAge}`,
    `Expires=${expires}`,
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax; HttpOnly`;
}

export const APP_SESSION_COOKIE_NAME = SESSION_COOKIE;
export const APP_LAUNCH_COOKIE_NAME = LAUNCH_COOKIE;
