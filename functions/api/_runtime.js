// Runtime target detection for the Sexualsync "self-host edition".
//
// THIS IS A BOUNDARY MARKER, NOT A SWITCH. Importing this module changes
// nothing on its own. Every existing Cloudflare code path keeps calling
// getStore() (KV / Supabase, see _kv.js), the VAULT_MEDIA R2 binding, and the
// ROOMS + STATE Durable Objects exactly as before. The helpers here only
// *report* which runtime a deployment selected, so future adapter code can
// branch in one place instead of scattering `env.SELF_HOST_TARGET` string
// checks across the codebase.
//
// Default is always "cloudflare". The hosted production app on Cloudflare
// Pages sets no SELF_HOST_TARGET and therefore always resolves to
// "cloudflare". A self-host operator opts into the Node edition by setting
// SELF_HOST_TARGET=node (see .env.selfhost.example). Any unrecognized or
// missing value resolves to "cloudflare" so a typo can never silently divert
// production off its proven path.
//
// Relationship to the existing env switches:
//   - DATA_BACKEND   (kv|dual|supabase) already selects the store backend in
//                    functions/api/_kv.js. SELF_HOST_TARGET is the coarser,
//                    deployment-level selector that future adapters will read
//                    to decide *which family* of bindings exist at all.
//   - STATE binding  When absent, functions/api/_state.js already falls back
//                    to an in-process lock. The Node edition will provide a
//                    Postgres advisory-lock implementation behind the same
//                    interface rather than a Durable Object.
//
// None of those existing behaviors are altered by this file.

export const RUNTIME_CLOUDFLARE = "cloudflare";
export const RUNTIME_NODE = "node";

// The deployment-level runtime selector. Default first.
export const DEFAULT_RUNTIME_TARGET = RUNTIME_CLOUDFLARE;

// Recognized values for SELF_HOST_TARGET. "cloudflare" is the live production
// path; "node" is the planned self-host edition. A value is "recognized" only
// if it appears here — everything else falls back to the default.
export const RUNTIME_TARGETS = Object.freeze([RUNTIME_CLOUDFLARE, RUNTIME_NODE]);

function normalizeTarget(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * True when `value` is a SELF_HOST_TARGET the codebase knows how to honor.
 * Used by the self-host config check to flag typos in operator config without
 * affecting any runtime branch (unknown values still resolve to the default).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRecognizedRuntimeTarget(value) {
  return RUNTIME_TARGETS.includes(normalizeTarget(value));
}

/**
 * Resolve the deployment runtime target from env.
 *
 * Reads `env.SELF_HOST_TARGET`. Returns "cloudflare" for missing, empty, or
 * unrecognized values so the live Cloudflare path is the only thing a
 * misconfiguration can produce.
 *
 * @param {{ SELF_HOST_TARGET?: string } | null | undefined} env
 * @returns {"cloudflare" | "node"}
 */
export function runtimeTarget(env) {
  const raw = normalizeTarget(env?.SELF_HOST_TARGET);
  return RUNTIME_TARGETS.includes(raw) ? raw : DEFAULT_RUNTIME_TARGET;
}

/**
 * True on the default Cloudflare Pages / Workers runtime.
 * @param {object|null|undefined} env
 * @returns {boolean}
 */
export function isCloudflareRuntime(env) {
  return runtimeTarget(env) === RUNTIME_CLOUDFLARE;
}

/**
 * True only when a deployment has explicitly opted into the self-host Node
 * edition with SELF_HOST_TARGET=node.
 * @param {object|null|undefined} env
 * @returns {boolean}
 */
export function isSelfHostNodeRuntime(env) {
  return runtimeTarget(env) === RUNTIME_NODE;
}

// ---------------------------------------------------------------------------
// Adapter interfaces (documentation-only).
//
// These typedefs describe the three runtime seams the self-host edition will
// implement behind the existing helpers. They are NOT yet wired anywhere; they
// exist so the Node adapters can be written against a stable, agreed shape that
// matches what the Cloudflare code already does today. The canonical Cloudflare
// implementations these mirror are noted on each interface.
// ---------------------------------------------------------------------------

/**
 * Key/value + JSON document store.
 * Canonical Cloudflare implementation: functions/api/_kv.js `getStore(env, name)`.
 * The Node edition implements the same surface over Postgres or SQLite
 * (the `app_data`-style table already used by the Supabase backend).
 *
 * @typedef {object} StoreAdapter
 * @property {(key: string, opts?: { type?: "text"|"json"|"arrayBuffer"|"stream" }) => Promise<any>} get
 * @property {(key: string, value: any) => Promise<void>} setJSON
 * @property {(key: string, value: any) => Promise<void>} set
 * @property {(key: string, value: any, opts?: { expirationTtl?: number }) => Promise<void>} put
 * @property {(key: string) => Promise<void>} delete
 * @property {(opts?: { prefix?: string, cursor?: string, limit?: number }) => Promise<{ keys: { name: string }[], cursor?: string, list_complete: boolean }>} list
 */

/**
 * Binary object storage for encrypted Vault media.
 * Canonical Cloudflare implementation: the `VAULT_MEDIA` R2 binding used in
 * functions/api/_vault.js and functions/api/vault-media.js.
 * The Node edition implements this over S3-compatible storage (AWS S3 / MinIO).
 *
 * @typedef {object} ObjectStorageAdapter
 * @property {(key: string) => Promise<{ body: ReadableStream|ArrayBuffer, httpMetadata?: object } | null>} get
 * @property {(key: string, body: ArrayBuffer|ReadableStream, opts?: object) => Promise<void>} put
 * @property {(key: string) => Promise<void>} delete
 */

/**
 * Realtime fan-out + atomic state coordination.
 * Canonical Cloudflare implementation: the `ROOMS` and `STATE` Durable Objects
 * in workers/room/src/index.js, fronted by functions/api/_state.js
 * (mutateKey / mutateRecord) and the /api/room socket proxy.
 * The Node edition implements realtime with a WebSocket service and the
 * compare-and-set seam with a Postgres advisory lock.
 *
 * @typedef {object} RealtimeStateAdapter
 * @property {(env: object, storeName: string, key: string, transform: Function, opts?: object) => Promise<any>} mutateKey
 * @property {(env: object, recordName: string, storeName: string, keys: string[], transform: Function, opts?: object) => Promise<any>} mutateRecord
 * @property {(workspaceId: string, event: object) => Promise<{ ok: boolean, seq: number }>} broadcast
 */
