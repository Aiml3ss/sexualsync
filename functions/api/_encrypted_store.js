export const DB_PRIMARY_STORES = [
  "sex-exploration-platform",
  "sexualsync-request-board",
  "sexualsync-boundaries",
  "sexualsync-approved-acts",
  "sexualsync-ideas",
  "sexualsync-shelf",
  "sexualsync-pile",
  "sexualsync-sex-quiz",
  "sexualsync-green-lights",
  "sexualsync-vault",
  "sexualsync-activity",
  "sexualsync-feedback",
  "sexualsync-audit",
  "sexualsync-review-tokens",
  "sexualsync-email-auth",
  "sexualsync-local-auth"
];

export const DATA_ENCRYPTED_STORES = [
  ...DB_PRIMARY_STORES,
  "sexualsync-presence",
  "push",
  "sexualsync-narration-cache",
  // Direct-message thread. In an E2EE room the bodies are already client-side
  // ciphertext; this envelope protects the plaintext bodies of non-E2EE rooms
  // at rest. Not yet a DB-primary store — chat stays on KV until the
  // database-backend migration (docs/self-host/GOING-PUBLIC.md) adopts it.
  "sexualsync-chat",
  // RedGifs Bearer token cache (audit L1) — a credential, kept off plaintext KV.
  "sexualsync-redgifs-token",
  // RedGifs metadata/direct-url cache. No credential, but IDs and URLs can reveal
  // private taste or saved media choices, so keep it encrypted too.
  "sexualsync-redgifs-cache",
  // Partner-personalized AI prompt pool cache (audit L2). Both are regenerable
  // caches, so no migration of existing rows is needed.
  "sexualsync-prompt-cache",
  // Generated notification body pools are generic, but the keys are workspace
  // scoped and the copy is intimate enough to protect at rest.
  "sexualsync-push-body-cache"
];

// Preferred secret: DATA_ENCRYPTION_KEY_V1 (and future V2/V3/etc). If no
// dedicated data key is configured, authenticated deployments fall back to the
// already-required APP_SESSION_SECRET so DB/KV rows are still not plaintext.
const DATA_ENCRYPTED_STORE_SET = new Set(DATA_ENCRYPTED_STORES);
const ENVELOPE_MARKER = "__sexualsyncEncryptedJson";
const ENVELOPE_FORMAT_V1 = "sxs-json-aes-gcm-v1";
const ENVELOPE_FORMAT_V2 = "sxs-json-aes-gcm-v2";
const ENVELOPE_FORMAT = ENVELOPE_FORMAT_V2;
const SUPPORTED_ENVELOPE_FORMATS = new Set([ENVELOPE_FORMAT_V1, ENVELOPE_FORMAT_V2]);
const KEY_CACHE = new Map();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function isEncryptedJsonStore(storeName) {
  return DATA_ENCRYPTED_STORE_SET.has(storeName);
}

export function splitStoreKey(fullKey) {
  const index = String(fullKey || "").indexOf(":");
  if (index <= 0) return { storeName: "", recordKey: String(fullKey || "") };
  return {
    storeName: fullKey.slice(0, index),
    recordKey: fullKey.slice(index + 1)
  };
}

export function isEncryptedJsonEnvelope(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && value[ENVELOPE_MARKER] === true
    && SUPPORTED_ENVELOPE_FORMATS.has(value.format)
    && value.iv
    && value.ciphertext
  );
}

export function dataEncryptionAvailable(env) {
  return Boolean(activeEncryptionKey(env));
}

const PLAINTEXT_OPT_OUT_TRUTHY = new Set(["1", "true", "yes", "on"]);
// Secure-by-default: a sensitive store (DATA_ENCRYPTED_STORES) must be encrypted
// at rest. An operator who deliberately runs keyless — e.g. encrypting at the
// disk/DB layer instead — opts out with ALLOW_PLAINTEXT_AT_REST=1. This matters
// most for the self-host edition shipped to operators who won't read docs: the
// safe state is the default, and running plaintext is a conscious choice.
function allowPlaintextAtRest(env) {
  return PLAINTEXT_OPT_OUT_TRUTHY.has(String(env?.ALLOW_PLAINTEXT_AT_REST ?? "").trim().toLowerCase());
}

