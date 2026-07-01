import { normalizeEmail } from "./_auth.js";
import { getStore } from "./_kv.js";
import { mutateKey } from "./_state.js";

export const VAULT_STORE_NAME = "sexualsync-vault";
export const MAX_VAULT_ITEMS = 30;
export const MAX_VAULT_COMMENTS = 80;
export const MAX_VAULT_MOMENTS = 80;

// Server-controlled placeholder for the visible-before-unlock clip title.
// The real title is stored encrypted in item.title (E2E with the room's
// vault passphrase). The plaintext displayTitle would otherwise leak the
// most sensitive metadata about a clip to any KV/DB dump.
export const VAULT_DEFAULT_DISPLAY_TITLE = "Private Clip";

export const VAULT_REACTION_CATALOG = [
  { id: "think", emoji: "🤔", label: "Thinking", caption: "{name} is thinking it over.", tone: "positive" },
  { id: "fire", emoji: "🔥", label: "Hot", caption: "{name} says it is hot.", tone: "positive" },
  { id: "drool", emoji: "🤤", label: "Want this", caption: "{name} wants this.", tone: "positive" },
  { id: "wrecked", emoji: "🥵", label: "Wrecked", caption: "{name} is wrecked.", tone: "positive" },
  { id: "pass", emoji: "😅", label: "Not for me", caption: "Not {name}'s vibe - try another.", tone: "pass" }
];

const VALID_REACTIONS = new Set(VAULT_REACTION_CATALOG.map((reaction) => reaction.id));
const REACTION_ALIASES = {
  heart: "drool",
  love: "drool",
  maybe: "think",
  curious: "think",
  no: "pass",
  hot: "fire",
  wrecked: "wrecked"
};

