// Per-image content key for Sext image messages. Each image gets a fresh random
// AES-GCM key, so the bytes in R2 are always ciphertext. The key + IV travel
// WITH the message: inside the room-E2EE box when Room Encryption is on (the
// server never sees them), or in the message's media field otherwise — where
// they're protected at rest by the same store envelope as plaintext chat text.
// Either way the raw image is never stored or transmitted in the clear.

export interface ChatImageCipher {
  ciphertext: Blob;
  keyB64: string;
  ivB64: string;
}

export async function encryptChatImage(source: Blob): Promise<ChatImageCipher> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, await source.arrayBuffer());
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return {
    ciphertext: new Blob([ciphertext], { type: "application/octet-stream" }),
    keyB64: bytesToBase64(raw),
    ivB64: bytesToBase64(iv),
  };
}

export async function decryptChatImage(
  ciphertext: ArrayBuffer,
  keyB64: string,
  ivB64: string,
  mediaType: string,
): Promise<Blob> {
  const key = await crypto.subtle.importKey("raw", bufferSource(base64ToBytes(keyB64)), { name: "AES-GCM" }, false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bufferSource(base64ToBytes(ivB64)) }, key, ciphertext);
  return new Blob([decrypted], { type: mediaType || "image/jpeg" });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bufferSource(bytes: Uint8Array): BufferSource {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
