// room-crypto end-to-end round-trip tests (unlocked path).
//
// Companion to room-crypto.test.ts (which covers the stateless surface). This
// suite exercises the real encrypt/decrypt path through an actual unlock. It
// runs in plain node: room-crypto guards every window/storage call with
// `typeof window === "undefined"` and degrades when indexedDB is absent, so
// unlockRoomE2ee still derives the key and seeds the in-memory KEY_CACHE without
// any DOM — no jsdom/localStorage/indexedDB shim required. crypto.subtle is the
// node webcrypto global. Each test uses a unique workspace id so the module-level
// KEY_CACHE never leaks between tests.
import { afterEach, describe, expect, it } from "vitest";

import {
  ROOM_E2EE_MARKER,
  ROOM_E2EE_VERSION,
  createRoomBlindIndex,
  decryptRoomJson,
  encryptRoomJson,
  hasUnlockedRoomE2eeKey,
  isRoomEncryptedBox,
  lockRoomE2ee,
  tryDecryptRoomJson,
  unlockRoomE2ee,
} from "../room-crypto";

const PASS = "room-passphrase-test-123"; // >= ROOM_PASSPHRASE_MIN_UNLOCK (12)
const used: string[] = [];

async function freshUnlockedRoom(name: string): Promise<string> {
  const id = `ws-${name}-${used.length}`;
  used.push(id);
  await unlockRoomE2ee(id, PASS); // new room (no verifier) → v1 KDF
  return id;
}

afterEach(() => {
  // Drop every key derived this run so KEY_CACHE never bleeds across tests.
  used.splice(0).forEach((id) => lockRoomE2ee(id));
});

describe("room-crypto: encrypt/decrypt round-trip", () => {
  it("unlock seeds the key cache; encrypt produces a recognizable box", async () => {
    const ws = await freshUnlockedRoom("seed");
    expect(hasUnlockedRoomE2eeKey(ws)).toBe(true);
    const box = await encryptRoomJson(ws, "note", { hello: "world", n: 42 });
    expect(isRoomEncryptedBox(box)).toBe(true);
    expect((box as Record<string, unknown>)[ROOM_E2EE_MARKER]).toBe(true);
    expect(box.version).toBe(ROOM_E2EE_VERSION);
    expect(box.algorithm).toBe("AES-GCM");
    expect(typeof box.iv).toBe("string");
    expect(typeof box.ciphertext).toBe("string");
  });

  it("round-trips objects, arrays, unicode, and null", async () => {
    const ws = await freshUnlockedRoom("types");
    for (const value of [
      { a: 1, nested: { b: [1, 2, 3] } },
      ["x", "y", "z"],
      "héllo 🔒 dîrty",
      42,
      null,
    ]) {
      const box = await encryptRoomJson(ws, "p", value);
      expect(await decryptRoomJson(ws, "p", box)).toEqual(value);
    }
  });

  it("uses a fresh IV per message (no nonce reuse for identical input)", async () => {
    const ws = await freshUnlockedRoom("iv");
    const a = await encryptRoomJson(ws, "p", { same: true });
    const b = await encryptRoomJson(ws, "p", { same: true });
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});

describe("room-crypto: AAD binding", () => {
  it("rejects decryption under a different purpose", async () => {
    const ws = await freshUnlockedRoom("purpose");
    const box = await encryptRoomJson(ws, "title", { secret: "x" });
    await expect(decryptRoomJson(ws, "comment", box)).rejects.toBeTruthy();
  });

  it("rejects decryption under a different workspace (key + AAD both differ)", async () => {
    const wsA = await freshUnlockedRoom("wsA");
    const wsB = await freshUnlockedRoom("wsB"); // same passphrase, different room
    const box = await encryptRoomJson(wsA, "note", { secret: "x" });
    await expect(decryptRoomJson(wsB, "note", box)).rejects.toBeTruthy();
  });
});

describe("room-crypto: tryDecryptRoomJson (stateful)", () => {
  it("decrypts when the room is unlocked", async () => {
    const ws = await freshUnlockedRoom("try-unlocked");
    const box = await encryptRoomJson(ws, "note", { ok: 1 });
    expect(await tryDecryptRoomJson(ws, "note", box)).toEqual({ ok: true, locked: false, value: { ok: 1 } });
  });

  it("reports locked (not crash) when the room is locked", async () => {
    const ws = await freshUnlockedRoom("try-locked");
    const box = await encryptRoomJson(ws, "note", { ok: 1 });
    lockRoomE2ee(ws);
    expect(hasUnlockedRoomE2eeKey(ws)).toBe(false);
    expect(await tryDecryptRoomJson(ws, "note", box)).toEqual({ ok: false, locked: true, value: null });
  });
});

describe("room-crypto: createRoomBlindIndex", () => {
  it("is deterministic and case/space-insensitive for the same room+purpose", async () => {
    const ws = await freshUnlockedRoom("blind");
    const a = await createRoomBlindIndex(ws, "tag", "Hello");
    const b = await createRoomBlindIndex(ws, "tag", "  hello ");
    expect(a).toBe(b);
    expect(a).toMatch(/^sxs-bi-v1:/);
  });

  it("differs by value and by purpose", async () => {
    const ws = await freshUnlockedRoom("blind2");
    const base = await createRoomBlindIndex(ws, "tag", "alpha");
    expect(await createRoomBlindIndex(ws, "tag", "beta")).not.toBe(base);
    expect(await createRoomBlindIndex(ws, "other", "alpha")).not.toBe(base);
  });
});

describe("room-crypto: lock", () => {
  it("lockRoomE2ee clears the unlocked key", async () => {
    const ws = await freshUnlockedRoom("lock");
    expect(hasUnlockedRoomE2eeKey(ws)).toBe(true);
    lockRoomE2ee(ws);
    expect(hasUnlockedRoomE2eeKey(ws)).toBe(false);
    await expect(encryptRoomJson(ws, "note", { x: 1 })).rejects.toThrow();
  });
});
