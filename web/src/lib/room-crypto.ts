export const ROOM_E2EE_MARKER = "__sxsRoomEncrypted";
export const ROOM_E2EE_VERSION = "sxs-room-e2ee-v1";
export const ROOM_E2EE_PLACEHOLDER = "Encrypted content";
export const ROOM_E2EE_LOCKED_LABEL = "Encrypted - unlock in Privacy";
const ROOM_E2EE_VERIFIER_PURPOSE = "workspace-verifier";

export const ROOM_E2EE_DEVICE_UNLOCK_DAYS = 7;
export const ROOM_E2EE_SESSION_RELOCK_MS = ROOM_E2EE_DEVICE_UNLOCK_DAYS * 24 * 60 * 60 * 1000;
const ROOM_E2EE_ITERATIONS = 310_000; // v1 — PBKDF2-SHA256 (OWASP 2021). Never lower; release gate pins this literal.
const ROOM_E2EE_ITERATIONS_V2 = 600_000; // v2 — PBKDF2-SHA256 (OWASP 2023). Opt-in per deploy via ROOM_E2EE_KDF_VERSION.

export type RoomKdfVersion = "v1" | "v2";

// The box `version` string stays "sxs-room-e2ee-v1" for EVERY KDF version, so
// the salt, AAD, blind-index input, and every validity check are unchanged — only
// the PBKDF2 iteration count differs, selected by this map off the box's `kdf`
// tag. A v1 box carries no `kdf` field and derives at the historical 310k count,
// making its derivation and ciphertext byte-identical to pre-v2 builds.
const ROOM_KDF_ITERATIONS: Record<RoomKdfVersion, number> = {
  v1: ROOM_E2EE_ITERATIONS,
  v2: ROOM_E2EE_ITERATIONS_V2,
};
const DEFAULT_ROOM_KDF_VERSION: RoomKdfVersion = "v1";

// Passphrase floor for first-time room keys. Existing encrypted rooms can be
// older/shorter, so verifier/recovery unlocks must not reject before trying the
// actual ciphertext.
const ROOM_PASSPHRASE_MIN_UNLOCK = 12;
const ROOM_PASSPHRASE_MIN_RECOVERY = 4;

function normalizeRoomKdfVersion(value: unknown): RoomKdfVersion {
  return value === "v2" ? "v2" : "v1";
}

function readBoxKdfVersion(box: { kdf?: unknown } | null | undefined): RoomKdfVersion {
  return box?.kdf === "v2" ? "v2" : "v1";
}

const ROOM_SESSION_KEY_PREFIX = "ss:e2ee:v1:session-key:";
const ROOM_AWAY_AT_KEY = "ss:e2ee:v1:away-at";
const ROOM_SESSION_ID_KEY = "ss:e2ee:v1:session-id";
const ROOM_SESSION_DB_NAME = "ss-room-e2ee-session";
const ROOM_SESSION_DB_VERSION = 1;
const ROOM_SESSION_STORE = "keys";
const ROOM_SESSION_MAX_MS = ROOM_E2EE_SESSION_RELOCK_MS;
const KEY_CACHE = new Map<string, RoomKeySet>();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
let roomSessionDbPromise: Promise<IDBDatabase> | null = null;

export interface RoomEncryptedBox {
  [ROOM_E2EE_MARKER]: true;
  version: typeof ROOM_E2EE_VERSION;
  // Present only on v2+ boxes. Absent = v1 (310k). Selects the PBKDF2 iteration
  // count to derive at on read; the `version` string is unchanged across KDFs.
  kdf?: "v2";
  algorithm: "AES-GCM";
  iv: string;
  ciphertext: string;
}

export interface RoomDecryptResult<T> {
  ok: boolean;
  locked: boolean;
  value: T | null;
}

export interface RoomE2eeRecoveryCandidate {
  purpose: string;
  box: RoomEncryptedBox;
}

interface RoomVerifierPayload {
  version: typeof ROOM_E2EE_VERSION;
  workspaceId: string;
  check: "room-passphrase";
}

