// GET /api/auth/hydrate
//
// Reads the HttpOnly refresh cookie, exchanges it with Supabase for a fresh
// access_token + rotated refresh_token, and returns both. Client uses these
// to call client.auth.setSession() so the PWA appears already signed-in.

import { jsonResponse } from "../_auth.js";
import { PRIVATE_PREVIEW_DENIED_MESSAGE, privatePreviewAllowsIdentity } from "./_private_preview.js";

const COOKIE_NAME = "sxs-refresh";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 60; // 60 days

function readCookie(req, name) {
  const header = req.headers.get("cookie") || "";
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = header.match(new RegExp("(?:^|; )" + escaped + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

function buildCookie(name, value, opts = {}) {
  const maxAge = opts.maxAge ?? COOKIE_MAX_AGE;
  // Belt + suspenders: send both Max-Age and Expires so older iOS WebKit
  // (notably the standalone PWA shell) honours the lifetime correctly.
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
function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax; HttpOnly`;
}

function legacySupabaseAuthEnabled(env) {
  return String(env?.ENABLE_LEGACY_SUPABASE_AUTH || "").trim() === "1";
}

export async function onRequest(context) {
  const method = context.request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }
  if (!legacySupabaseAuthEnabled(context.env)) {
    const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    headers.append("Set-Cookie", clearCookie(COOKIE_NAME));
    return new Response(JSON.stringify({ error: "Legacy Supabase auth is retired." }), { status: 410, headers });
  }
  const env = context.env;
  if (!env?.SUPABASE_URL || !env?.SUPABASE_ANON_KEY) {
    return jsonResponse(503, { error: "Auth not configured." });
  }

  const refresh = readCookie(context.request, COOKIE_NAME);
  if (!refresh) return jsonResponse(401, { error: "No session cookie." });

  let res;
  try {
    res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "apikey": env.SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ refresh_token: refresh }),
    });
  } catch {
    return jsonResponse(502, { error: "Couldn't reach auth provider." });
  }

  if (!res.ok) {
    // Refresh token rejected — clear the cookie and tell the client to re-auth.
    const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
    headers.append("Set-Cookie", clearCookie(COOKIE_NAME));
    return new Response(JSON.stringify({ error: "Session expired." }), { status: 401, headers });
  }

  let data;
  try { data = await res.json(); }
  catch { return jsonResponse(502, { error: "Bad response from auth provider." }); }

  const accessToken  = data?.access_token;
  const refreshToken = data?.refresh_token;
  const expiresIn    = data?.expires_in || 3600;
  const user         = data?.user || null;

  if (!accessToken || !refreshToken) {
    return jsonResponse(502, { error: "Auth provider returned an incomplete session." });
  }
  if (!(await privatePreviewAllowsIdentity(env, user?.email))) {
    const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    headers.append("Set-Cookie", clearCookie(COOKIE_NAME));
    return new Response(JSON.stringify({ error: PRIVATE_PREVIEW_DENIED_MESSAGE }), { status: 403, headers });
  }

  // Rotate the refresh cookie so each hydrate extends the 60-day window.
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  headers.append("Set-Cookie", buildCookie(COOKIE_NAME, encodeURIComponent(refreshToken)));
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: expiresIn,
      user,
    }),
    { status: 200, headers }
  );
}
