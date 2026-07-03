import { getStore } from "./_kv.js";
import { mutateKey } from "./_state.js";

// Web Push helper — implements VAPID auth + AES-128-GCM payload encryption
// using Cloudflare Workers' Web Crypto API. No external deps.
//
// Subscription shape (what the browser gives you via pushManager.subscribe):
//   { endpoint, keys: { p256dh, auth } }
//
// Usage:
//   await sendWebPush(env, subscription, { title, body, url });

// ---- base64url helpers (Workers don't have Buffer) -------------------------

function b64urlEncode(bytes) {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8(s) { return new TextEncoder().encode(s); }

// ---- Endpoint validation (SSRF guard) --------------------------------------

// A subscription endpoint is attacker-influenced (it comes from the request
// body and is later fetch()ed). On the self-host Node edition an unvalidated
// endpoint lets an authenticated user point the server at internal/metadata
// hosts (SSRF). Defense: require https and refuse anything that targets a
// loopback / link-local / private / unqualified-internal host. We deliberately
// do NOT pin a fixed service allowlist — browser push endpoints vary by vendor,
// region and over time (FCM / APNs / WNS / Mozilla autopush and future
// services), so a static list would silently drop legitimate pushes. Allow any
// public https host and block the internal ones instead. Web-standard only.
// (DNS rebinding — a public name resolving to a private IP — is out of scope;
// it needs resolve-then-pin, which isn't available in the Web-standard runtime.)
function isIpLiteralHost(hostname) {
  // IPv6 literals arrive bracketed: [::1], [fe80::1], etc.
  if (hostname.startsWith("[") || hostname.includes(":")) return true;
  // Bare IPv4 dotted-quad (covers 127.0.0.1, 169.254.169.254, 10/172/192.168…).
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

const INTERNAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa"];

export function isAllowedPushEndpoint(endpoint) {
  if (typeof endpoint !== "string" || !endpoint) return false;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost") return false;
  if (isIpLiteralHost(host)) return false;             // loopback / link-local / private IPs
  if (!host.includes(".")) return false;               // bare/unqualified name (likely internal)
  if (INTERNAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  return true;                                         // any public https host (vendor-agnostic)
}

function concatBytes(...arrs) {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// ---- VAPID JWT (ES256 signed) ---------------------------------------------

// Import the private signing key from the raw d (32-byte) value plus the
// public key's uncompressed point (which we already have as VAPID_PUBLIC_KEY).
// The imported CryptoKey never changes for a given env, so cache it in module
// scope rather than re-importing on every push send.
let _vapidKeyCache = null;
async function importVapidKeys(env) {
  const privB64 = (env.VAPID_PRIVATE_KEY || "").trim();
  const pubB64 = (env.VAPID_PUBLIC_KEY || "").trim();
  if (!privB64 || !pubB64) throw new Error("VAPID keys not configured");
  if (_vapidKeyCache && _vapidKeyCache.privB64 === privB64 && _vapidKeyCache.pubB64 === pubB64) {
    return { key: _vapidKeyCache.key, publicKey: _vapidKeyCache.publicKey };
  }
  const d = b64urlDecode(privB64);            // 32 bytes
  const pub = b64urlDecode(pubB64);           // 65 bytes (0x04 || x || y)
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error("VAPID public key malformed");
  const x = pub.slice(1, 33);
  const y = pub.slice(33, 65);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: b64urlEncode(d),
    x: b64urlEncode(x),
    y: b64urlEncode(y),
    ext: true
  };
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  _vapidKeyCache = { privB64, pubB64, key, publicKey: pub };
  return { key, publicKey: pub };
}

// VAPID JWTs are valid per push-service audience for hours. Cache one per
// audience and reuse it until it's near expiry, instead of signing a fresh JWT
// for every recipient on every fanout.
const _vapidJwtCache = new Map();
const VAPID_JWT_TTL_S = 12 * 60 * 60;
const VAPID_JWT_REUSE_MARGIN_S = 30 * 60;

async function buildVapidJwt(env, audience) {
  const now = Math.floor(Date.now() / 1000);
  const cached = _vapidJwtCache.get(audience);
  if (cached && cached.exp - now > VAPID_JWT_REUSE_MARGIN_S) return cached.jwt;

  const { key } = await importVapidKeys(env);
  const subject = env.VAPID_SUBJECT || "mailto:hello@mail.sexualsync.io";
  const header = { typ: "JWT", alg: "ES256" };
  const exp = now + VAPID_JWT_TTL_S;
  const payload = { aud: audience, exp, sub: subject };
  const headerB = b64urlEncode(utf8(JSON.stringify(header)));
  const payloadB = b64urlEncode(utf8(JSON.stringify(payload)));
  const signingInput = utf8(`${headerB}.${payloadB}`);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signingInput
  );
  const jwt = `${headerB}.${payloadB}.${b64urlEncode(sig)}`;
  if (_vapidJwtCache.size > 16) _vapidJwtCache.clear();
  _vapidJwtCache.set(audience, { jwt, exp });
  return jwt;
}

// ---- HKDF helpers ----------------------------------------------------------

async function hkdfExtract(ikm, salt) {
  const k = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, ikm));
}
async function hkdfExpand(prk, info, length) {
  const k = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, concatBytes(info, new Uint8Array([1]))));
  return sig.slice(0, length);
}