interface RoomKeySet {
  encryptionKey: CryptoKey;
  blindIndexKey: CryptoKey;
  // The KDF version these keys were derived at. Carried so encryptRoomJson can
  // stamp new boxes with the room's frozen version without re-deriving.
  kdf: RoomKdfVersion;
}

interface PersistedRoomKeySet extends RoomKeySet {
  workspaceId: string;
  sessionId: string;
  savedAt: number;
  expiresAt: number;
}

function enabledStorageKey(workspaceId: string) {
  return `ss:e2ee:v1:${workspaceId}:enabled`;
}

function sessionKeyStorageKey(workspaceId: string) {
  return `${ROOM_SESSION_KEY_PREFIX}${workspaceId}`;
}

function normalizeWorkspaceId(workspaceId: string) {
  return String(workspaceId || "").trim();
}

function forgetLegacyRawRoomSessionKey(workspaceId?: string) {
  if (typeof window === "undefined") return;
  try {
    const id = normalizeWorkspaceId(workspaceId || "");
    if (id) {
      window.sessionStorage.removeItem(sessionKeyStorageKey(id));
      return;
    }
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(ROOM_SESSION_KEY_PREFIX)) window.sessionStorage.removeItem(key);
    }
  } catch {
    // Storage can be unavailable in private/webview contexts.
  }
}

function forgetRoomSessionKey(workspaceId?: string) {
  forgetLegacyRawRoomSessionKey(workspaceId);
  const id = normalizeWorkspaceId(workspaceId || "");
  if (id) void deletePersistedRoomSessionKey(id);
  else void clearPersistedRoomSessionKeys();
}

function currentRoomSessionId(create = false): string {
  if (typeof window === "undefined") return "";
  try {
    const existing = window.localStorage.getItem(ROOM_SESSION_ID_KEY);
    if (existing) return existing;
    const legacy = window.sessionStorage.getItem(ROOM_SESSION_ID_KEY);
    if (legacy) {
      window.localStorage.setItem(ROOM_SESSION_ID_KEY, legacy);
      window.sessionStorage.removeItem(ROOM_SESSION_ID_KEY);
      return legacy;
    }
    if (!create) return "";
    const next = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    window.localStorage.setItem(ROOM_SESSION_ID_KEY, next);
    return next;
  } catch {
    return "";
  }
}

function openRoomSessionDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available."));
  }
  if (roomSessionDbPromise) return roomSessionDbPromise;
  roomSessionDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(ROOM_SESSION_DB_NAME, ROOM_SESSION_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ROOM_SESSION_STORE)) {
        db.createObjectStore(ROOM_SESSION_STORE, { keyPath: "workspaceId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Room session key store unavailable."));
  });
  roomSessionDbPromise.catch(() => { roomSessionDbPromise = null; });
  return roomSessionDbPromise;
}

function withRoomSessionStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openRoomSessionDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(ROOM_SESSION_STORE, mode);
    const store = tx.objectStore(ROOM_SESSION_STORE);
    let result: T | undefined;
    const request = work(store);
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error || new Error("Room session key store request failed."));
    tx.oncomplete = () => resolve(result as T);
    tx.onerror = () => reject(tx.error || new Error("Room session key store transaction failed."));
    tx.onabort = () => reject(tx.error || new Error("Room session key store transaction aborted."));
  }));
}

function isUsableCryptoKey(value: unknown): value is CryptoKey {
  return Boolean(value && typeof value === "object" && "algorithm" in value && "usages" in value);
}

async function persistRoomSessionKey(workspaceId: string, sessionId: string, keys: RoomKeySet): Promise<void> {
  const now = Date.now();
  await withRoomSessionStore("readwrite", (store) => store.put({
    workspaceId,
    sessionId,
    savedAt: now,
    expiresAt: now + ROOM_SESSION_MAX_MS,
    encryptionKey: keys.encryptionKey,
    blindIndexKey: keys.blindIndexKey,
    kdf: keys.kdf,
  }));
}

