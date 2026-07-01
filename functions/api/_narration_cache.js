import { getStore } from "./_kv.js";

const CACHE_STORE = "sexualsync-narration-cache";
const LEGACY_CACHE_STORE = "STORE";
const CACHE_PREFIX = "narrate:v4:";
const LEGACY_CACHE_PREFIX = "narrate:v3:";
const CACHE_TTL_S = 60 * 60 * 24 * 30;
const textEncoder = new TextEncoder();

function cleanSecret(value) {
  const secret = String(value || "").trim();
  return secret.length >= 32 ? secret : "";
}

function cacheSecret(env) {
  const explicit = cleanSecret(env?.NARRATION_CACHE_SECRET);
  if (explicit) return explicit;
  for (let version = 8; version >= 1; version -= 1) {
    const secret = cleanSecret(env?.[`DATA_ENCRYPTION_KEY_V${version}`]);
    if (secret) return secret;
  }
  return cleanSecret(env?.DATA_ENCRYPTION_KEY) || cleanSecret(env?.APP_SESSION_SECRET);
}

function base64Url(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function stripNarrationEmoji(value) {
  return String(value || "").replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+/u, "").trim();
}

function normalizedInput(input) {
  return {
    you: String(input?.you || "").trim(),
    partner: String(input?.partner || "").trim(),
    acts: (Array.isArray(input?.acts) ? input.acts : [])
      .map(stripNarrationEmoji)
      .map((label) => label.toLowerCase())
      .sort(),
    timing: String(input?.timing || "").trim(),
    filming: !!input?.filming,
  };
}

function legacyCacheKey(input) {
  return LEGACY_CACHE_PREFIX + JSON.stringify(normalizedInput(input));
}

async function privateCacheKey(env, input) {
  const secret = cacheSecret(env);
  if (!secret) return "";
  const material = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    material,
    textEncoder.encode(JSON.stringify(normalizedInput(input)))
  );
  return CACHE_PREFIX + base64Url(new Uint8Array(signature));
}

async function deleteLegacyCache(env, input) {
  try {
    await getStore(env, LEGACY_CACHE_STORE).delete(legacyCacheKey(input));
  } catch {
    // Cache cleanup is best effort; source records are authoritative.
  }
}

export async function readNarrationCache(env, input) {
  await deleteLegacyCache(env, input);
  const key = await privateCacheKey(env, input);
  if (!key) return null;
  try {
    const cached = await getStore(env, CACHE_STORE).get(key, { type: "json" });
    if (cached && typeof cached === "object" && typeof cached.text === "string") return cached.text;
    return null;
  } catch {
    return null;
  }
}

export async function writeNarrationCache(env, input, text) {
  await deleteLegacyCache(env, input);
  const key = await privateCacheKey(env, input);
  if (!key) return;
  try {
    await getStore(env, CACHE_STORE).setJSON(key, {
      text: String(text || ""),
      cachedAt: new Date().toISOString()
    }, { expirationTtl: CACHE_TTL_S });
  } catch {
    // Never fail the user flow because a derived cache write failed.
  }
}
