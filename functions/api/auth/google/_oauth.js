import { createAppSessionToken, buildLaunchCookie, buildSessionCookie, readCookie, timingSafeEqual } from "../../_app_session.js";
import { jsonResponse, normalizeEmail } from "../../_auth.js";
import { checkRateLimit, rateLimitResponse } from "../../_rate_limit.js";
import { privatePreviewAllowsIdentity, privatePreviewDeniedRedirect } from "../_private_preview.js";

const OAUTH_COOKIE = "sxs-oauth";
const OAUTH_MAX_AGE = 10 * 60;
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

// HMAC label used when signing the OAuth state envelope so the same
// APP_SESSION_SECRET can't be repurposed across contexts (session cookie vs.
// state cookie vs. anything we add later).
const OAUTH_STATE_HMAC_LABEL = "sxs-oauth-state-v1";

let cachedGoogleJwks = null;
let cachedGoogleJwksAt = 0;
const GOOGLE_JWKS_TTL_MS = 5 * 60 * 1000;

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncodeText(text) {
  return base64UrlEncodeBytes(new TextEncoder().encode(text));
}

function base64UrlDecode(input) {
  const normalized = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function base64UrlDecodeJson(input) {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(input)));
  } catch {
    return null;
  }
}

function randomUrlToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncodeBytes(bytes);
}

async function sha256Url(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(hash));
}