async function readPersistedRoomSessionKey(workspaceId: string): Promise<PersistedRoomKeySet | null> {
  const value = await withRoomSessionStore("readonly", (store) => store.get(workspaceId)).catch(() => null);
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<PersistedRoomKeySet>;
  if (
    record.workspaceId !== workspaceId
    || !record.sessionId
    || !isUsableCryptoKey(record.encryptionKey)
    || !isUsableCryptoKey(record.blindIndexKey)
  ) {
    return null;
  }
  return {
    workspaceId,
    sessionId: record.sessionId,
    savedAt: Number(record.savedAt) || 0,
    expiresAt: Number(record.expiresAt) || 0,
    encryptionKey: record.encryptionKey,
    blindIndexKey: record.blindIndexKey,
    kdf: normalizeRoomKdfVersion(record.kdf),
  };
}

async function deletePersistedRoomSessionKey(workspaceId: string): Promise<void> {
  await withRoomSessionStore("readwrite", (store) => store.delete(workspaceId)).catch(() => {});
}

async function clearPersistedRoomSessionKeys(): Promise<void> {
  await withRoomSessionStore("readwrite", (store) => store.clear()).catch(() => {});
}

export function markRoomE2eeAway(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ROOM_AWAY_AT_KEY, String(Date.now()));
  } catch {
    // Storage can be unavailable in private/webview contexts.
  }
}

export function clearRoomE2eeAway(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ROOM_AWAY_AT_KEY);
  } catch {
    // Storage can be unavailable in private/webview contexts.
  }
}

function roomSessionExpired(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const awayAt = Number(window.localStorage.getItem(ROOM_AWAY_AT_KEY) || "0");
    return Number.isFinite(awayAt) && awayAt > 0 && Date.now() - awayAt > ROOM_E2EE_SESSION_RELOCK_MS;
  } catch {
    return false;
  }
}

async function rememberRoomSessionKey(workspaceId: string, keys: RoomKeySet) {
  const id = normalizeWorkspaceId(workspaceId);
  if (!id) return;
  forgetLegacyRawRoomSessionKey(id);
  const sessionId = currentRoomSessionId(true);
  if (!sessionId) return;
  await persistRoomSessionKey(id, sessionId, keys).catch(() => {});
}

function emitRoomE2eeChange(workspaceId: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("ss:room-e2ee-change", {
    detail: { workspaceId, enabled: workspaceId ? isRoomE2eeEnabled(workspaceId) : false },
  }));
}

export function isRoomE2eeEnabled(workspaceId: string): boolean {
  const id = normalizeWorkspaceId(workspaceId);
  if (!id || typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(enabledStorageKey(id)) === "1";
  } catch {
    return false;
  }
}

export function setRoomE2eeEnabled(workspaceId: string, enabled: boolean): void {
  const id = normalizeWorkspaceId(workspaceId);
  if (!id || typeof window === "undefined") return;
  try {
    if (enabled) window.localStorage.setItem(enabledStorageKey(id), "1");
    else window.localStorage.removeItem(enabledStorageKey(id));
  } catch {
    // Storage can be unavailable in private/webview contexts.
  }
  if (!enabled) {
    KEY_CACHE.delete(id);
    forgetRoomSessionKey(id);
  }
  emitRoomE2eeChange(id);
}

export function hasUnlockedRoomE2eeKey(workspaceId: string): boolean {
  return KEY_CACHE.has(normalizeWorkspaceId(workspaceId));
}

