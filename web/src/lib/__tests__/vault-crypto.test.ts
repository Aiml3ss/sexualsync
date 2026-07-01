// vault-crypto unit tests.
//
// vault-crypto.ts is the at-rest E2EE for Vault media + sidecar text (titles,
// comments, moments). These tests pin the security-critical invariants: AES-GCM
// round-trips, AAD binding (v2) with the documented legacy no-AAD fallback,
// authentication (tamper / wrong key reject), fresh-IV-per-message, and the
// PBKDF2 unlock-key derivation. Uses a raw AES key for speed except where the
// KDF itself is under test (then a tiny iteration count).
import { beforeEach, describe, expect, it } from "vitest";

import {
  VAULT_CRYPTO_VERSION,
  clearVaultKeyCache,
  decryptVaultBlobWithKey,
  decryptVaultTextWithKey,
  deriveVaultUnlockKey,
  encryptVaultBlobWithKey,
  encryptVaultTextWithKey,
  randomBase64,
  vaultAad,
} from "../vault-crypto";

async function makeKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function flipFirstCiphertextByte(box: { ciphertext: string; iv: string }) {
  const bytes = Uint8Array.from(atob(box.ciphertext), (c) => c.charCodeAt(0));
  bytes[0] ^= 0xff;
  return { ...box, ciphertext: btoa(String.fromCharCode(...bytes)) };
}