function authBaseUrl(context) {
  const configured = String(context.env?.AUTH_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const url = new URL(context.request.url);
  return url.origin;
}

function callbackUrl(context) {
  return `${authBaseUrl(context)}/api/auth/google/callback`;
}

function readGoogleConfig(env) {
  const clientId = String(env?.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(env?.GOOGLE_CLIENT_SECRET || "").trim();
  const sessionSecret = String(env?.APP_SESSION_SECRET || "").trim();
  if (!clientId || !clientSecret || sessionSecret.length < 32) return null;
  return { clientId, clientSecret };
}

export function googleAuthEnabled(env) {
  return Boolean(readGoogleConfig(env));
}

export function sameOriginPath(value) {
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

function oauthCookie(value, maxAge = OAUTH_MAX_AGE) {
  const expires = new Date(Date.now() + maxAge * 1000).toUTCString();
  return [
    `${OAUTH_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/api/auth/google",
    `Max-Age=${maxAge}`,
    `Expires=${expires}`,
    "Secure",
    "SameSite=Lax",
    "HttpOnly"
  ].join("; ");
}

export function clearOauthCookie() {
  return `${OAUTH_COOKIE}=; Path=/api/auth/google; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax; HttpOnly`;
}

async function stateHmac(env, body) {
  const secret = String(env?.APP_SESSION_SECRET || "").trim();
  if (secret.length < 32) throw new Error("APP_SESSION_SECRET must be at least 32 characters.");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${OAUTH_STATE_HMAC_LABEL}:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

async function encodeOauthState(env, record) {
  const body = base64UrlEncodeText(JSON.stringify(record));
  const sig = await stateHmac(env, body);
  return `${body}.${sig}`;
}

async function readOauthState(env, request) {
  const raw = readCookie(request, OAUTH_COOKIE);
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  let expected = "";
  try { expected = await stateHmac(env, body); }
  catch { return null; }
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const decoded = new TextDecoder().decode(base64UrlDecode(body));
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.state || !parsed.verifier || !parsed.nonce) return null;
    if (Number(parsed.expiresAt || 0) <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Throttle scripted abuse of the OAuth start/callback endpoints. Falls open if
// KV is unavailable (failClosed:false) so a KV blip can never lock real users
// out of sign-in. Keyed by client IP from CF-Connecting-IP, falling back to a
// shared "global" bucket if the header is absent (local preview / unknown).
function oauthRateLimitKey(context) {
  const ip = String(context.request.headers.get("cf-connecting-ip") || "").trim().toLowerCase();
  return ip || "global";
}

async function applyOauthRateLimit(context, bucket) {
  const limited = await checkRateLimit(context.env, {
    bucket,
    key: oauthRateLimitKey(context),
    limit: 30,
    windowSeconds: 60
  });
  if (!limited.ok) return rateLimitResponse(limited.retryAfter);
  return null;
}

export async function startGoogleOAuth(context) {
  const blocked = await applyOauthRateLimit(context, "oauth-start");
  if (blocked) return blocked;

  const config = readGoogleConfig(context.env);
  if (!config) {
    return jsonResponse(503, {
      error: "Google sign-in is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and APP_SESSION_SECRET."
    });
  }

  const url = new URL(context.request.url);
  const returnTo = sameOriginPath(url.searchParams.get("returnTo"));
  const state = randomUrlToken();
  const verifier = randomUrlToken(48);
  const challenge = await sha256Url(verifier);
  // Add a nonce bound to the ID token so a token replayed from another
  // Google client of the same project can't be reused against our app.
  const nonce = randomUrlToken();
  const oauthState = await encodeOauthState(context.env, {
    state,
    verifier,
    nonce,
    returnTo,
    expiresAt: Date.now() + OAUTH_MAX_AGE * 1000
  });

  const destination = new URL(GOOGLE_AUTH_URL);
  destination.searchParams.set("client_id", config.clientId);
  destination.searchParams.set("redirect_uri", callbackUrl(context));
  destination.searchParams.set("response_type", "code");
  destination.searchParams.set("scope", "openid email profile");
  destination.searchParams.set("state", state);
  destination.searchParams.set("nonce", nonce);
  destination.searchParams.set("code_challenge", challenge);
  destination.searchParams.set("code_challenge_method", "S256");
  destination.searchParams.set("prompt", "select_account");

  return new Response(null, {
    status: 302,
    headers: {
      Location: destination.toString(),
      "Set-Cookie": oauthCookie(oauthState),
      "cache-control": "no-store"
    }
  });
}

async function exchangeCode(context, code, verifier) {
  const config = readGoogleConfig(context.env);
  if (!config) throw new Error("Google sign-in is not configured.");
  const body = new URLSearchParams();
  body.set("code", code);
  body.set("client_id", config.clientId);
  body.set("client_secret", config.clientSecret);
  body.set("redirect_uri", callbackUrl(context));
  body.set("grant_type", "authorization_code");
  body.set("code_verifier", verifier);

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.id_token) {
    throw new Error(typeof data.error_description === "string" ? data.error_description : "Google token exchange failed.");
  }
  return data.id_token;
}

async function fetchGoogleJwks() {
  const now = Date.now();
  if (cachedGoogleJwks && now - cachedGoogleJwksAt < GOOGLE_JWKS_TTL_MS) return cachedGoogleJwks;
  const response = await fetch(GOOGLE_JWKS_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  if (data?.keys?.length) {
    cachedGoogleJwks = data;
    cachedGoogleJwksAt = now;
  }
  return cachedGoogleJwks;
}

async function verifyGoogleIdToken(env, idToken, expectedNonce) {
  const config = readGoogleConfig(env);
  if (!config) return null;
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = base64UrlDecodeJson(headerB64);
  const payload = base64UrlDecodeJson(payloadB64);
  if (!header || !payload || header.alg !== "RS256") return null;
  if (payload.aud !== config.clientId) return null;
  if (!["accounts.google.com", "https://accounts.google.com"].includes(payload.iss)) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= nowSec) return null;
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + 60) return null;
  if (payload.email_verified !== true && payload.email_verified !== "true") return null;
  // Bind this verification to the nonce we issued at OAuth start. Without
  // this, a token Google issued for a different client (or for a stale
  // login attempt) could be replayed against our callback.
  if (!expectedNonce || payload.nonce !== expectedNonce) return null;

  const jwks = await fetchGoogleJwks();
  const jwk = jwks?.keys?.find((key) => key.kid === header.kid);
  if (!jwk) return null;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlDecode(signatureB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    );
    return ok ? payload : null;
  } catch {
    return null;
  }
}

export async function finishGoogleOAuth(context) {
  const blocked = await applyOauthRateLimit(context, "oauth-callback");
  if (blocked) return blocked;

  const url = new URL(context.request.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const error = url.searchParams.get("error") || "";
  const headers = new Headers({ "cache-control": "no-store" });
  headers.append("Set-Cookie", clearOauthCookie());

  if (error) {
    headers.set("Location", `/signin?auth=google_error`);
    return new Response(null, { status: 302, headers });
  }
  const stored = await readOauthState(context.env, context.request);
  if (!code || !state || !stored || stored.state !== state) {
    headers.set("Location", `/signin?auth=state_error`);
    return new Response(null, { status: 302, headers });
  }

  let claims = null;
  try {
    const idToken = await exchangeCode(context, code, stored.verifier);
    claims = await verifyGoogleIdToken(context.env, idToken, stored.nonce);
  } catch {
    claims = null;
  }
  const email = normalizeEmail(claims?.email);
  if (!email) {
    headers.set("Location", `/signin?auth=google_error`);
    return new Response(null, { status: 302, headers });
  }
  if (!(await privatePreviewAllowsIdentity(context.env, email))) {
    headers.set("Location", privatePreviewDeniedRedirect(context.request));
    return new Response(null, { status: 302, headers });
  }

  const sessionToken = await createAppSessionToken(context.env, {
    email,
    name: claims.name || "",
    picture: claims.picture || ""
  });
  headers.append("Set-Cookie", buildSessionCookie(sessionToken));
  headers.append("Set-Cookie", buildLaunchCookie());
  headers.set("Location", sameOriginPath(stored.returnTo) || "/");
  return new Response(null, { status: 302, headers });
}
