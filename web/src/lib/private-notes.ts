"use client";

export interface PrivateNote {
  id: string;
  text: string;
  createdAt: string;
}

export const PRIVATE_NOTES_STORAGE_KEY = "ss:private-notes";
const LEGACY_STORAGE_KEY = "sexualsync.privateNotes.v1";
const LEGACY_PREFIX = "sexualsync-private-sparks:";

// --- Encryption-at-rest design --------------------------------------------
//
// THREAT: private "sparks" notes are intimate free text. Previously they sat
// in localStorage["ss:private-notes"] as raw JSON. Any unlocked device, a
// malicious browser extension, or a forensic disk image could read them
// verbatim. This module encrypts the notes at rest so the on-disk value is
// AES-GCM ciphertext, never plaintext.
//
// KEY MATERIAL: the at-rest key is derived from a per-install random 32-byte
//   "device secret" (ss:private-notes:dk:v1), via PBKDF2 → a non-extractable
//   AES-GCM CryptoKey. There is no app-lock PIN to borrow a key from — the
//   per-device screen lock was removed, so notes rely on the device key alone.
//
// WHAT THIS DEFENDS AGAINST: the named threats — casual reads on an unlocked
// device, forensic images, and extensions that scrape only the notes key —
// now see ciphertext. It does NOT defend against an attacker who reads BOTH
// the notes blob AND the device-secret key out of the same localStorage; that
// is the unavoidable ceiling for a device-key-only scheme. We do not claim
// more than that.
//
// FORMAT:
//   encrypted blob:  { v: 2, iv: <base64 12B>, ct: <base64> }   (JSON of PrivateNote[])
//   legacy plaintext: a bare JSON array of notes (v1) — detected by shape and
//   transparently upgraded to the encrypted blob on the next save.

const DEVICE_KEY_STORAGE_KEY = "ss:private-notes:dk:v1";
const DEVICE_KEY_SALT = "ss:private-notes:dk-salt:v1";
const DEVICE_KEY_ITERATIONS = 210_000;
const ENCRYPTED_VERSION = 2 as const;
const MAX_NOTES = 80;

interface EncryptedNotesBlob {
  v: typeof ENCRYPTED_VERSION;
  iv: string;
  ct: string;
}

export type PrivateNotesProtection = "device-key-only";

/**
 * Describes how strongly the private notes are protected on this device.
 *
 *  - "device-key-only": notes are AES-GCM encrypted at rest with a per-device
 *                       key, but anyone holding an unlocked device can open the
 *                       app and read them — there is no app lock to pass. We
 *                       never report this as "encrypted & locked".
 */
export function privateNotesProtection(): PrivateNotesProtection {
  return "device-key-only";
}

// --- Base64 helpers --------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// --- Device key ------------------------------------------------------------

// Cache the derived key for the tab session so repeated loads/saves don't pay
// the PBKDF2 cost each time. The key is a non-extractable CryptoKey, so this
// holds an opaque handle, not raw key bytes.
let _deviceKeyPromise: Promise<CryptoKey> | null = null;

function readOrCreateDeviceSecret(): string {
  // Per-install random 32-byte secret. Stored base64. If localStorage is
  // unavailable (Safari private mode) we fall back to an ephemeral secret so
  // encryption still works in-session; persistence just won't survive reload.
  try {
    const existing = window.localStorage.getItem(DEVICE_KEY_STORAGE_KEY);
    if (existing) return existing;
  } catch { /* ignore */ }
  const secret = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  try { window.localStorage.setItem(DEVICE_KEY_STORAGE_KEY, secret); } catch { /* ignore */ }
  return secret;
}

async function getDeviceKey(): Promise<CryptoKey> {
  if (_deviceKeyPromise) return _deviceKeyPromise;
  _deviceKeyPromise = (async () => {
    const secret = readOrCreateDeviceSecret();
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: new TextEncoder().encode(DEVICE_KEY_SALT),
        iterations: DEVICE_KEY_ITERATIONS,
      },
      material,
      { name: "AES-GCM", length: 256 },
      false, // non-extractable
      ["encrypt", "decrypt"],
    );
  })();
  // If derivation throws, drop the cache so a retry can re-derive.
  _deviceKeyPromise.catch(() => { _deviceKeyPromise = null; });
  return _deviceKeyPromise;
}

async function encryptNotes(notes: PrivateNote[]): Promise<EncryptedNotesBlob> {
  const key = await getDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(notes));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return {
    v: ENCRYPTED_VERSION,
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(encrypted)),
  };
}

async function decryptNotes(blob: EncryptedNotesBlob): Promise<PrivateNote[]> {
  const key = await getDeviceKey();
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(blob.iv) as BufferSource },
    key,
    base64ToBytes(blob.ct) as BufferSource,
  );
  return parseNotes(new TextDecoder().decode(decrypted));
}

function isEncryptedBlob(value: unknown): value is EncryptedNotesBlob {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { v?: unknown }).v === ENCRYPTED_VERSION &&
    typeof (value as { iv?: unknown }).iv === "string" &&
    typeof (value as { ct?: unknown }).ct === "string"
  );
}