export function cleanText(value, max = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function cleanBase64(value, max = 24000) {
  return String(value || "").replace(/[^A-Za-z0-9+/=_-]/g, "").slice(0, max);
}

export function normalizeVaultReaction(value) {
  const raw = cleanText(value, 40);
  if (!raw) return "";
  return REACTION_ALIASES[raw] || (VALID_REACTIONS.has(raw) ? raw : "");
}

export function isVaultReaction(value) {
  return VALID_REACTIONS.has(normalizeVaultReaction(value));
}

export function cleanVaultReactions(value) {
  if (!value || typeof value !== "object") return {};
  const result = {};
  Object.entries(value).forEach(([email, reaction]) => {
    const normalized = normalizeEmail(email);
    const cleanReaction = normalizeVaultReaction(reaction);
    if (normalized && cleanReaction) result[normalized] = cleanReaction;
  });
  return result;
}

function vaultStore(env) {
  return getStore(env, VAULT_STORE_NAME);
}

export function vaultKey(workspaceId) {
  return `vault:${cleanText(workspaceId, 120)}`;
}

export function safeKeySegment(value) {
  return cleanText(value, 120).replace(/[^a-z0-9_-]/gi, "-") || "item";
}

export function vaultMediaKey(workspaceId, itemId, name) {
  return [
    "vault",
    safeKeySegment(workspaceId),
    safeKeySegment(itemId),
    safeKeySegment(name)
  ].join("/");
}

export async function readVault(env, workspaceId) {
  try {
    const value = await vaultStore(env).get(vaultKey(workspaceId), {
      type: "json"
    });
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export async function writeVault(env, workspaceId, items) {
  await vaultStore(env).setJSON(vaultKey(workspaceId), sanitizeStoredItems(items).slice(0, MAX_VAULT_ITEMS));
}

// Atomic read-modify-write for the per-workspace vault list. Routes through the
// StateStore DO CAS coordinator (see _state.js) when STATE is bound; otherwise
// falls back to plain KV RMW with the same shape. The transform receives the
// current items list and returns one of:
//   undefined / null              → no write, result is the current list
//   { error: { status, message } }→ no write, result.error propagates
//   { value: newItems, ...extra } → write the (re-sanitized, capped) list;
//                                    result is { items: <capped>, ...extra }
export async function mutateVault(env, workspaceId, transform) {
  return mutateKey(env, VAULT_STORE_NAME, vaultKey(workspaceId), (current) => {
    const items = Array.isArray(current) ? current : [];
    const out = transform(items);
    if (!out) return { value: items, result: { items }, write: false };
    if (out.error) return { value: items, result: out, write: false };
    if (!out.value) return { value: items, result: { ...out, items }, write: false };
    const capped = sanitizeStoredItems(out.value).slice(0, MAX_VAULT_ITEMS);
    return { value: capped, result: { ...out, items: capped } };
  });
}

function cleanBoxVersion(value) {
  return cleanText(value, 20) === "v2" ? "v2" : "";
}

export function encryptedBoxFromParts(ciphertext, iv, maxCiphertext = 24000, version = "") {
  const cleanCiphertext = cleanBase64(ciphertext, maxCiphertext);
  const cleanIv = cleanBase64(iv, 120);
  if (!cleanCiphertext || !cleanIv) return null;
  return {
    ...(cleanBoxVersion(version) ? { v: "v2" } : {}),
    ciphertext: cleanCiphertext,
    iv: cleanIv
  };
}

export function publicVaultItem(item) {
  return {
    id: cleanText(item?.id, 120),
    workspaceId: cleanText(item?.workspaceId, 120),
    mediaType: cleanText(item?.mediaType || item?.fileType || "video/mp4", 80),
    mediaSize: safeNumber(item?.mediaSize),
    originalSize: safeNumber(item?.originalSize),
    durationMs: safeNumber(item?.durationMs),
    addedByEmail: normalizeEmail(item?.addedByEmail),
    addedByName: cleanText(item?.addedByName, 80),
    addedAt: cleanText(item?.addedAt, 40),
    updatedAt: cleanText(item?.updatedAt || item?.addedAt, 40),
    // Always serve the generic placeholder. Legacy KV records may still
    // carry plaintext titles set before the server-side lock landed; this
    // mask keeps them from reaching the client even before the migration
    // pass rewrites them at rest. The real title lives encrypted in `title`.
    displayTitle: VAULT_DEFAULT_DISPLAY_TITLE,
    encryption: {
      version: cleanText(item?.encryption?.version || "v1", 20),
      algorithm: cleanText(item?.encryption?.algorithm || "AES-GCM", 40),
      kdf: cleanText(item?.encryption?.kdf || "PBKDF2-SHA-256", 60),
      iterations: clampNumber(item?.encryption?.iterations, 100000, 600000, 210000),
      salt: cleanBase64(item?.encryption?.salt, 120),
      videoIv: cleanBase64(item?.encryption?.videoIv, 120)
    },
    title: publicEncryptedBox(item?.title, 4000),
    reactions: cleanVaultReactions(item?.reactions),
    comments: cleanComments(item?.comments),
    moments: cleanMoments(item?.moments),
    hasVideo: Boolean(item?.mediaKey)
  };
}

export function ownsVaultItem(item, actorEmail) {
  const owner = normalizeEmail(item?.addedByEmail);
  return Boolean(owner) && owner === normalizeEmail(actorEmail);
}

export function mediaKeysForItem(item) {
  return [
    item?.mediaKey,
    ...(Array.isArray(item?.moments) ? item.moments.map((moment) => moment?.frameKey) : [])
  ].filter(Boolean);
}

export async function deleteVaultItemMedia(env, item) {
  const bucket = env?.VAULT_MEDIA;
  if (!bucket || typeof bucket.delete !== "function") return;
  await Promise.all(mediaKeysForItem(item).map((key) => bucket.delete(key).catch(() => {})));
}

export async function deleteVaultForWorkspace(env, workspaceId) {
  const items = await readVault(env, workspaceId);
  await Promise.all(items.map((item) => deleteVaultItemMedia(env, item)));
  try {
    await vaultStore(env).delete(vaultKey(workspaceId));
  } catch {
    // Best effort deletion should not block workspace teardown.
  }
}

function sanitizeStoredItems(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    ...item,
    id: cleanText(item?.id, 120),
    workspaceId: cleanText(item?.workspaceId, 120),
    mediaKey: cleanText(item?.mediaKey, 260),
    mediaType: cleanText(item?.mediaType || item?.fileType || "video/mp4", 80),
    mediaSize: safeNumber(item?.mediaSize),
    originalSize: safeNumber(item?.originalSize),
    durationMs: safeNumber(item?.durationMs),
    addedByEmail: normalizeEmail(item?.addedByEmail),
    addedByName: cleanText(item?.addedByName, 80),
    addedAt: cleanText(item?.addedAt, 40),
    updatedAt: cleanText(item?.updatedAt || item?.addedAt, 40),
    // Force the placeholder on every write so legacy plaintext titles get
    // overwritten the next time the surrounding record is mutated. Combined
    // with the read-time mask in publicVaultItem, the client never sees the
    // legacy plaintext.
    displayTitle: VAULT_DEFAULT_DISPLAY_TITLE,
    encryption: {
      version: cleanText(item?.encryption?.version || "v1", 20),
      algorithm: cleanText(item?.encryption?.algorithm || "AES-GCM", 40),
      kdf: cleanText(item?.encryption?.kdf || "PBKDF2-SHA-256", 60),
      iterations: clampNumber(item?.encryption?.iterations, 100000, 600000, 210000),
      salt: cleanBase64(item?.encryption?.salt, 120),
      videoIv: cleanBase64(item?.encryption?.videoIv, 120)
    },
    title: publicEncryptedBox(item?.title, 4000),
    reactions: cleanVaultReactions(item?.reactions),
    comments: cleanComments(item?.comments),
    moments: cleanMoments(item?.moments, { includeFrameKey: true })
  })).filter((item) => item.id && item.workspaceId);
}

