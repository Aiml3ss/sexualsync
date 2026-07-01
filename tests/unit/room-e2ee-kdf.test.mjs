// Contract test for the room-E2EE KDF version discriminator at the server seam.
//
// Why this matters — the data-loss bug this guards against:
//   cleanRoomEncryptedBox REBUILDS every stored room box from scratch, keeping
//   only an allowlist of fields. The box's `kdf` tag is the ONLY signal the
//   client has for how many PBKDF2 iterations to derive at on read, and the
//   server can never re-derive the key. If the rebuild dropped `kdf`, a v2 box
//   (encrypted at 600k) would come back looking like a v1 box (310k) and become
//   permanently undecryptable — AES-GCM auth would fail with the wrong key.
//
//   The flip side is just as important: a v1 box must stay byte-identical to its
//   historical 5-field shape (no `kdf`), because the live production rooms are
//   all v1 and the client/server validity checks depend on that shape.

import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanRoomEncryptedBox } from "../../functions/api/_e2ee.js";

const MARKER = "__sxsRoomEncrypted";

function v1Box(extra = {}) {
  return {
    [MARKER]: true,
    version: "sxs-room-e2ee-v1",
    algorithm: "AES-GCM",
    iv: "AAECAwQFBgcICQoL",
    ciphertext: "j9qTaNbvTEZQd7nb18i9mQ==",
    ...extra,
  };
}

test("v1 box round-trips to the byte-identical 5-field shape with no kdf", () => {
  const cleaned = cleanRoomEncryptedBox(v1Box());
  assert.ok(cleaned);
  assert.equal("kdf" in cleaned, false);
  assert.deepEqual(
    Object.keys(cleaned).sort(),
    [MARKER, "algorithm", "ciphertext", "iv", "version"].sort(),
  );
  assert.equal(cleaned.version, "sxs-room-e2ee-v1");
  assert.equal(cleaned.algorithm, "AES-GCM");
});

test("v2 box preserves the kdf discriminator (data-loss critical)", () => {
  const cleaned = cleanRoomEncryptedBox(v1Box({ kdf: "v2" }));
  assert.ok(cleaned);
  assert.equal(cleaned.kdf, "v2");
  // version string is unchanged across KDF versions
  assert.equal(cleaned.version, "sxs-room-e2ee-v1");
  assert.deepEqual(
    Object.keys(cleaned).sort(),
    [MARKER, "algorithm", "ciphertext", "iv", "kdf", "version"].sort(),
  );
});

test("verifier-sized boxes (smaller max) still preserve kdf", () => {
  // profile.js stores the verifier through cleanRoomEncryptedBox(value, 8192).
  const cleaned = cleanRoomEncryptedBox(v1Box({ kdf: "v2" }), 8192);
  assert.ok(cleaned);
  assert.equal(cleaned.kdf, "v2");
});

test("unknown kdf values are dropped, not stored (box stays valid v1-shaped)", () => {
  for (const kdf of ["v1", "v3", "V2", "", 2, true, {}, null]) {
    const cleaned = cleanRoomEncryptedBox(v1Box({ kdf }));
    assert.ok(cleaned, `box with kdf=${JSON.stringify(kdf)} must still be accepted`);
    assert.equal("kdf" in cleaned, false, `kdf=${JSON.stringify(kdf)} must not be persisted`);
  }
});

test("invalid boxes are rejected regardless of kdf", () => {
  assert.equal(cleanRoomEncryptedBox(null), null);
  assert.equal(cleanRoomEncryptedBox([]), null);
  assert.equal(cleanRoomEncryptedBox({ kdf: "v2" }), null); // missing marker
  assert.equal(cleanRoomEncryptedBox(v1Box({ [MARKER]: false })), null);
  assert.equal(cleanRoomEncryptedBox(v1Box({ version: "sxs-room-e2ee-v2", kdf: "v2" })), null); // version string never changes
  assert.equal(cleanRoomEncryptedBox(v1Box({ algorithm: "AES-CBC", kdf: "v2" })), null);
  assert.equal(cleanRoomEncryptedBox(v1Box({ iv: "", kdf: "v2" })), null);
  assert.equal(cleanRoomEncryptedBox(v1Box({ ciphertext: "", kdf: "v2" })), null);
});
