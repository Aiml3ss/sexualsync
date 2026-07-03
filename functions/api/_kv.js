// Data-store adapter that mimics the @netlify/blobs surface used by the rest
// of the codebase. Every former Netlify Blob "store" becomes a key prefix on a
// single KV namespace bound as `STORE` in wrangler.toml by default.
//
// Sprint 3 public-release hardening: durable app records can be served from
// Supabase/Postgres instead by setting DATA_BACKEND=supabase after running the
// app-data migration. Cache/ephemeral stores stay on KV.
//
// Usage:
//   const store = getStore(env, "sexualsync-request-board");
//   const items = await store.get("requests", { type: "json" });
//   await store.setJSON("requests", items);
//
// DATA_BACKEND modes:
//   kv        default; Cloudflare KV remains source of truth.
//   supabase  durable stores read/write public.app_data; KV is bypassed.
//   dual      durable stores read Supabase first, fallback to KV, write both.

import {
  DB_PRIMARY_STORES as DB_PRIMARY_STORE_NAMES,
  decodeStoredJson,
  encodeStoredJson
} from "./_encrypted_store.js";

// `_db.js` (and the heavy @supabase/supabase-js SDK it imports) is loaded
// lazily — only when a database-backed store is actually used. In the default
// KV mode it is never imported, keeping that SDK out of the cold-start path for
// every function that touches KV.

const DB_PRIMARY_STORES = new Set(DB_PRIMARY_STORE_NAMES);
const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const LEGACY_STORE_ALIAS_B64 = new Map([
  ["sexualsync-request-board", "YW5zLWtlbW15LXJlcXVlc3QtYm9hcmQ="],
  ["sexualsync-boundaries", "YW5zLWtlbW15LWhhcmQtbm8tYm91bmRhcmllcw=="],
  ["sexualsync-approved-acts", "YW5zLWtlbW15LWFwcHJvdmVkLWFjdHM="],
  ["sexualsync-ideas", "YW5zLWtlbW15LWZhbnRhc3ktYmFja2xvZw=="],
  ["sexualsync-shelf", "YW5zLWtlbW15LWluc3BpcmF0aW9uLXNoZWxm"],
  ["sexualsync-pile", "YW5zLWtlbW15LXRvbmlnaHQtcGlsZQ=="],
  ["sexualsync-sex-quiz", "YW5zLWtlbW15LXNleC1xdWl6"],
  ["sexualsync-green-lights", "YW5zLWtlbW15LWdyZWVuLWxpZ2h0cw=="],
  ["sexualsync-presence", "YW5zLWtlbW15LXByZXNlbmNl"],
  ["sexualsync-push-stats", "YW5zLWtlbW15LXB1c2gtc3RhdHM="],
  ["sexualsync-audit", "c2V4aW50b25pYS1hdWRpdA=="],
  ["sexualsync-review-tokens", "c2V4aW50b25pYS1yZXZpZXctdG9rZW5z"]
]);
const legacyAliasCache = new Map();

function backendMode(env) {
  return String(env?.DATA_BACKEND || "kv").trim().toLowerCase();
}

export function isDatabasePrimaryStore(name) {
  return DB_PRIMARY_STORES.has(name);
}

export function isDatabaseBackedStore(env, name) {
  const mode = backendMode(env);
  return isDatabasePrimaryStore(name) && (mode === "supabase" || mode === "postgres" || mode === "db" || mode === "dual");
}

function serviceRoleAppDataAllowed(env) {
  return Boolean(env?.__TEST_SUPABASE_CLIENT)
    || TRUE_VALUES.has(String(env?.ALLOW_SERVICE_ROLE_APP_DATA || "").trim().toLowerCase());
}

function normalizeType(opts = {}) {
  return opts?.type === "text" ? "text"
    : opts?.type === "json" ? "json"
    : opts?.type === "arrayBuffer" ? "arrayBuffer"
    : opts?.type === "stream" ? "stream"
    : "text";
}

function decodeB64(value) {
  try {
    return typeof atob === "function" ? atob(value) : "";
  } catch {
    return "";
  }
}

function legacyStoreName(name) {
  if (!LEGACY_STORE_ALIAS_B64.has(name)) return "";
  if (!legacyAliasCache.has(name)) {
    legacyAliasCache.set(name, decodeB64(LEGACY_STORE_ALIAS_B64.get(name)));
  }
  return legacyAliasCache.get(name) || "";
}

export function storageKeyCandidates(name, key) {
  const recordKey = String(key);
  const primary = `${name}:${recordKey}`;
  const legacy = legacyStoreName(name);
  return legacy ? [primary, `${legacy}:${recordKey}`] : [primary];
}