// ---- Payload encryption (RFC 8291 — aes128gcm content coding) -------------

// We emit a single aes128gcm record with rs=4096 and one 0x02 padding byte and
// never split across records. AES-GCM adds a 16-byte auth tag, so the plaintext
// (utf8 payload + 1 pad byte) must fit in rs - 16. Anything larger produces a
// malformed single-record body that every push service rejects, silently
// failing the send for ALL recipients. Guard the length up front so the caller
// gets a clear, logged error instead of a mystery 4xx fanout.
const PUSH_RECORD_SIZE = 4096;
const PUSH_MAX_PLAINTEXT = PUSH_RECORD_SIZE - 16; // AES-GCM auth tag
const PUSH_MAX_PAYLOAD_BYTES = PUSH_MAX_PLAINTEXT - 1; // 1 byte for 0x02 padding

async function encryptPayload(payload, subscription) {
  const payloadBytes = utf8(payload);
  if (payloadBytes.length > PUSH_MAX_PAYLOAD_BYTES) {
    throw new Error(
      `push payload too large: ${payloadBytes.length} bytes exceeds single-record limit of ${PUSH_MAX_PAYLOAD_BYTES}`
    );
  }
  const p256dh = b64urlDecode(subscription.keys.p256dh);  // 65 bytes
  const authSecret = b64urlDecode(subscription.keys.auth); // 16 bytes
  // Ephemeral ECDH key pair (server side, per send).
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const ephemeralPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  // Import the subscription's public key for ECDH.
  const subPub = await crypto.subtle.importKey(
    "raw",
    p256dh,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: subPub }, ephemeral.privateKey, 256)
  );
  // RFC 8291: PRK_key = HKDF(authSecret, shared, "WebPush: info\0" || ua_public || as_public, 32)
  const keyInfo = concatBytes(
    utf8("WebPush: info\0"),
    p256dh,
    ephemeralPubRaw
  );
  const prkKey = await hkdfExtract(shared, authSecret);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);
  // 16-byte random salt.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(ikm, salt);
  const cek = await hkdfExpand(prk, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk, utf8("Content-Encoding: nonce\0"), 12);
  // Plaintext gets a single 0x02 padding byte at end (per RFC 8188).
  const plaintext = concatBytes(payloadBytes, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext)
  );
  // aes128gcm header: salt(16) || rs(4, big-endian, = 4096) || idlen(1) || keyid(idlen)
  // Where keyid is the server ephemeral public key (raw, 65 bytes).
  const rs = new Uint8Array(4);
  // rs = 4096 big-endian
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const header = concatBytes(salt, rs, new Uint8Array([ephemeralPubRaw.length]), ephemeralPubRaw);
  const body = concatBytes(header, ciphertext);
  return body;
}