// --- Public API ------------------------------------------------------------
//
// NOTE: loadPrivateNotes / savePrivateNotes / privateNoteCount are now async.
// WebCrypto's subtle API is async-only, so honest encryption-at-rest can't be
// done synchronously. The exported names and the returned PrivateNote shape
// are unchanged; only the return type is now wrapped in a Promise. Callers
// that read/write these notes must `await` them. See the handoff note returned
// to the maintainer for the exact caller sites that need updating.

/**
 * Load private notes, decrypting at rest. Merges all sources (current
 * encrypted blob, legacy plaintext keys), decrypts/parses, dedupes, sorts
 * newest-first, caps at 80, and re-persists as an encrypted blob (this also
 * performs the legacy upgrade).
 */
export async function loadPrivateNotes(): Promise<PrivateNote[]> {
  if (typeof window === "undefined") return [];

  const notes = new Map<string, PrivateNote>();

  for (const parsed of await collectNoteSources()) {
    for (const note of parsed) {
      const key = note.id || `${note.createdAt}:${note.text}`;
      notes.set(key, note);
    }
  }

  const merged = Array.from(notes.values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, MAX_NOTES);

  // Re-persist encrypted. This upgrades any legacy plaintext that was just
  // merged in, and rewrites the canonical key as ciphertext. Only after the
  // encrypted copy has verifiably landed do we delete the legacy plaintext
  // originals — otherwise the intimate free text they hold would sit in
  // localStorage forever (they are not `ss:`-prefixed, so the sign-out sweep
  // used to miss them too).
  const persisted = await persistEncrypted(merged);
  if (persisted) purgeLegacyPlaintext();
  return merged;
}

/**
 * Persist private notes, encrypted at rest with the device key.
 */
export async function savePrivateNotes(notes: PrivateNote[]): Promise<void> {
  if (typeof window === "undefined") return;
  await persistEncrypted(notes.slice(0, MAX_NOTES));
}

export async function privateNoteCount(): Promise<number> {
  return (await loadPrivateNotes()).length;
}

// --- Internals -------------------------------------------------------------

async function persistEncrypted(notes: PrivateNote[]): Promise<boolean> {
  try {
    const blob = await encryptNotes(notes);
    window.localStorage.setItem(PRIVATE_NOTES_STORAGE_KEY, JSON.stringify(blob));
    return true;
  } catch {
    // If encryption/storage fails we deliberately do NOT fall back to writing
    // plaintext — leaving the previous value in place is safer than silently
    // persisting the notes unencrypted.
    return false;
  }
}

/**
 * Delete the pre-encryption plaintext note keys. Called only after the merged
 * encrypted blob has persisted successfully, so this never destroys the only
 * copy. Idempotent; iterates backwards because removeItem reindexes.
 */
function purgeLegacyPlaintext(): void {
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (key && key.startsWith(LEGACY_PREFIX)) window.localStorage.removeItem(key);
    }
  } catch {
    // Storage unavailable — the sign-out sweep is the backstop.
  }
}

/**
 * Gather every place notes might live and return them as parsed note arrays.
 * Each source is either an encrypted blob (current canonical key) or legacy
 * plaintext JSON (the canonical key from before this change, plus the older
 * `sexualsync.*` keys). Legacy plaintext is parsed directly; encrypted blobs
 * are decrypted with the device key.
 */
async function collectNoteSources(): Promise<PrivateNote[][]> {
  const results: PrivateNote[][] = [];
  const rawSources: string[] = [];

  try {
    const current = window.localStorage.getItem(PRIVATE_NOTES_STORAGE_KEY);
    if (current) rawSources.push(current);
    const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) rawSources.push(legacy);
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index) || "";
      if (!key.startsWith(LEGACY_PREFIX)) continue;
      const value = window.localStorage.getItem(key);
      if (value) rawSources.push(value);
    }
  } catch { /* ignore */ }

  for (const raw of rawSources) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      continue;
    }
    if (isEncryptedBlob(parsedJson)) {
      try {
        results.push(await decryptNotes(parsedJson));
      } catch {
        // Wrong/rotated device key or corrupt blob — skip rather than throw so
        // any still-readable legacy sources can still surface.
      }
    } else {
      // Legacy plaintext shape (bare array, or object we can coerce). Parsing
      // it here is what lets loadPrivateNotes() transparently re-encrypt it on
      // the persist step.
      results.push(parseNotes(raw));
    }
  }
  return results;
}

function parseNotes(raw: string | null): PrivateNote[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const text = String((entry as { text?: unknown }).text || "").trim();
        if (!text) return null;
        const createdAt = String((entry as { createdAt?: unknown }).createdAt || new Date().toISOString());
        return {
          id: String((entry as { id?: unknown }).id || stableId(text, createdAt)),
          text,
          createdAt,
        };
      })
      .filter(Boolean) as PrivateNote[];
  } catch {
    return [];
  }
}

function stableId(text: string, createdAt: string) {
  let hash = 0;
  const input = `${createdAt}:${text}`;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(index)) | 0;
  }
  return `note-${Math.abs(hash)}`;
}
