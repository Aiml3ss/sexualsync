import type { EncryptedBox, VaultItem } from "./types";

export const VAULT_KDF_ITERATIONS = 210000;
export const VAULT_CRYPTO_VERSION = "v2";

export interface EncryptedBlobResult {
  blob: Blob;
  salt: string;
  iv: string;
  iterations: number;
  version?: typeof VAULT_CRYPTO_VERSION;
}

export interface VaultAadParts {
  workspaceId: string;
  itemId: string;
  purpose: string;
  subId?: string | number;
}

// Encrypt with a passphrase. Used at upload time when the caller hasn't
// derived a key yet — internally derives once and immediately discards the
// passphrase string. After upload, callers should switch to the *WithKey
// variants so the passphrase string never re-enters their hot path.
export async function encryptVaultBlob(
  source: Blob,
  passphrase: string,
  salt = randomBase64(16),
  iterations = VAULT_KDF_ITERATIONS,
): Promise<EncryptedBlobResult> {
  const key = await deriveVaultKey(passphrase, salt, iterations);
  return encryptVaultBlobWithKey(source, key, salt, iterations);
}

export async function encryptVaultBlobWithKey(
  source: Blob,
  key: CryptoKey,
  salt: string,
  iterations: number,
  aad?: string,
): Promise<EncryptedBlobResult> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(aesGcmParams(iv, aad), key, await source.arrayBuffer());
  return {
    blob: new Blob([encrypted], { type: "application/octet-stream" }),
    salt,
    iv: bytesToBase64(iv),
    iterations,
    ...(aad ? { version: VAULT_CRYPTO_VERSION } : {}),
  };
}

export async function decryptVaultBlob(
  source: Blob,
  passphrase: string,
  item: VaultItem,
  ivBase64 = item.encryption.videoIv,
  type = item.mediaType || "video/mp4",
): Promise<Blob> {
  const key = await deriveVaultKey(passphrase, item.encryption.salt, item.encryption.iterations);
  return decryptVaultBlobWithKey(source, key, ivBase64, type);
}

export async function decryptVaultBlobWithKey(
  source: Blob,
  key: CryptoKey,
  ivBase64: string,
  type: string,
  aad?: string,
): Promise<Blob> {
  const iv = base64ToBytes(ivBase64);
  const ciphertext = await source.arrayBuffer();
  const decrypted = await decryptAesGcmWithOptionalLegacyFallback(key, iv, ciphertext, aad);
  return new Blob([decrypted], { type });
}

export async function encryptVaultText(
  text: string,
  passphrase: string,
  salt: string,
  iterations = VAULT_KDF_ITERATIONS,
): Promise<EncryptedBox> {
  const key = await deriveVaultKey(passphrase, salt, iterations);
  return encryptVaultTextWithKey(text, key);
}

export async function encryptVaultTextWithKey(text: string, key: CryptoKey, aad?: string): Promise<EncryptedBox> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);
  const encrypted = await crypto.subtle.encrypt(aesGcmParams(iv, aad), key, encoded);
  return {
    ...(aad ? { v: VAULT_CRYPTO_VERSION } : {}),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv),
  };
}

export async function decryptVaultText(
  box: EncryptedBox | null | undefined,
  passphrase: string,
  item: VaultItem,
): Promise<string> {
  if (!box?.ciphertext || !box.iv) return "";
  const key = await deriveVaultKey(passphrase, item.encryption.salt, item.encryption.iterations);
  return decryptVaultTextWithKey(box, key);
}

export async function decryptVaultTextWithKey(
  box: EncryptedBox | null | undefined,
  key: CryptoKey,
  aad?: string,
): Promise<string> {
  if (!box?.ciphertext || !box.iv) return "";
  const decrypted = await decryptAesGcmWithOptionalLegacyFallback(
    key,
    base64ToBytes(box.iv),
    bytesToBufferSource(base64ToBytes(box.ciphertext)),
    aad,
  );
  return new TextDecoder().decode(decrypted);
}