export async function restoreRoomE2eeSession(workspaceId: string): Promise<boolean> {
  const id = normalizeWorkspaceId(workspaceId);
  if (!id) return false;
  if (KEY_CACHE.has(id)) return true;
  if (roomSessionExpired()) {
    forgetRoomSessionKey(id);
    clearRoomE2eeAway();
    return false;
  }
  forgetLegacyRawRoomSessionKey(id);
  const sessionId = currentRoomSessionId(false);
  if (!sessionId) return false;
  const persisted = await readPersistedRoomSessionKey(id);
  if (!persisted || persisted.sessionId !== sessionId) return false;
  if (persisted.expiresAt <= Date.now()) {
    await deletePersistedRoomSessionKey(id);
    return false;
  }
  KEY_CACHE.set(id, {
    encryptionKey: persisted.encryptionKey,
    blindIndexKey: persisted.blindIndexKey,
    kdf: persisted.kdf,
  });
  return true;
}

export function lockRoomE2ee(workspaceId?: string): void {
  const id = normalizeWorkspaceId(workspaceId || "");
  if (id) {
    KEY_CACHE.delete(id);
    forgetRoomSessionKey(id);
  } else {
    KEY_CACHE.clear();
    forgetRoomSessionKey();
  }
  clearRoomE2eeAway();
  emitRoomE2eeChange(id);
}

export function clearRoomE2eeKeyCache(): void {
  lockRoomE2ee();
}

export function disableRoomE2ee(workspaceId: string): void {
  setRoomE2eeEnabled(workspaceId, false);
}

export async function unlockRoomE2ee(
  workspaceId: string,
  passphrase: string,
  verifier?: RoomEncryptedBox,
  // KDF version for a BRAND-NEW room (no verifier yet). An existing room ignores
  // this and derives at the version frozen into its stored verifier, so the
  // room's blind indexes stay comparable across its lifetime. Defaults to v1 so
  // an offline/unconfigured client never mints a room a partner can't reproduce.
  newRoomKdfVersion: RoomKdfVersion = DEFAULT_ROOM_KDF_VERSION,
): Promise<void> {
  const id = normalizeWorkspaceId(workspaceId);
  const secret = String(passphrase || "").trim();
  if (!id) throw new Error("Choose a room before enabling encryption.");
  const minLength = verifier ? ROOM_PASSPHRASE_MIN_RECOVERY : ROOM_PASSPHRASE_MIN_UNLOCK;
  if (secret.length < minLength) {
    throw new Error(verifier
      ? "Enter the room passphrase."
      : `Use at least ${ROOM_PASSPHRASE_MIN_UNLOCK} characters for the room passphrase.`);
  }
  // Frozen-per-room: an existing room's version comes from its verifier box; a
  // new room takes the deploy's active version. Never mix versions in one room.
  const kdf = verifier ? readBoxKdfVersion(verifier) : normalizeRoomKdfVersion(newRoomKdfVersion);
  const sessionKey = await deriveRoomKeySet(id, secret, false, kdf);
  if (verifier) {
    const verified = await decryptRoomJsonWithKey<RoomVerifierPayload>(id, ROOM_E2EE_VERIFIER_PURPOSE, verifier, sessionKey.encryptionKey)
      .catch(() => null);
    if (
      !verified
      || verified.version !== ROOM_E2EE_VERSION
      || verified.workspaceId !== id
      || verified.check !== "room-passphrase"
    ) {
      throw new Error("That passphrase didn't unlock this room.");
    }
  }
  clearRoomE2eeAway();
  await rememberRoomSessionKey(id, sessionKey);
  const key = await restoreRoomE2eeSession(id)
    ? KEY_CACHE.get(id)
    : sessionKey;
  if (!key) throw new Error("Couldn't unlock this room.");
  KEY_CACHE.set(id, key);
  setRoomE2eeEnabled(id, true);
}

