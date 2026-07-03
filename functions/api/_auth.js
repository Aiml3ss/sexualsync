// Identity helpers for Cloudflare Pages Functions.
//
// In production, requests are authenticated by the first-party Google OAuth
// session cookie (`sxs-session`). Verified legacy Cloudflare Access JWTs are
// also accepted. (The legacy Supabase-token sign-in path has been removed.)
//
// Cloudflare Access path:
//   - CF Access verifies the user's session and injects `Cf-Access-Jwt-Assertion`
//     (a signed JWT) into the request headers.
//   - This module verifies that JWT's RS256 signature against the team's JWKS,
//     validates `aud` against the configured app AUD tag, validates expiry,
//     and trusts the `email` claim.
//   - If verification fails, the request continues to the next auth path.
//
// In local development (`wrangler pages dev`), CF Access is not in front of
// the worker. The local-host bypass returns a placeholder identity so the UI
// is testable end-to-end. In self-host, the Node bridge also stamps
// CF-Connecting-IP from the socket; when present, local preview only accepts
// loopback clients so a public request cannot spoof Host: localhost.

import { jsonResponse } from "./_http.js";
import { verifyAppSession } from "./_app_session.js";
import { isSelfHostNodeRuntime } from "./_runtime.js";
import { selfHostLocalPasswordAllowsEmail } from "./auth/_local_password.js";
import { PRIVATE_PREVIEW_DENIED_MESSAGE, privatePreviewAllowsIdentity } from "./auth/_private_preview.js";

export const APP_NAME = "sexualsync.io";

export const LEGACY_WORKSPACE_ID = "legacy-couple";
export const LEGACY_WORKSPACE_NAME = APP_NAME;
export const LEGACY_DISPLAY_NAME = "Your room";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOCAL_CLIENT_IPS = new Set(["127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1"]);
const LOCAL_PREVIEW_EMAIL = "local-preview@example.test";

// Re-exported from ./_http.js so existing `import { jsonResponse } from
// "./_auth.js"` callers keep working after the helper moved out of this module.
export { jsonResponse };

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

// ---------- JWT verification (CF Access RS256) ----------

function base64UrlDecode(input) {
  const normalized = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlDecodeJson(input) {
  try {
    const bytes = base64UrlDecode(input);
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Cache the JWKS in module scope across requests within a single isolate.
// CF rotates Access signing keys periodically; refresh every 5 minutes.
let cachedJwks = null;
let cachedJwksFetchedAt = 0;
const JWKS_TTL_MS = 5 * 60 * 1000;

async function fetchJwks(teamDomain) {
  const now = Date.now();
  if (cachedJwks && now - cachedJwksFetchedAt < JWKS_TTL_MS) {
    return cachedJwks;
  }
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const response = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  if (data && Array.isArray(data.keys)) {
    cachedJwks = data;
    cachedJwksFetchedAt = now;
  }
  return cachedJwks;
}

async function verifyCfAccessJwt(token, env) {
  if (!token) return null;
  const teamDomain = (env?.CF_ACCESS_TEAM_DOMAIN || "").trim();
  const expectedAud = (env?.CF_ACCESS_AUD || "").trim();
  if (!teamDomain || !expectedAud) {
    // Misconfigured. Refuse to validate rather than silently accept.
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = base64UrlDecodeJson(headerB64);
  const payload = base64UrlDecodeJson(payloadB64);
  if (!header || !payload) return null;
  if (header.alg !== "RS256") return null;

  // aud may be string or array. CF Access uses an array of one.
  const aud = payload.aud;
  const audMatches = Array.isArray(aud) ? aud.includes(expectedAud) : aud === expectedAud;
  if (!audMatches) return null;

  // iss must match the team domain.
  const expectedIss = `https://${teamDomain}`;
  if (payload.iss && payload.iss !== expectedIss) return null;

  // exp/nbf checks
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < nowSec) return null;
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + 60) return null;

  const jwks = await fetchJwks(teamDomain);
  if (!jwks) return null;
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const signature = base64UrlDecode(signatureB64);
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      data
    );
    return ok ? payload : null;
  } catch {
    return null;
  }
}