describe("vault-crypto: text round-trip", () => {
  it("recovers plaintext with the same key and stamps no version without AAD", async () => {
    const key = await makeKey();
    const box = await encryptVaultTextWithKey("hello vault", key);
    expect(box.ciphertext).toBeTruthy();
    expect(box.iv).toBeTruthy();
    expect(box.v).toBeUndefined();
    expect(await decryptVaultTextWithKey(box, key)).toBe("hello vault");
  });

  it("round-trips empty string, unicode, and a long payload", async () => {
    const key = await makeKey();
    for (const text of ["", "héllo 🔒 dîrty", "x".repeat(5000)]) {
      const box = await encryptVaultTextWithKey(text, key);
      expect(await decryptVaultTextWithKey(box, key)).toBe(text);
    }
  });

  it("returns '' for a null/undefined/empty box instead of throwing", async () => {
    const key = await makeKey();
    expect(await decryptVaultTextWithKey(null, key)).toBe("");
    expect(await decryptVaultTextWithKey(undefined, key)).toBe("");
    expect(await decryptVaultTextWithKey({ ciphertext: "", iv: "" }, key)).toBe("");
  });

  it("uses a fresh IV per message (no nonce reuse for identical plaintext)", async () => {
    const key = await makeKey();
    const a = await encryptVaultTextWithKey("same plaintext", key);
    const b = await encryptVaultTextWithKey("same plaintext", key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});

describe("vault-crypto: AAD binding (v2)", () => {
  it("stamps v2 and round-trips with the matching AAD", async () => {
    const key = await makeKey();
    const aad = vaultAad({ workspaceId: "ws1", itemId: "i1", purpose: "title" });
    const box = await encryptVaultTextWithKey("secret title", key, aad);
    expect(box.v).toBe(VAULT_CRYPTO_VERSION);
    expect(await decryptVaultTextWithKey(box, key, aad)).toBe("secret title");
  });

  it("rejects a wrong AAD — v2 ciphertext must not silently fall back", async () => {
    const key = await makeKey();
    const good = vaultAad({ workspaceId: "ws1", itemId: "i1", purpose: "title" });
    const wrong = vaultAad({ workspaceId: "ws1", itemId: "i1", purpose: "comment" });
    const box = await encryptVaultTextWithKey("secret", key, good);
    await expect(decryptVaultTextWithKey(box, key, wrong)).rejects.toBeTruthy();
  });

  it("still reads legacy no-AAD ciphertext when an AAD is supplied (migration fallback)", async () => {
    const key = await makeKey();
    const legacy = await encryptVaultTextWithKey("pre-AAD record", key); // written without AAD
    const aad = vaultAad({ workspaceId: "ws1", itemId: "i1", purpose: "title" });
    expect(await decryptVaultTextWithKey(legacy, key, aad)).toBe("pre-AAD record");
  });
});

describe("vault-crypto: authentication", () => {
  it("rejects a tampered ciphertext", async () => {
    const key = await makeKey();
    const box = await encryptVaultTextWithKey("tamper me", key);
    await expect(decryptVaultTextWithKey(flipFirstCiphertextByte(box), key)).rejects.toBeTruthy();
  });

  it("rejects decryption with the wrong key", async () => {
    const box = await encryptVaultTextWithKey("for key A", await makeKey());
    await expect(decryptVaultTextWithKey(box, await makeKey())).rejects.toBeTruthy();
  });
});

describe("vault-crypto: blob round-trip", () => {
  it("recovers binary bytes intact", async () => {
    const key = await makeKey();
    const data = crypto.getRandomValues(new Uint8Array(2048));
    const enc = await encryptVaultBlobWithKey(new Blob([data]), key, "saltB64", 1000);
    const dec = await decryptVaultBlobWithKey(enc.blob, key, enc.iv, "application/octet-stream");
    expect(new Uint8Array(await dec.arrayBuffer())).toEqual(data);
  });

  it("binds AAD on blobs and stamps the version", async () => {
    const key = await makeKey();
    const data = crypto.getRandomValues(new Uint8Array(128));
    const enc = await encryptVaultBlobWithKey(new Blob([data]), key, "saltB64", 1000, "blob-aad");
    expect(enc.version).toBe(VAULT_CRYPTO_VERSION);
    await expect(decryptVaultBlobWithKey(enc.blob, key, enc.iv, "x", "other-aad")).rejects.toBeTruthy();
  });
});

describe("vault-crypto: vaultAad", () => {
  it("emits the core fields + version and omits subId when undefined", () => {
    expect(JSON.parse(vaultAad({ workspaceId: "w", itemId: "i", purpose: "p" }))).toEqual({
      v: VAULT_CRYPTO_VERSION,
      workspaceId: "w",
      itemId: "i",
      purpose: "p",
    });
  });

  it("includes subId as a string when present", () => {
    expect(JSON.parse(vaultAad({ workspaceId: "w", itemId: "i", purpose: "p", subId: 3 })).subId).toBe("3");
  });

  it("differs across purpose/item so AAD can't be reused cross-field", () => {
    const a = vaultAad({ workspaceId: "w", itemId: "i", purpose: "title" });
    const b = vaultAad({ workspaceId: "w", itemId: "i", purpose: "comment" });
    const c = vaultAad({ workspaceId: "w", itemId: "j", purpose: "title" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("vault-crypto: randomBase64", () => {
  it("decodes to exactly the requested byte length", () => {
    expect(atob(randomBase64(16)).length).toBe(16);
    expect(atob(randomBase64(32)).length).toBe(32);
  });

  it("does not repeat across calls", () => {
    expect(randomBase64(16)).not.toBe(randomBase64(16));
  });
});

describe("vault-crypto: deriveVaultUnlockKey (PBKDF2)", () => {
  beforeEach(() => clearVaultKeyCache());

  it("derives an interoperable key for the same passphrase/salt/iterations", async () => {
    const salt = randomBase64(16);
    const encKey = await deriveVaultUnlockKey("correct horse battery", salt, 1000);
    const box = await encryptVaultTextWithKey("kdf round trip", encKey);
    const decKey = await deriveVaultUnlockKey("correct horse battery", salt, 1000);
    expect(await decryptVaultTextWithKey(box, decKey)).toBe("kdf round trip");
  });

  it("derives a non-interoperable key for a different passphrase", async () => {
    const salt = randomBase64(16);
    const box = await encryptVaultTextWithKey("x", await deriveVaultUnlockKey("pass-a", salt, 1000));
    await expect(decryptVaultTextWithKey(box, await deriveVaultUnlockKey("pass-b", salt, 1000))).rejects.toBeTruthy();
  });

  it("derives a non-interoperable key for a different salt", async () => {
    const box = await encryptVaultTextWithKey("y", await deriveVaultUnlockKey("same-pass", randomBase64(16), 1000));
    await expect(decryptVaultTextWithKey(box, await deriveVaultUnlockKey("same-pass", randomBase64(16), 1000))).rejects.toBeTruthy();
  });

  it("rejects a blank passphrase", async () => {
    await expect(deriveVaultUnlockKey("   ", randomBase64(16), 1000)).rejects.toThrow();
  });
});