function kvStore(env, name) {
  const namespace = env?.STORE;
  if (!namespace) {
    throw new Error("KV namespace `STORE` is not bound. Check wrangler.toml.");
  }

  const fullKey = (key) => `${name}:${key}`;

  return {
    async get(key, opts = {}) {
      const type = normalizeType(opts);
      if (type === "json") {
        for (const storageKey of storageKeyCandidates(name, key)) {
          let value = null;
          try {
            value = await namespace.get(storageKey, "json");
          } catch {
            return null;
          }
          if (value !== null && value !== undefined) {
            return decodeStoredJson(env, storageKey, value);
          }
        }
        return null;
      }
      try {
        for (const storageKey of storageKeyCandidates(name, key)) {
          const value = await namespace.get(storageKey, type);
          if (value !== null && value !== undefined) return value;
        }
        return null;
      } catch {
        return null;
      }
    },
    async setJSON(key, value, opts = {}) {
      const storageKey = fullKey(key);
      const stored = await encodeStoredJson(env, storageKey, value);
      await namespace.put(storageKey, JSON.stringify(stored), opts);
    },
    async set(key, value) {
      await namespace.put(fullKey(key), String(value));
    },
    async put(key, value, opts = {}) {
      await namespace.put(fullKey(key), String(value), opts);
    },
    async delete(key) {
      await Promise.all(storageKeyCandidates(name, key).map((storageKey) => namespace.delete(storageKey)));
    },
    // List record keys (without the store prefix) for this store. Mirrors
    // the Cloudflare KV `list` cursor pagination shape so callers can keep
    // walking until `list_complete`. The DB backend ships an equivalent
    // implementation against `public.app_data` so cron-style scanners no
    // longer need to fall back to raw `env.STORE.list`.
    async list(options = {}) {
      const prefix = `${name}:${String(options.prefix || "")}`;
      const legacy = legacyStoreName(name);
      const limit = Number.isFinite(options.limit) ? Math.min(1000, Math.max(1, options.limit)) : 1000;
      const cursor = typeof options.cursor === "string" && options.cursor.length > 0 ? options.cursor : undefined;
      const page = await namespace.list({ prefix, cursor, limit });
      const keys = (page?.keys || []).map((entry) => {
        const fullName = entry?.name || "";
        return { name: fullName.startsWith(`${name}:`) ? fullName.slice(name.length + 1) : fullName };
      });
      let legacyComplete = true;
      if (legacy && !cursor) {
        const legacyPrefix = `${legacy}:${String(options.prefix || "")}`;
        const legacyPage = await namespace.list({ prefix: legacyPrefix, limit });
        legacyComplete = Boolean(legacyPage?.list_complete);
        const seen = new Set(keys.map((entry) => entry.name));
        for (const entry of legacyPage?.keys || []) {
          const fullName = entry?.name || "";
          const recordName = fullName.startsWith(`${legacy}:`) ? fullName.slice(legacy.length + 1) : fullName;
          if (!seen.has(recordName)) {
            seen.add(recordName);
            keys.push({ name: recordName });
          }
        }
      }
      return {
        keys,
        cursor: page?.cursor,
        list_complete: Boolean(page?.list_complete) && legacyComplete
      };
    }
  };
}

function serializeJson(value) {
  try { return JSON.stringify(value); }
  catch { return "null"; }
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); }
  catch { return null; }
}

async function rowValue(env, name, key, row, type) {
  if (!row) return null;
  const storedType = row.value_type || "json";
  const value = storedType === "text" ? row.value_text : row.value_json;
  if (type === "json") {
    const parsed = storedType === "text" ? parseMaybeJson(value) : value;
    return decodeStoredJson(env, `${name}:${key}`, parsed);
  }
  if (type === "text") {
    return storedType === "text" ? (value || "") : serializeJson(value);
  }
  if (type === "arrayBuffer") {
    const text = storedType === "text" ? (value || "") : serializeJson(value);
    return new TextEncoder().encode(text).buffer;
  }
  if (type === "stream") {
    const text = storedType === "text" ? (value || "") : serializeJson(value);
    return new Blob([text]).stream();
  }
  return storedType === "text" ? (value || "") : serializeJson(value);
}

function expiresAtFromOptions(opts = {}) {
  const ttl = Number(opts.expirationTtl || 0);
  if (!Number.isFinite(ttl) || ttl <= 0) return null;
  return new Date(Date.now() + ttl * 1000).toISOString();
}

