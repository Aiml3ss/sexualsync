// Supabase client wrapper for the Sexualsync Cloudflare Pages Functions.
//
// This is the parallel data-layer entry point that mirrors functions/api/_kv.js.
// It is intentionally side-by-side: the existing KV path still works untouched.
//
// Usage:
//   import { db, userWorkspaceIds } from "./_db.js";
//   const supabase = db(env);
//   const { data, error } = await supabase.from("profiles").select("*").eq("auth_id", uid).single();
//
// Environment variables:
//   SUPABASE_URL          required, e.g. https://abcd1234.supabase.co
//   SUPABASE_SERVICE_KEY  required, the service-role JWT from the project API settings
//   SUPABASE_ANON_KEY     required for user-scoped clients that should obey RLS
//
// IMPORTANT: We currently use the service-role key. That key bypasses RLS, so
// authorization is still enforced by the app layer (the existing _auth.js
// flow). RLS in schema.sql is configured to be permissive when bypassed by
// service_role and strict for `authenticated` callers — so the migration path
// to user-scoped JWTs is straightforward:
//
//   1. Keep `db(env)` for service-role compatibility stores and maintenance.
//   2. Use `userDb(env, userJwt)` for endpoint ports that should obey RLS.
//      The user-scoped client uses SUPABASE_ANON_KEY plus the caller's JWT.
//   3. When Google/CF sessions mint Supabase-compatible JWTs, route those
//      endpoints through userDb() so RLS enforces workspace isolation below
//      the app-layer membership checks.
//
// Until that swap, treat the service key as a deployment secret with the same
// blast radius as direct KV access.

import { createClient } from "@supabase/supabase-js";

const CLIENT_CACHE = new WeakMap();
const USER_CLIENT_CACHE = new WeakMap();

function readServiceConfig(env) {
  const url = (env?.SUPABASE_URL || "").trim();
  const serviceKey = (env?.SUPABASE_SERVICE_KEY || "").trim();
  if (!url || !serviceKey) {
    throw new Error(
      "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY as Pages secrets."
    );
  }
  return { url, serviceKey };
}

function readUserConfig(env) {
  const url = (env?.SUPABASE_URL || "").trim();
  const anonKey = (env?.SUPABASE_ANON_KEY || "").trim();
  if (!url || !anonKey) {
    throw new Error(
      "Supabase user client is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY."
    );
  }
  return { url, anonKey };
}

function cleanJwt(value) {
  return String(value || "").replace(/^Bearer\s+/i, "").trim();
}

/**
 * Returns a configured Supabase client for the given env. The client is
 * cached per `env` object using a WeakMap so we don't recreate it on every
 * call within a single isolate.
 *
 * @param {object} env Cloudflare Pages env binding (has SUPABASE_URL / SUPABASE_SERVICE_KEY).
 * @returns {import("@supabase/supabase-js").SupabaseClient}
 */
export function db(env) {
  if (!env || typeof env !== "object") {
    throw new Error("db(env): env must be an object");
  }
  if (env.__TEST_SUPABASE_CLIENT) return env.__TEST_SUPABASE_CLIENT;
  const cached = CLIENT_CACHE.get(env);
  if (cached) return cached;

  const { url, serviceKey } = readServiceConfig(env);
  const client = createClient(url, serviceKey, {
    auth: {
      // Service-role token doesn't need session persistence and we're not
      // running in a browser.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    },
    global: {
      headers: {
        "x-application-name": "sexualsync-cf-pages"
      }
    }
  });

  CLIENT_CACHE.set(env, client);
  return client;
}

/**
 * Returns a Supabase client scoped by the caller's user JWT. This is the
 * migration path for endpoints that should have Postgres RLS enforce
 * workspace isolation underneath the existing app-layer checks.
 *
 * @param {object} env Cloudflare Pages env binding (has SUPABASE_URL / SUPABASE_ANON_KEY).
 * @param {string} userJwt Supabase Auth JWT for the current user.
 * @returns {import("@supabase/supabase-js").SupabaseClient}
 */
export function userDb(env, userJwt) {
  // readUserConfig requires SUPABASE_ANON_KEY here; this user-scoped path must
  // never read the service-role key.
  if (!env || typeof env !== "object") {
    throw new Error("userDb(env, userJwt): env must be an object");
  }
  const token = cleanJwt(userJwt);
  if (!token) {
    throw new Error("userDb(env, userJwt): userJwt is required");
  }
  if (env.__TEST_SUPABASE_USER_CLIENT) return env.__TEST_SUPABASE_USER_CLIENT;

  let envCache = USER_CLIENT_CACHE.get(env);
  if (!envCache) {
    envCache = new Map();
    USER_CLIENT_CACHE.set(env, envCache);
  }
  const cached = envCache.get(token);
  if (cached) return cached;

  const { url, anonKey } = readUserConfig(env);
  const client = createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    },
    global: {
      headers: {
        "Authorization": `Bearer ${token}`,
        "x-application-name": "sexualsync-cf-pages-rls"
      }
    }
  });

  envCache.set(token, client);
  return client;
}