export async function recoverRoomE2eeWithCandidates(
  workspaceId: string,
  passphrase: string,
  candidates: RoomE2eeRecoveryCandidate[],
): Promise<number> {
  const id = normalizeWorkspaceId(workspaceId);
  const secret = String(passphrase || "").trim();
  if (!id) throw new Error("Choose a room before recovering encryption.");
  if (secret.length < ROOM_PASSPHRASE_MIN_RECOVERY) {
    throw new Error("Enter the old room passphrase.");
  }
  const usable = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.purpose && isRoomEncryptedBox(candidate.box));
  if (!usable.length) throw new Error("No encrypted room data was found to test.");

  const keysByKdf = new Map<RoomKdfVersion, RoomKeySet>();
  const verifiedByKdf = new Map<RoomKdfVersion, number>();
  for (const candidate of usable) {
    const kdf = readBoxKdfVersion(candidate.box);
    let keySet = keysByKdf.get(kdf);
    if (!keySet) {
      keySet = await deriveRoomKeySet(id, secret, false, kdf);
      keysByKdf.set(kdf, keySet);
    }
    const recovered = await decryptRoomJsonWithKey<unknown>(id, candidate.purpose, candidate.box, keySet.encryptionKey)
      .then(() => true)
      .catch(() => false);
    if (recovered) {
      verifiedByKdf.set(kdf, (verifiedByKdf.get(kdf) || 0) + 1);
    }
  }
  let bestKdf: RoomKdfVersion | null = null;
  let verified = 0;
  for (const [kdf, count] of verifiedByKdf) {
    if (count > verified) {
      bestKdf = kdf;
      verified = count;
    }
  }
  const verifiedKeys = bestKdf ? keysByKdf.get(bestKdf) || null : null;
  if (!verified || !verifiedKeys) {
    throw new Error("That passphrase didn't decrypt any existing room data.");
  }
  clearRoomE2eeAway();
  await rememberRoomSessionKey(id, verifiedKeys);
  KEY_CACHE.set(id, verifiedKeys);
  setRoomE2eeEnabled(id, true);
  return verified;
}

export async function createRoomE2eeVerifier(workspaceId: string): Promise<RoomEncryptedBox> {
  const id = normalizeWorkspaceId(workspaceId);
  return encryptRoomJson<RoomVerifierPayload>(id, ROOM_E2EE_VERIFIER_PURPOSE, {
    version: ROOM_E2EE_VERSION,
    workspaceId: id,
    check: "room-passphrase",
  });
}

// Offered at enable time so a couple can take a strong passphrase instead of
// inventing a weak one. Five groups of four chars from an unambiguous alphabet
// (no 0/O/1/I/l) → 20 random chars ≈ 99 bits, comfortably past the enable floor
// and easy to read aloud to a partner. Generated, never derived — uses CSPRNG.
export function generateRoomPassphrase(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const groups = 5;
  const perGroup = 4;
  const bytes = crypto.getRandomValues(new Uint8Array(groups * perGroup));
  const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]);
  const out: string[] = [];
  for (let group = 0; group < groups; group += 1) {
    out.push(chars.slice(group * perGroup, group * perGroup + perGroup).join(""));
  }
  return out.join("-");
}

function roomSalt(workspaceId: string, purpose = "encryption") {
  if (purpose === "encryption") return textEncoder.encode(`${ROOM_E2EE_VERSION}:workspace:${workspaceId}`);
  return textEncoder.encode(`${ROOM_E2EE_VERSION}:workspace:${workspaceId}:${purpose}`);
}

async function deriveRoomKeySet(
  workspaceId: string,
  passphrase: string,
  extractable = false,
  kdf: RoomKdfVersion = DEFAULT_ROOM_KDF_VERSION,
): Promise<RoomKeySet> {
  // ONLY the iteration count is version-dependent. The salt (roomSalt) and AAD
  // still embed the unchanged ROOM_E2EE_VERSION string, so a v1 derivation is
  // bit-for-bit identical to every prior build.
  const iterations = ROOM_KDF_ITERATIONS[kdf];
  const material = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const encryptionKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: roomSalt(workspaceId, "encryption"),
      iterations,
    },
    material,
    { name: "AES-GCM", length: 256 },
    extractable,
    ["encrypt", "decrypt"],
  );
  const blindIndexKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: roomSalt(workspaceId, "blind-index"),
      iterations,
    },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    extractable,
    ["sign"],
  );
  return { encryptionKey, blindIndexKey, kdf };
}