function dbStore(env, name, fallback = null) {
  // Lazy, cached: the @supabase/supabase-js SDK is only imported the first time
  // a db-backed store method actually runs.
  let clientPromise = null;
  const client = () => {
    if (!clientPromise) clientPromise = import("./_db.js").then((mod) => mod.db(env));
    return clientPromise;
  };

  return {
    async get(key, opts = {}) {
      const type = normalizeType(opts);
      try {
        const db = await client();
        let rowStoreName = name;
        let { data, error } = await db
          .from("app_data")
          .select("store_name,record_key,value_type,value_json,value_text,expires_at")
          .eq("store_name", name)
          .eq("record_key", String(key))
          .maybeSingle();
        if (error) throw error;
        const legacy = legacyStoreName(name);
        if (!data && legacy) {
          const legacyResult = await db
            .from("app_data")
            .select("store_name,record_key,value_type,value_json,value_text,expires_at")
            .eq("store_name", legacy)
            .eq("record_key", String(key))
            .maybeSingle();
          if (legacyResult.error) throw legacyResult.error;
          data = legacyResult.data;
          if (data) rowStoreName = legacy;
        }
        if (data?.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
          await this.delete(key).catch(() => {});
          return null;
        }
        if (data) return rowValue(env, rowStoreName, key, data, type);
      } catch (error) {
        if (backendMode(env) !== "dual") throw error;
      }
      return fallback ? fallback.get(key, opts) : null;
    },
    async setJSON(key, value, opts = {}) {
      const stored = await encodeStoredJson(env, `${name}:${key}`, value);
      const row = {
        store_name: name,
        record_key: String(key),
        value_type: "json",
        value_json: stored === undefined ? null : stored,
        value_text: null,
        expires_at: expiresAtFromOptions(opts)
      };
      const { error } = await (await client()).from("app_data").upsert(row, { onConflict: "store_name,record_key" });
      if (error) throw error;
      if (fallback && backendMode(env) === "dual") await fallback.setJSON(key, value, opts);
    },
    async set(key, value) {
      await this.put(key, value);
    },
    async put(key, value, opts = {}) {
      const row = {
        store_name: name,
        record_key: String(key),
        value_type: "text",
        value_json: null,
        value_text: String(value),
        expires_at: expiresAtFromOptions(opts)
      };
      const { error } = await (await client()).from("app_data").upsert(row, { onConflict: "store_name,record_key" });
      if (error) throw error;
      if (fallback && backendMode(env) === "dual") await fallback.put(key, value, opts);
    },
    async delete(key) {
      const db = await client();
      for (const storeName of [name, legacyStoreName(name)].filter(Boolean)) {
        const { error } = await db
          .from("app_data")
          .delete()
          .eq("store_name", storeName)
          .eq("record_key", String(key));
        if (error) throw error;
      }
      if (fallback && backendMode(env) === "dual") await fallback.delete(key);
    },
    // DB-backed list. Returns record_keys (without the store_name namespace)
    // so the shape matches the KV implementation above. Supabase doesn't have
    // a true cursor for arbitrary string columns — we keep the protocol but
    // always finish in one page within the requested limit.
    async list(options = {}) {
      const prefix = String(options.prefix || "");
      const limit = Number.isFinite(options.limit) ? Math.min(1000, Math.max(1, options.limit)) : 1000;
      try {
        const escaped = prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        const db = await client();
        const { data, error } = await db
          .from("app_data")
          .select("record_key")
          .eq("store_name", name)
          .like("record_key", `${escaped}%`)
          .order("record_key", { ascending: true })
          .limit(limit);
        if (error) throw error;
        const keys = (data || []).map((row) => ({ name: row.record_key }));
        const legacy = legacyStoreName(name);
        if (legacy) {
          const legacyResult = await db
            .from("app_data")
            .select("record_key")
            .eq("store_name", legacy)
            .like("record_key", `${escaped}%`)
            .order("record_key", { ascending: true })
            .limit(limit);
          if (legacyResult.error) throw legacyResult.error;
          const seen = new Set(keys.map((entry) => entry.name));
          for (const row of legacyResult.data || []) {
            if (!seen.has(row.record_key)) {
              seen.add(row.record_key);
              keys.push({ name: row.record_key });
            }
          }
        }
        return {
          keys,
          cursor: undefined,
          list_complete: true
        };
      } catch (error) {
        if (backendMode(env) !== "dual" || !fallback) throw error;
        return fallback.list(options);
      }
    }
  };
}

export function getStore(env, name) {
  if (isDatabaseBackedStore(env, name)) {
    if (!serviceRoleAppDataAllowed(env)) {
      throw new Error("DATA_BACKEND database mode uses service-role app_data; set ALLOW_SERVICE_ROLE_APP_DATA=1 after reviewing RLS bypass risk.");
    }
    return dbStore(env, name, backendMode(env) === "dual" ? kvStore(env, name) : null);
  }
  return kvStore(env, name);
}
