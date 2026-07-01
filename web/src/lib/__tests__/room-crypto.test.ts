// room-crypto unit tests (stateless surface).
//
// room-crypto.ts is the realtime/room E2EE. Its encrypt/decrypt round-trip is
// gated behind a stateful unlock (localStorage + PBKDF2 verifier) that isn't
// reproducible in a plain node test without heavy DOM shims, so these tests
// cover the security-critical *stateless* surface that needs no unlock:
//   - isRoomEncryptedBox: the guard that decides whether a value is treated as
//     ciphertext (a false positive would mishandle plaintext; a false negative
//     would render encrypted content as a locked blob).
//   - generateRoomPassphrase: shape + ambiguity-free alphabet + non-repetition.
//   - tryDecryptRoomJson: the non-box short-circuit (plaintext passthrough).
// The unlocked round-trip is intentionally left for a DOM-backed harness.
import { describe, expect, it } from "vitest";

import {
  ROOM_E2EE_MARKER,
  ROOM_E2EE_VERSION,
  generateRoomPassphrase,
  isRoomEncryptedBox,
  tryDecryptRoomJson,
} from "../room-crypto";

function validBox(): Record<string, unknown> {
  return {
    [ROOM_E2EE_MARKER]: true,
    version: ROOM_E2EE_VERSION,
    algorithm: "AES-GCM",
    iv: "ml4Ya2Jr",
    ciphertext: "Y2lwaGVy",
  };
}

describe("room-crypto: isRoomEncryptedBox", () => {
  it("accepts a well-formed encrypted box", () => {
    expect(isRoomEncryptedBox(validBox())).toBe(true);
    // An optional kdf tag (v2 rooms) must not break recognition.
    expect(isRoomEncryptedBox({ ...validBox(), kdf: "v2" })).toBe(true);
  });

  it("rejects non-objects and arrays", () => {
    for (const value of [null, undefined, 0, 1, "", "str", true, false, [], [validBox()]]) {
      expect(isRoomEncryptedBox(value)).toBe(false);
    }
  });

  it("rejects a box with any required field missing or wrong-typed", () => {
    const without = (key: string) => {
      const box = validBox();
      delete box[key];
      return box;
    };
    expect(isRoomEncryptedBox({ ...validBox(), [ROOM_E2EE_MARKER]: false })).toBe(false);
    expect(isRoomEncryptedBox(without(ROOM_E2EE_MARKER))).toBe(false);
    expect(isRoomEncryptedBox({ ...validBox(), version: "sxs-room-e2ee-v0" })).toBe(false);
    expect(isRoomEncryptedBox({ ...validBox(), algorithm: "AES-CBC" })).toBe(false);
    expect(isRoomEncryptedBox({ ...validBox(), iv: 123 })).toBe(false);
    expect(isRoomEncryptedBox({ ...validBox(), ciphertext: null })).toBe(false);
    expect(isRoomEncryptedBox(without("iv"))).toBe(false);
    expect(isRoomEncryptedBox(without("ciphertext"))).toBe(false);
  });
});

describe("room-crypto: generateRoomPassphrase", () => {
  it("is five dash-separated groups of four unambiguous chars", () => {
    expect(generateRoomPassphrase()).toMatch(/^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){4}$/);
  });

  it("never emits ambiguous characters (i, l, o, 0, 1)", () => {
    const sample = Array.from({ length: 100 }, () => generateRoomPassphrase()).join("");
    expect(sample).not.toMatch(/[ilo01]/);
  });

  it("does not repeat across calls", () => {
    const passphrases = new Set(Array.from({ length: 20 }, () => generateRoomPassphrase()));
    expect(passphrases.size).toBe(20);
  });
});

describe("room-crypto: tryDecryptRoomJson", () => {
  it("treats a non-box value as plaintext (ok:false, locked:false)", async () => {
    expect(await tryDecryptRoomJson("ws1", "purpose", { plain: "value" })).toEqual({
      ok: false,
      locked: false,
      value: null,
    });
    expect(await tryDecryptRoomJson("ws1", "purpose", "just a string")).toEqual({
      ok: false,
      locked: false,
      value: null,
    });
    expect(await tryDecryptRoomJson("ws1", "purpose", null)).toEqual({
      ok: false,
      locked: false,
      value: null,
    });
  });
});
