"use client";

/**
 * Device-key encryption-at-rest for small, sensitive client-side caches that
 * are NOT the canonical store — currently Vault titles (`ss:vault:title:*`) and
 * the kink composer draft (`ss:kink-composer-draft:*`). Both previously sat in
 * localStorage as plaintext, so a browser extension or a forensic disk image
 * could read decrypted Vault titles and in-progress intimate drafts verbatim.
 *
 * Scheme mirrors private-notes.ts (PBKDF2 → non-extractable AES-GCM derived
 * from a per-install random device secret) but deliberately uses its OWN device
 * secret + salt. Sharing private-notes' material risked rotating or orphaning
 * real notes; an independent secret keeps this module unable to perturb that
 * working path. Same threat ceiling as private-notes: this defeats casual reads
 * on an unlocked device, forensic images, and extensions that scrape a single
 * key — it does NOT defend against an attacker who reads BOTH the ciphertext
 * AND the device secret out of the same localStorage. All keys are `ss:*`, so
 * local-storage-sweep.ts wipes them on sign-out / cross-tab relock.
 *
 * Storage format: JSON `{ v, iv, ct }`. Legacy plaintext (anything that doesn't
 * parse to that shape — e.g. the old bare title string) is handed back verbatim
 * and upgraded to ciphertext on the next write.
 */

const DEVICE_SECRET_KEY = "ss:device-cipher:dk:v1";
const DEVICE_SALT = "ss:device-cipher:salt:v1";
const ITERATIONS = 210_000;
const VERSION = 1 as const;

interface CipherBlob {
  v: typeof VERSION;
  iv: string;
  ct: string;
}

// --- Base64 helpers (chunked, matches private-notes/vault-crypto) ----------

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

// --- Device key (cached for the tab; holds an opaque non-extractable key) ---

let _deviceKeyPromise: Promise<CryptoKey> | null = null;

function readOrCreateDeviceSecret(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_SECRET_KEY);
    if (existing) return existing;
  } catch { /* ignore */ }
  const secret = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  try { window.localStorage.setItem(DEVICE_SECRET_KEY, secret); } catch { /* ignore */ }
  return secret;
}

function getDeviceKey(): Promise<CryptoKey> {
  if (_deviceKeyPromise) return _deviceKeyPromise;
  _deviceKeyPromise = (async () => {
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(readOrCreateDeviceSecret()),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: new TextEncoder().encode(DEVICE_SALT),
        iterations: ITERATIONS,
      },
      material,
      { name: "AES-GCM", length: 256 },
      false, // non-extractable
      ["encrypt", "decrypt"],
    );
  })();
  _deviceKeyPromise.catch(() => { _deviceKeyPromise = null; });
  return _deviceKeyPromise;
}

function isCipherBlob(value: unknown): value is CipherBlob {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { v?: unknown }).v === VERSION &&
    typeof (value as { iv?: unknown }).iv === "string" &&
    typeof (value as { ct?: unknown }).ct === "string"
  );
}

// --- Public API ------------------------------------------------------------

/** Encrypt a string to a JSON blob suitable for localStorage. */
export async function encryptToString(plaintext: string): Promise<string> {
  const key = await getDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const blob: CipherBlob = {
    v: VERSION,
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(encrypted)),
  };
  return JSON.stringify(blob);
}

/**
 * Decrypt a stored value. Returns "" for empty/undecryptable input. Legacy
 * plaintext (not our blob shape) is returned verbatim so the caller can show it
 * and re-persist it encrypted on the next write.
 */
export async function decryptFromString(stored: string | null | undefined): Promise<string> {
  if (!stored) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return stored; // not JSON at all → legacy bare-string plaintext
  }
  if (!isCipherBlob(parsed)) return stored; // JSON but not our blob → legacy plaintext
  try {
    const key = await getDeviceKey();
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(parsed.iv) as BufferSource },
      key,
      base64ToBytes(parsed.ct) as BufferSource,
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return ""; // wrong/rotated key or corrupt blob → nothing readable
  }
}
