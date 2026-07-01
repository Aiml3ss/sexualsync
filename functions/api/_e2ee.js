const ROOM_E2EE_MARKER = "__sxsRoomEncrypted";
const ROOM_E2EE_VERSION = "sxs-room-e2ee-v1";
// Opt-in KDF versions whose discriminator the server must carry through. v1
// (PBKDF2 310k) is the historical default and tags boxes with NO `kdf` field;
// v2 (600k) is enabled per deploy via ROOM_E2EE_KDF_VERSION and stamps each box
// with `kdf:"v2"`. The box `version` string stays v1 for every KDF version, so
// every other check here (and the client's isRoomEncryptedBox) is unaffected.
const ROOM_E2EE_KDF_VERSIONS = new Set(["v2"]);

export function cleanRoomEncryptedBox(value, maxCiphertext = 60000) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value[ROOM_E2EE_MARKER] !== true) return null;
  if (value.version !== ROOM_E2EE_VERSION || value.algorithm !== "AES-GCM") return null;
  const iv = cleanBase64(value.iv, 120);
  const ciphertext = cleanBase64(value.ciphertext, maxCiphertext);
  if (!iv || !ciphertext) return null;
  const box = {
    [ROOM_E2EE_MARKER]: true,
    version: ROOM_E2EE_VERSION,
    algorithm: "AES-GCM",
    iv,
    ciphertext
  };
  // CRITICAL (data-loss): the box's KDF version is the ONLY signal the client has
  // for how many PBKDF2 iterations to derive at on read. The server can never
  // re-derive the key, so dropping this field would silently make a v2 box
  // undecryptable — the client would derive at the v1 310k count and AES-GCM auth
  // would fail. Preserve it for known KDF versions; a v1 box omits it entirely and
  // is therefore byte-identical to the historical shape.
  if (ROOM_E2EE_KDF_VERSIONS.has(value.kdf)) box.kdf = value.kdf;
  return box;
}

function cleanBase64(value, max) {
  return String(value || "").replace(/[^A-Za-z0-9+/=_-]/g, "").slice(0, max);
}