function aad(workspaceId: string, purpose: string) {
  return textEncoder.encode(`${ROOM_E2EE_VERSION}:${workspaceId}:${purpose}`);
}

function roomKeySet(workspaceId: string): RoomKeySet {
  const keys = KEY_CACHE.get(normalizeWorkspaceId(workspaceId));
  if (!keys) throw new Error("Unlock Room Encryption in Privacy first.");
  return keys;
}

function roomKey(workspaceId: string): CryptoKey {
  return roomKeySet(workspaceId).encryptionKey;
}

function roomBlindIndexKey(workspaceId: string): CryptoKey {
  return roomKeySet(workspaceId).blindIndexKey;
}

export async function encryptRoomJson<T>(
  workspaceId: string,
  purpose: string,
  value: T,
): Promise<RoomEncryptedBox> {
  const id = normalizeWorkspaceId(workspaceId);
  const keys = roomKeySet(id);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(value ?? null));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(id, purpose) },
    keys.encryptionKey,
    plaintext,
  );
  return {
    [ROOM_E2EE_MARKER]: true,
    version: ROOM_E2EE_VERSION,
    // A v1 room spreads nothing → the serialized box is byte-identical to the
    // historical shape; a v2 room tags the box so a reader derives at 600k.
    ...(keys.kdf === "v2" ? { kdf: "v2" as const } : {}),
    algorithm: "AES-GCM",
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptRoomJson<T>(
  workspaceId: string,
  purpose: string,
  box: RoomEncryptedBox,
): Promise<T> {
  return decryptRoomJsonWithKey<T>(normalizeWorkspaceId(workspaceId), purpose, box, roomKey(workspaceId));
}

async function decryptRoomJsonWithKey<T>(
  workspaceId: string,
  purpose: string,
  box: RoomEncryptedBox,
  key: CryptoKey,
): Promise<T> {
  const id = normalizeWorkspaceId(workspaceId);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(box.iv), additionalData: aad(id, purpose) },
    key,
    base64ToBytes(box.ciphertext),
  );
  return JSON.parse(textDecoder.decode(decrypted)) as T;
}

export async function tryDecryptRoomJson<T>(
  workspaceId: string,
  purpose: string,
  box: unknown,
): Promise<RoomDecryptResult<T>> {
  if (!isRoomEncryptedBox(box)) return { ok: false, locked: false, value: null };
  if (!hasUnlockedRoomE2eeKey(workspaceId) && !(await restoreRoomE2eeSession(workspaceId))) {
    return { ok: false, locked: true, value: null };
  }
  try {
    return {
      ok: true,
      locked: false,
      value: await decryptRoomJson<T>(workspaceId, purpose, box),
    };
  } catch {
    return { ok: false, locked: true, value: null };
  }
}

export async function createRoomBlindIndex(
  workspaceId: string,
  purpose: string,
  value: string,
): Promise<string> {
  const id = normalizeWorkspaceId(workspaceId);
  const input = String(value || "").trim().toLowerCase();
  if (!input) throw new Error("Missing value for encrypted room index.");
  const signature = await crypto.subtle.sign(
    "HMAC",
    roomBlindIndexKey(id),
    textEncoder.encode(`${ROOM_E2EE_VERSION}:${id}:${purpose}:${input}`),
  );
  return `sxs-bi-v1:${bytesToBase64Url(new Uint8Array(signature))}`;
}

export function isRoomEncryptedBox(value: unknown): value is RoomEncryptedBox {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>)[ROOM_E2EE_MARKER] === true
    && (value as Record<string, unknown>).version === ROOM_E2EE_VERSION
    && (value as Record<string, unknown>).algorithm === "AES-GCM"
    && typeof (value as Record<string, unknown>).iv === "string"
    && typeof (value as Record<string, unknown>).ciphertext === "string"
  );
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function bytesToBase64Url(bytes: Uint8Array) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64ToBytes(value: string) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
