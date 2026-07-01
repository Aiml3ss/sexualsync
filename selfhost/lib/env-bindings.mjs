// Assembles the `env` object the Cloudflare Pages handlers receive, for the
// self-host Node runtime.
//
// The product handlers reach for three non-string bindings — `STORE` (KV),
// `VAULT_MEDIA` (R2), and `ROOMS` (realtime) — plus plain string vars. We
// satisfy STORE/VAULT_MEDIA with filesystem adapters, ROOMS with an in-process
// room registry (passed in by the server, which also accepts the WebSocket
// upgrades), and pass every string var straight through from process.env.
//
// We intentionally do NOT provide `STATE`: functions/api/_state.js falls back
// to its in-process mutation lock, which is correct for a single Node process.
// Multi-process atomicity (Postgres advisory lock) is tracked in
// docs/self-host/MIGRATION_PLAN.md.

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { createFsKvNamespace } from "../adapters/kv-fs.mjs";
import { createFsR2Bucket } from "../adapters/r2-fs.mjs";
import { runtimeTarget } from "../../functions/api/_runtime.js";

const SESSION_SECRET_MIN = 32;
const SESSION_SECRET_FILE = "session-secret";
let cachedPackageVersion = null;

function packageVersion() {
  if (cachedPackageVersion !== null) return cachedPackageVersion;
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    cachedPackageVersion = String(pkg.version || "").trim();
  } catch {
    cachedPackageVersion = "";
  }
  return cachedPackageVersion;
}

function defaultAppVersion() {
  const version = packageVersion();
  return version ? `sexualsync-selfhost-v${version}` : "sexualsync-selfhost-unknown";
}

// Zero-config security: APP_SESSION_SECRET keys both sign-in sessions and (via
// the at-rest store's fallback) JSON-at-rest encryption. Rather than make the
// operator hand-generate one — easy to skip, easy to pick weak, and a hard error
// now that the at-rest store refuses plaintext by default — we mint a strong one
// on first boot and persist it under the data dir so it's STABLE across restarts
// (a changing secret would log everyone out and strand at-rest data).
//
// Precedence: an operator-set env value ALWAYS wins (so an existing deployment
// is never overridden); else a previously-persisted file; else generate + persist.
// Data-safety note: at-rest rows are tagged with the key id `app-session-v1`, so
// reusing the same persisted secret keeps every row decryptable. Don't delete the
// file or set then later REMOVE the env var once data exists — either changes the
// effective key. (See _encrypted_store.js.)
export function ensureSessionSecret(dataDir, env) {
  if (String(env.APP_SESSION_SECRET || "").trim().length >= SESSION_SECRET_MIN) return env;

  const file = path.join(dataDir, SESSION_SECRET_FILE);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing.length >= SESSION_SECRET_MIN) {
      env.APP_SESSION_SECRET = existing;
      return env;
    }
  } catch {
    // Not persisted yet — fall through and generate one.
  }

  const secret = crypto.randomBytes(32).toString("hex"); // 256-bit, 64 hex chars
  env.APP_SESSION_SECRET = secret;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600); // enforce 0600 even if a prior umask widened it
    console.log(`[selfhost] no APP_SESSION_SECRET set — generated a strong one and persisted it to ${file} (0600). Back it up with your data dir; deleting it logs everyone out and makes at-rest data unreadable.`);
  } catch (error) {
    console.warn(`[selfhost] WARNING: could not persist auto-generated APP_SESSION_SECRET to ${file} (${String(error?.message || error)}). The app will run, but the secret will NOT survive a restart — set APP_SESSION_SECRET explicitly for a stable deployment.`);
  }
  return env;
}

export function buildEnv({ dataDir, mediaDir, rooms = null, overrides = {} }) {
  const env = { ...process.env, ...overrides };

  // The runtime marker should report "node" for a self-host deployment. The
  // handlers don't branch on it, but health/diagnostics and operators can read
  // it, and it keeps the marker honest about where we are running.
  if (!env.SELF_HOST_TARGET) env.SELF_HOST_TARGET = "node";
  if (!env.APP_VERSION) env.APP_VERSION = defaultAppVersion();

  // Secure-by-default secret: generate + persist one when the operator hasn't set
  // it, so a fresh instance encrypts at rest and signs sessions with no manual step.
  ensureSessionSecret(dataDir, env);

  env.STORE = createFsKvNamespace(path.join(dataDir, "kv"));
  env.VAULT_MEDIA = createFsR2Bucket(path.join(mediaDir));
  if (rooms) env.ROOMS = rooms; // realtime room registry (in-process)

  return env;
}

export function describeEnv(env) {
  return {
    runtimeTarget: runtimeTarget(env),
    store: Boolean(env.STORE),
    vaultMedia: Boolean(env.VAULT_MEDIA),
    rooms: Boolean(env.ROOMS),
    state: Boolean(env.STATE),
    googleAuth: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    appSessionSecret: String(env.APP_SESSION_SECRET || "").trim().length >= 32,
    email: Boolean(env.RESEND_API_KEY),
    localPassword: env.SELF_HOST_TARGET === "node"
  };
}