// ---- Public API -----------------------------------------------------------

// Cap the per-field lengths that callers control so they can't push the
// encrypted record over PUSH_MAX_PAYLOAD_BYTES. title/body are already clamped
// upstream (lockscreenSafePushPayload), but url + actions[].url/title are not,
// and a long deep link (e.g. a token-bearing review URL) plus a couple of
// actions can blow the budget. These limits are generous relative to the 4096
// record size while leaving ample headroom for the rest of the JSON envelope.
const MAX_URL_LEN = 512;
const MAX_ACTION_TITLE_LEN = 64;

function clampPushPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const out = { ...payload };
  if (typeof out.url === "string") out.url = out.url.slice(0, MAX_URL_LEN);
  if (Array.isArray(out.actions)) {
    out.actions = out.actions.slice(0, 2).map((action) => {
      const next = { ...action };
      if (typeof next.url === "string") next.url = next.url.slice(0, MAX_URL_LEN);
      if (typeof next.title === "string") next.title = next.title.slice(0, MAX_ACTION_TITLE_LEN);
      return next;
    });
  }
  return out;
}

// Send a push notification. payload is a JSON string or an object; it'll be
// stringified. Returns { ok, status, error? }.
export async function sendWebPush(env, subscription, payload) {
  if (!subscription || !subscription.endpoint) {
    return { ok: false, error: "missing-endpoint" };
  }
  // Defensively re-validate (SSRF guard) so a previously-stored bad endpoint
  // can't be used to fetch() an internal/disallowed host.
  if (!isAllowedPushEndpoint(subscription.endpoint)) {
    return { ok: false, error: "invalid-endpoint" };
  }
  const url = new URL(subscription.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt = await buildVapidJwt(env, audience);
  const pubB64 = env.VAPID_PUBLIC_KEY;
  const payloadStr = typeof payload === "string" ? payload : JSON.stringify(clampPushPayload(payload));
  const body = await encryptPayload(payloadStr, subscription);
  const headers = {
    "TTL": "86400",
    "Content-Type": "application/octet-stream",
    "Content-Encoding": "aes128gcm",
    "Authorization": `vapid t=${jwt}, k=${pubB64}`,
    "Urgency": "normal"
  };
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers,
    body
  });
  if (res.ok || res.status === 201) return { ok: true, status: res.status };
  const text = await res.text().catch(() => "");
  return { ok: false, status: res.status, error: text.slice(0, 280) };
}

// Send to many subscriptions in parallel, swallowing per-recipient errors.
// 404/410 endpoints are dead and should be pruned by the caller.
export async function sendWebPushFanout(env, subscriptions, payload) {
  const results = await Promise.all(
    subscriptions.map((s) => sendWebPush(env, s, payload).catch((e) => ({ ok: false, error: e?.message })))
  );
  return results.map((r, i) => ({ ...r, subscription: subscriptions[i] }));
}

// ---- Subscriptions KV store (one KV key per workspace) --------------------

export async function readPushSubscriptions(env, workspaceId) {
  const raw = await getStore(env, "push").get(`subscriptions:${workspaceId}`, { type: "json" });
  return Array.isArray(raw) ? raw : [];
}


const DEFAULT_PUSH_PREFERENCES = {
  "chat-message": true,
  "request-sent": true,
  "request-reviewed": true,
  "request-reminder": true,
  "kink-nudge": true,
  "blind-reveal": true,
  "pile-started": true,
  "pile-reminder": true,
  "game-ready": true,
  "push-test": true
};

function cleanPushPreferences(value) {
  const prefs = { ...DEFAULT_PUSH_PREFERENCES };
  if (!value || typeof value !== "object") return prefs;
  Object.keys(DEFAULT_PUSH_PREFERENCES).forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(value, key)) prefs[key] = value[key] !== false;
  });
  return prefs;
}