// ---------- Identity resolution ----------

function isLocalRequest(request) {
  try {
    const url = new URL(request.url);
    if (!LOCAL_HOSTS.has(url.hostname)) return false;
    const clientIp = String(request.headers.get("cf-connecting-ip") || "").trim().toLowerCase();
    return !clientIp || LOCAL_CLIENT_IPS.has(clientIp);
  } catch {
    return false;
  }
}

function extractEmailFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  // Pin to standard claims only. No recursive search — see audit §1.2.
  const candidates = [payload.email, payload.sub];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const match = candidate.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (match) return normalizeEmail(match[0]);
  }
  return "";
}

export async function getAuthenticatedIdentity(context) {
  const { request, env } = context;

  // Local preview identity is a development convenience only. Gate it on an
  // explicit env flag, localhost URL, and (when the runtime supplies it) a
  // loopback client IP. That keeps a public self-host from accepting a forged
  // Host: localhost request.
  if (env?.ALLOW_LOCAL_PREVIEW === "1" && isLocalRequest(request)) {
    return {
      ok: true,
      email: LOCAL_PREVIEW_EMAIL,
      person: "",
      isKnownCoupleMember: false,
      provider: "local",
      sessionId: "",
      issuedAt: 0,
      expiresAt: 0,
      revocable: false
    };
  }

  // 1) Try first-party Google OAuth session — the primary production path.
  const appSession = await verifyAppSession(request, env);
  if (appSession?.email) {
    const email = normalizeEmail(appSession.email);
    const localPasswordSessionAllowed = appSession.provider === "local"
      && isSelfHostNodeRuntime(env)
      && selfHostLocalPasswordAllowsEmail(env, email);
    if (!localPasswordSessionAllowed && !(await privatePreviewAllowsIdentity(env, email))) {
      return {
        ok: false,
        response: jsonResponse(403, {
          error: PRIVATE_PREVIEW_DENIED_MESSAGE
        })
      };
    }
    return {
      ok: true,
      email,
      person: "",
      isKnownCoupleMember: false,
      provider: appSession.provider || "google",
      sessionId: appSession.sessionId || "",
      issuedAt: appSession.issuedAt || 0,
      expiresAt: appSession.expiresAt || 0,
      revocable: Boolean(appSession.revocable)
    };
  }

  // 2) Try Cloudflare Access (legacy/private path). Header set by CF Access.
  const cfToken = request.headers.get("cf-access-jwt-assertion") || "";
  if (cfToken) {
    const payload = await verifyCfAccessJwt(cfToken, env);
    const email = extractEmailFromPayload(payload);
    if (email) {
      if (!(await privatePreviewAllowsIdentity(env, email))) {
        return {
          ok: false,
          response: jsonResponse(403, {
            error: PRIVATE_PREVIEW_DENIED_MESSAGE
          })
        };
      }
      return {
        ok: true,
        email,
        person: "",
        isKnownCoupleMember: false,
        provider: "cf-access",
        sessionId: "",
        issuedAt: 0,
        expiresAt: 0,
        revocable: false
      };
    }
  }

  return {
    ok: false,
    response: jsonResponse(401, {
      error: "Sign in to continue."
    })
  };
}

// ---------- Workspace membership helpers ----------

export function isMemberOfWorkspace(workspace, email) {
  if (!workspace || workspace.status === "deleted") return false;
  const normalized = normalizeEmail(email);
  return (workspace.members || []).some((member) => {
    return normalizeEmail(member.email) === normalized && member.status === "active";
  });
}

export function getActiveMember(workspace, email) {
  if (!workspace) return null;
  const normalized = normalizeEmail(email);
  return (workspace.members || []).find((member) => {
    return normalizeEmail(member.email) === normalized && member.status === "active";
  }) || null;
}

export function getPartnerMember(workspace, email) {
  if (!workspace) return null;
  const normalized = normalizeEmail(email);
  return (workspace.members || []).find((member) => {
    return normalizeEmail(member.email) !== normalized && member.status === "active";
  }) || null;
}
