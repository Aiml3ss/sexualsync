// POST /api/auth/persist
//
// Server-set session cookie so iOS PWAs survive an "Add to Home Screen"
// install. JavaScript-set cookies aren't reliably inherited from Safari to
// the standalone WebView, but **server-set** cookies (Set-Cookie HTTP
// response header) are — that's what this endpoint exists to write.
//
// Client flow:
//   1. Supabase JS signs in (Google OAuth) → client has { access_token, refresh_token }.
//   2. Client POSTs both here.
//   3. We verify the access_token against Supabase, then set an HttpOnly
//      cookie holding the refresh token. The PWA inherits it.
//   4. /api/auth/hydrate later exchanges the cookie for a fresh access token.

import { jsonResponse } from "../_auth.js";
import { PRIVATE_PREVIEW_DENIED_MESSAGE, privatePreviewAllowsIdentity } from "./_private_preview.js";

const COOKIE_NAME = "sxs-refresh";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 60; // 60 days

function buildCookie(name, value, opts = {}) {
  const maxAge = opts.maxAge ?? COOKIE_MAX_AGE;
  // Older iOS WebKit honours Expires more reliably than Max-Age across the
  // Safari → standalone-PWA WebView boundary, so we send both.
  const expires = new Date(Date.now() + maxAge * 1000).toUTCString();
  const parts = [
    `${name}=${value}`,
    `Path=/`,
    `Max-Age=${maxAge}`,
    `Expires=${expires}`,
    "Secure",
    "SameSite=Lax",
    "HttpOnly",
  ];
  return parts.join("; ");
}

function legacySupabaseAuthEnabled(env) {
  return String(env?.ENABLE_LEGACY_SUPABASE_AUTH || "").trim() === "1";
}

async function verifyAccessToken(env, accessToken) {
  if (!accessToken || !env?.SUPABASE_URL || !env?.SUPABASE_ANON_KEY) return null;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "apikey": env.SUPABASE_ANON_KEY,
      },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user?.email || null;
  } catch { return null; }
}

export async function onRequest(context) {
  const method = context.request.method.toUpperCase();
  if (method !== "POST") return jsonResponse(405, { error: "Method not allowed." });
  if (!legacySupabaseAuthEnabled(context.env)) {
    return jsonResponse(410, { error: "Legacy Supabase auth is retired." });
  }

  let payload = {};
  try { payload = await context.request.json(); }
  catch { return jsonResponse(400, { error: "Invalid JSON." }); }

  const accessToken  = String(payload.access_token  || "").trim();
  const refreshToken = String(payload.refresh_token || "").trim();
  if (!accessToken || !refreshToken) {
    return jsonResponse(400, { error: "access_token and refresh_token are required." });
  }

  const email = await verifyAccessToken(context.env, accessToken);
  if (!email) {
    return jsonResponse(401, { error: "Token didn't validate against Supabase." });
  }
  if (!(await privatePreviewAllowsIdentity(context.env, email))) {
    return jsonResponse(403, { error: PRIVATE_PREVIEW_DENIED_MESSAGE });
  }

  // Set the HttpOnly refresh cookie. Supabase refresh tokens are opaque
  // strings ~50-100 chars, well under the 4KB cookie limit.
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  headers.append("Set-Cookie", buildCookie(COOKIE_NAME, encodeURIComponent(refreshToken)));
  return new Response(JSON.stringify({ ok: true, email }), { status: 200, headers });
}