function allowsPayload(subscription, payload) {
  const tag = payload?.tag || "";
  if (!tag) return true;
  const preferences = cleanPushPreferences(subscription.preferences);
  return preferences[tag] !== false;
}

// Subscription writes go through the CAS coordinator: this list was the one
// contended per-workspace store still doing a naked read-modify-write, so a
// subscribe racing the dead-endpoint prune (or the partner subscribing at the
// same moment) could silently drop a device — which then never gets pushes
// again until it happens to re-subscribe.
export async function addPushSubscription(env, workspaceId, email, subscription, preferences = {}) {
  const entry = {
    email,
    endpoint: subscription.endpoint,
    keys: subscription.keys,
    preferences: cleanPushPreferences(preferences),
    createdAt: new Date().toISOString()
  };
  await mutateKey(env, "push", `subscriptions:${workspaceId}`, (current) => {
    const existing = Array.isArray(current) ? current : [];
    return { value: [...existing.filter((s) => s.endpoint !== entry.endpoint), entry] };
  });
}

export async function removePushSubscription(env, workspaceId, endpoint, email = "") {
  const actorEmail = String(email || "").trim().toLowerCase();
  await mutateKey(env, "push", `subscriptions:${workspaceId}`, (current) => {
    const existing = Array.isArray(current) ? current : [];
    const filtered = existing.filter((s) => {
      if (s.endpoint !== endpoint) return true;
      if (!actorEmail) return false;
      return String(s.email || "").trim().toLowerCase() !== actorEmail;
    });
    if (filtered.length === existing.length) return { write: false, result: existing };
    return { value: filtered };
  });
}

// Send a push to every member of the workspace EXCEPT the actor (so you don't
// notify yourself). Returns the fanout results plus prunes dead endpoints.
export async function pushToWorkspace(env, workspaceId, actorEmail, payload) {
  const subs = await readPushSubscriptions(env, workspaceId);
  // v2 · Sprint F · `onlyEmail` lets the caller deliver TO a specific email
  // (used by /api/push-test which sends the test push back to its caller).
  // Default behavior remains: send to everyone EXCEPT the actor.
  const onlyEmail = payload && payload.onlyEmail;
  const actor = String(actorEmail || "").trim().toLowerCase();
  const only = String(onlyEmail || "").trim().toLowerCase();
  const targets = onlyEmail
    ? subs.filter((s) => String(s.email || "").trim().toLowerCase() === only)
    : subs.filter((s) => String(s.email || "").trim().toLowerCase() !== actor);
  if (onlyEmail && payload) delete payload.onlyEmail;
  const filteredTargets = targets.filter((subscription) => allowsPayload(subscription, payload));
  if (!filteredTargets.length) return [];
  const results = await sendWebPushFanout(env, filteredTargets, payload);
  // Record last-delivered timestamp so the Settings panel can show a diagnostic.
  try {
    const ok = results.some((r) => r.status >= 200 && r.status < 300);
    if (ok) {
      const store = getStore(env, "sexualsync-push-stats");
      await store.setJSON(`last-delivered:${workspaceId}`, { at: new Date().toISOString() });
    }
  } catch {}
  // Prune dead endpoints (410 Gone, 404 Not Found) — atomically against the
  // FRESH list, so a device that subscribed mid-fanout isn't clobbered away.
  const dead = results.filter((r) => r.status === 410 || r.status === 404).map((r) => r.subscription.endpoint);
  if (dead.length) {
    await mutateKey(env, "push", `subscriptions:${workspaceId}`, (current) => {
      const existing = Array.isArray(current) ? current : [];
      const fresh = existing.filter((s) => !dead.includes(s.endpoint));
      if (fresh.length === existing.length) return { write: false, result: existing };
      return { value: fresh };
    }).catch(() => {});
  }
  return results;
}
