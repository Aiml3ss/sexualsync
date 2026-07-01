// Supabase auth bridge for the relational backend (Phase 1 of the scaling port).
//
// The normalized relational tables (supabase/schema.sql) enforce per-user
// isolation via Postgres RLS, which keys off auth.uid() — taken from a JWT
// signed with the project's JWT secret. The app authenticates with first-party
// Google (not Supabase Auth), so we mint a Supabase-compatible JWT from our own
// identity: HS256 over { sub, role, aud, exp } signed with SUPABASE_JWT_SECRET.
// RLS joins profiles.auth_id = auth.uid(), so we derive a STABLE per-email sub
// and store it as profiles.auth_id (no Supabase Auth user needed).
//
// INERT UNTIL CUTOVER: nothing here affects production. It no-ops unless
// DATA_BACKEND=relational AND SUPABASE_JWT_SECRET is set (neither is true in
// prod today), and no live handler imports it yet — it's wired in per-endpoint
// during the port, all behind the same flag.

const RELATIONAL_MODE = "relational";
const encoder = new TextEncoder();

function readSecret(env) {
  return String(env?.SUPABASE_JWT_SECRET || "").trim();
}

// True only when the relational backend is explicitly enabled AND signable.
export function relationalBackendEnabled(env) {
  return String(env?.DATA_BACKEND || "").trim().toLowerCase() === RELATIONAL_MODE
    && Boolean(readSecret(env));
}

function base64UrlBytes(bytes) {
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlText(text) {
  return base64UrlBytes(encoder.encode(text));
}

// Deterministic, stable UUID for an email (RFC-4122-shaped). Lets us map a
// Google identity to a fixed profiles.auth_id without creating a Supabase Auth
// user — same email always yields the same id.
export async function supabaseSubForEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return "";
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(`sexualsync:auth:${normalized}`))
  );
  const b = digest.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Mint a short-lived Supabase-compatible JWT. Returns null when no secret is
// configured (so it's inert until cutover) or when sub is missing.
export async function mintSupabaseJwt(env, { sub, email = "", ttlSeconds = 30 * 60 } = {}) {
  const secret = readSecret(env);
  if (!secret || !sub) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub,
    email,
    role: "authenticated",
    aud: "authenticated",
    iat: now,
    exp: now + ttlSeconds
  };
  const body = `${base64UrlText(JSON.stringify(header))}.${base64UrlText(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${base64UrlBytes(new Uint8Array(signature))}`;
}

// Convenience: mint a JWT for a Google-authenticated identity by email.
export async function mintSupabaseJwtForEmail(env, email, ttlSeconds) {
  const sub = await supabaseSubForEmail(email);
  if (!sub) return null;
  return mintSupabaseJwt(env, { sub, email, ttlSeconds });
}
