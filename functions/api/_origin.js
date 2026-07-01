// Trusted origin for absolute links in outbound transactional email.
//
// The inbound request's Host / X-Forwarded-Host header is attacker-controllable
// (classic Host-header injection; on the self-host Node edition behind
// TRUST_PROXY the forwarded host is client-supplied — see
// selfhost/lib/http-bridge.mjs). An emailed link must therefore prefer an
// operator-configured origin and only fall back to the request origin when
// nothing is configured (local dev / preview, where Host is trusted).
//
// This mirrors what the Google OAuth flow already does for redirect URIs
// (functions/api/auth/google/_oauth.js prefers AUTH_BASE_URL over the request
// origin); the email builders are brought onto the same footing here instead of
// each copying a `siteOrigin(request)` helper that trusts the Host blindly.
//
// Precedence:
//   1. PUBLIC_BASE_URL  canonical public origin of the deployment. The
//                       general-purpose "where this app lives" var.
//   2. AUTH_BASE_URL    reused. Already set in production and on self-host for
//                       OAuth, so this hardening is effective with no new
//                       config; PUBLIC_BASE_URL only overrides it when present.
//   3. request origin   last resort when neither is configured.
//
// Web-standard only (URL) so the identical helper runs on both the Cloudflare
// and Node editions (CLAUDE.md hard rule 2).

function normalizeConfiguredBase(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  // Keep scheme + host (+ any path prefix the operator set) and drop a trailing
  // slash so callers can append "/signin?…" without doubling it.
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

function requestOrigin(request) {
  try {
    return new URL(request.url).origin;
  } catch {
    return "";
  }
}

/**
 * Resolve the trusted base origin for building absolute links in email.
 *
 * @param {{ PUBLIC_BASE_URL?: string, AUTH_BASE_URL?: string } | null | undefined} env
 * @param {Request} request
 * @returns {string} e.g. "https://your-host.example" (no trailing slash), or "" if
 *   nothing resolves (callers fall back to a relative path).
 */
export function trustedOrigin(env, request) {
  return (
    normalizeConfiguredBase(env?.PUBLIC_BASE_URL)
    || normalizeConfiguredBase(env?.AUTH_BASE_URL)
    || requestOrigin(request)
  );
}