export async function encodeStoredJson(env, fullKey, value) {
  const { storeName } = splitStoreKey(fullKey);
  const sensitive = isEncryptedJsonStore(storeName);
  const keyRecord = activeEncryptionKey(env);

  // Secure-by-default: refuse to write a sensitive store as plaintext when no
  // key resolves, unless the operator explicitly opted into keyless storage.
  // Any keyed deployment (DATA_ENCRYPTION_KEY_V* or APP_SESSION_SECRET >= 32
  // chars) always resolves a key, so this never fires there — including the live
  // site. The read path (decodeStoredJson) is untouched, so existing data —
  // encrypted envelopes or legacy plaintext rows — is unaffected either way.
  if (sensitive && !keyRecord && !allowPlaintextAtRest(env)) {
    throw new Error(
      `Refusing to write plaintext to encrypted store "${storeName}": set DATA_ENCRYPTION_KEY_V1 / APP_SESSION_SECRET (>=32 chars), or set ALLOW_PLAINTEXT_AT_REST=1 to opt into keyless storage.`
    );
  }

  if (!sensitive || !keyRecord || isEncryptedJsonEnvelope(value)) {
    return value === undefined ? null : value;
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(value === undefined ? null : value));
  const key = await cryptoKeyFor(keyRecord, ENVELOPE_FORMAT);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: envelopeAad(ENVELOPE_FORMAT, fullKey, keyRecord.id)
    },
    key,
    plaintext
  );

  return {
    [ENVELOPE_MARKER]: true,
    format: ENVELOPE_FORMAT,
    keyId: keyRecord.id,
    algorithm: "AES-GCM",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext))
  };
}

export async function decodeStoredJson(env, fullKey, value) {
  if (!isEncryptedJsonEnvelope(value)) return value;

  const keyId = cleanKeyId(value.keyId);
  const format = SUPPORTED_ENVELOPE_FORMATS.has(value.format) ? value.format : "";
  const keyRecord = encryptionKeyById(env, keyId);
  if (!keyRecord) {
    throw new Error(`Missing data encryption key ${keyId || "(unknown)"} for ${fullKey}`);
  }

  const key = await cryptoKeyFor(keyRecord, format);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(value.iv),
      additionalData: envelopeAad(format, fullKey, keyRecord.id)
    },
    key,
    base64ToBytes(value.ciphertext)
  );
  return JSON.parse(textDecoder.decode(plaintext));
}

function activeEncryptionKey(env) {
  const dataKeys = configuredDataKeys(env);
  if (dataKeys.length) return dataKeys[dataKeys.length - 1];
  const sessionSecret = cleanSecret(env?.APP_SESSION_SECRET);
  return sessionSecret ? { id: "app-session-v1", secret: sessionSecret } : null;
}

function encryptionKeyById(env, keyId) {
  if (!keyId) return null;
  const candidates = [
    ...configuredDataKeys(env),
    cleanSecret(env?.APP_SESSION_SECRET)
      ? { id: "app-session-v1", secret: cleanSecret(env.APP_SESSION_SECRET) }
      : null
  ].filter(Boolean);
  return candidates.find((candidate) => candidate.id === keyId) || null;
}

function configuredDataKeys(env) {
  const keys = [];
  const legacy = cleanSecret(env?.DATA_ENCRYPTION_KEY);
  if (legacy) keys.push({ id: "v1", secret: legacy });

  for (let version = 1; version <= 8; version += 1) {
    const secret = cleanSecret(env?.[`DATA_ENCRYPTION_KEY_V${version}`]);
    if (secret) keys.push({ id: `v${version}`, secret });
  }

  const byId = new Map(keys.map((key) => [key.id, key]));
  return Array.from(byId.values()).sort((a, b) => {
    return Number(a.id.slice(1) || 0) - Number(b.id.slice(1) || 0);
  });
}

function cleanSecret(value) {
  const secret = String(value || "").trim();
  return secret.length >= 32 ? secret : "";
}

function cleanKeyId(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
}

async function cryptoKeyFor(keyRecord, format = ENVELOPE_FORMAT) {
  const cacheKey = `${format}:${keyRecord.id}:${keyRecord.secret}`;
  const cached = KEY_CACHE.get(cacheKey);
  if (cached) return cached;

  const promise = format === ENVELOPE_FORMAT_V1
    ? legacySha256KeyFor(keyRecord)
    : hkdfKeyFor(keyRecord, format);
  KEY_CACHE.set(cacheKey, promise);
  return promise;
}

async function legacySha256KeyFor(keyRecord) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(`${ENVELOPE_FORMAT_V1}:${keyRecord.id}\0${keyRecord.secret}`)
  );
  return crypto.subtle.importKey(
    "raw",
    digest,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

async function hkdfKeyFor(keyRecord, format) {
  const material = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(keyRecord.secret),
    "HKDF",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: textEncoder.encode(`sexualsync:data-json:${keyRecord.id}`),
      info: textEncoder.encode(format)
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function envelopeAad(format, fullKey, keyId) {
  return textEncoder.encode(`${format}:${keyId}:${fullKey}`);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