export function supabaseUserJwtFromRequest(request) {
  return cleanJwt(request?.headers?.get("authorization") || "");
}

export function userDbForAuthenticatedRequest(context, identity) {
  const token = supabaseUserJwtFromRequest(context?.request);
  if (!identity?.ok || identity.provider !== "supabase" || !token) return null;
  return userDb(context.env, token);
}

export function isUserScopedSupabaseReady(env) {
  return Boolean((env?.SUPABASE_URL || "").trim() && (env?.SUPABASE_ANON_KEY || "").trim());
}

/**
 * Returns the workspace ids that the given profile belongs to as an active
 * member. Convenience wrapper for the common access-control check.
 *
 * @param {object} env
 * @param {string} profileId  UUID from public.profiles.id
 * @returns {Promise<string[]>}
 */
export async function userWorkspaceIds(env, profileId) {
  if (!profileId) return [];
  const supabase = db(env);
  const { data, error } = await supabase
    .from("members")
    .select("workspace_id")
    .eq("profile_id", profileId)
    .eq("status", "active");
  if (error) {
    // We fail closed — callers should assume "no access" rather than open access.
    return [];
  }
  return (data || []).map((row) => row.workspace_id);
}

/**
 * Look up a profile by the email we get from the auth layer. Used by the
 * POC port to translate from email-based identity (CF Access) to a
 * profile_id (Supabase row).
 *
 * @param {object} env
 * @param {string} email
 * @returns {Promise<object|null>}
 */
export async function findProfileByEmail(env, email) {
  if (!email) return null;
  const supabase = db(env);
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .ilike("email", email)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

/**
 * Upsert a profile keyed by email (case-insensitive). Creates the row if
 * missing, updates display_name / settings if present. Returns the row.
 *
 * @param {object} env
 * @param {{ email: string, displayName?: string, settings?: object }} input
 * @returns {Promise<object|null>}
 */
export async function ensureProfileRow(env, { email, displayName = "", settings = {} }) {
  if (!email) return null;
  const supabase = db(env);
  const normalized = String(email).trim().toLowerCase();

  // Try update first; if no row, insert. We deliberately don't use upsert()
  // here because the unique index is on lower(email), not email, and
  // PostgREST's on_conflict needs a real index name. Two-step is fine.
  const existing = await findProfileByEmail(env, normalized);
  if (existing) {
    const patch = {};
    if (displayName && displayName !== existing.display_name) patch.display_name = displayName;
    if (settings && typeof settings === "object" && Object.keys(settings).length) {
      patch.settings = { ...(existing.settings || {}), ...settings };
    }
    if (!Object.keys(patch).length) return existing;
    const { data, error } = await supabase
      .from("profiles")
      .update(patch)
      .eq("id", existing.id)
      .select()
      .single();
    if (error) return existing;
    return data;
  }

  const { data, error } = await supabase
    .from("profiles")
    .insert({
      email: normalized,
      display_name: displayName,
      settings
    })
    .select()
    .single();
  if (error) return null;
  return data;
}