export function vaultAad(parts: VaultAadParts): string {
  return JSON.stringify({
    v: VAULT_CRYPTO_VERSION,
    workspaceId: String(parts.workspaceId || ""),
    itemId: String(parts.itemId || ""),
    purpose: String(parts.purpose || ""),
    ...(parts.subId !== undefined ? { subId: String(parts.subId) } : {}),
  });
}

function aesGcmParams(iv: Uint8Array, aad?: string): AesGcmParams {
  return aad
    ? { name: "AES-GCM", iv: bytesToBufferSource(iv), additionalData: bytesToBufferSource(new TextEncoder().encode(aad)) }
    : { name: "AES-GCM", iv: bytesToBufferSource(iv) };
}

async function decryptAesGcmWithOptionalLegacyFallback(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: BufferSource,
  aad?: string,
): Promise<ArrayBuffer> {
  if (aad) {
    try {
      return await crypto.subtle.decrypt(aesGcmParams(iv, aad), key, ciphertext);
    } catch {
      // Existing live vault records were written before AAD binding. Keep them
      // readable; new v2 ciphertext still fails here if the AAD is wrong.
    }
  }
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: bytesToBufferSource(iv) }, key, ciphertext);
}

// Derive once at unlock time, then hand back a non-extractable CryptoKey for
// the caller to hold instead of the passphrase string. After this resolves
// the caller should `passphrase = ""` and clear any local copies so the
// only material left in memory is the opaque CryptoKey.
export async function deriveVaultUnlockKey(
  passphrase: string,
  saltBase64: string,
  iterations: number,
): Promise<CryptoKey> {
  return deriveVaultKey(passphrase, saltBase64, iterations);
}

export function randomBase64(length: number) {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(length)));
}

// PBKDF2 @ 210k iterations costs ~100-300ms on a phone. Opening one vault item
// decrypts the video, the title, every comment, and every moment + note — all
// with the SAME (passphrase, salt, iterations), so the derived key is identical.
// Memoize it: the cache key is computed synchronously and the in-flight promise
// is stored immediately, so the parallel decrypt calls in decryptItemSidecars
// share a single derivation instead of paying the PBKDF2 cost N times.
//
// The cache key uses a fingerprint of the passphrase (salt-bound SHA-256) so
// the raw passphrase string is never the Map key — a heap dump or hostile
// extension scraping module state won't pull it back out of here.
const _keyCache = new Map<string, Promise<CryptoKey>>();
const _KEY_CACHE_MAX = 8;

export function clearVaultKeyCache() {
  _keyCache.clear();
}

async function deriveVaultKeyUncached(cleanPassphrase: string, saltBase64: string, iterations: number) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(cleanPassphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: base64ToBytes(saltBase64),
      iterations,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function passphraseFingerprint(passphrase: string, saltBase64: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`vault-cache:${saltBase64}:${passphrase}`),
  );
  return bytesToBase64(new Uint8Array(digest));
}

async function deriveVaultKey(passphrase: string, saltBase64: string, iterations: number) {
  const cleanPassphrase = passphrase.trim();
  if (!cleanPassphrase) throw new Error("Enter the Vault passphrase.");
  const fingerprint = await passphraseFingerprint(cleanPassphrase, saltBase64);
  const cacheKey = `${iterations}:${saltBase64}:${fingerprint}`;
  const cached = _keyCache.get(cacheKey);
  if (cached) return cached;

  const promise = deriveVaultKeyUncached(cleanPassphrase, saltBase64, iterations);
  if (_keyCache.size >= _KEY_CACHE_MAX) {
    const oldest = _keyCache.keys().next().value;
    if (oldest) _keyCache.delete(oldest);
  }
  _keyCache.set(cacheKey, promise);
  // If derivation throws, drop the entry so a retry can re-derive.
  promise.catch(() => { _keyCache.delete(cacheKey); });
  return promise;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
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

function bytesToBufferSource(bytes: Uint8Array): BufferSource {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