function cleanComments(comments) {
  return (Array.isArray(comments) ? comments : []).map((comment) => ({
    id: cleanText(comment?.id, 120) || crypto.randomUUID(),
    email: normalizeEmail(comment?.email),
    name: cleanText(comment?.name, 80),
    body: publicEncryptedBox(comment?.body, 12000),
    at: cleanText(comment?.at, 40)
  })).filter((comment) => comment.email && comment.body?.ciphertext).slice(0, MAX_VAULT_COMMENTS);
}

function cleanMoments(moments, options = {}) {
  return (Array.isArray(moments) ? moments : []).map((moment) => ({
    id: cleanText(moment?.id, 120) || crypto.randomUUID(),
    timestampMs: safeNumber(moment?.timestampMs),
    frameVersion: cleanText(moment?.frameVersion, 20),
    frameIv: cleanBase64(moment?.frameIv, 120),
    frameSize: safeNumber(moment?.frameSize),
    ...(options.includeFrameKey ? { frameKey: cleanText(moment?.frameKey, 260) } : {}),
    title: publicEncryptedBox(moment?.title, 4000),
    note: publicEncryptedBox(moment?.note, 12000),
    createdByEmail: normalizeEmail(moment?.createdByEmail),
    createdByName: cleanText(moment?.createdByName, 80),
    createdAt: cleanText(moment?.createdAt, 40)
  })).filter((moment) => moment.id && moment.frameIv).slice(0, MAX_VAULT_MOMENTS);
}

function publicEncryptedBox(value, maxCiphertext) {
  if (!value || typeof value !== "object") return { ciphertext: "", iv: "" };
  return {
    ...(cleanText(value.v, 20) === "v2" ? { v: "v2" } : {}),
    ciphertext: cleanBase64(value.ciphertext, maxCiphertext),
    iv: cleanBase64(value.iv, 120)
  };
}

function safeNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}
