import { test } from "node:test";
import assert from "node:assert/strict";
import { publicVaultItem } from "../../functions/api/_vault.js";

test("publicVaultItem never serializes the R2 media key or any plaintext", () => {
  const pub = publicVaultItem({
    id: "i1",
    workspaceId: "w1",
    mediaKey: "vault/w1/i1/secret-clip",
    addedByEmail: "Alex@x.com",
    displayTitle: "Private Clip",
    title: { ciphertext: "QUJD", iv: "SVZJVg", plaintext: "should-not-leak" },
    comments: [{ id: "c1", email: "a@x.com", body: { ciphertext: "Q0lQ", iv: "SVY", plaintext: "leak" } }],
    moments: [{ id: "m1", frameIv: "SVY", title: { ciphertext: "TVQ", iv: "SVY", plaintext: "moment leak" } }],
    encryption: { iterations: 5 }, // absurdly low
  });

  assert.equal(pub.mediaKey, undefined);
  assert.equal(pub.hasVideo, true);                 // presence is exposed, key is not
  assert.equal(pub.title.plaintext, undefined);     // only ciphertext + iv survive
  assert.equal(pub.title.ciphertext, "QUJD");
  assert.equal(pub.displayTitle, "Private Clip");
  assert.equal(pub.comments[0].body.plaintext, undefined);
  assert.equal(pub.moments[0].title.plaintext, undefined);
  assert.equal(pub.addedByEmail, "alex@x.com");      // normalized
});

test("KDF iteration count is clamped to a safe floor", () => {
  const low = publicVaultItem({ id: "i", workspaceId: "w", encryption: { iterations: 5 } });
  assert.ok(low.encryption.iterations >= 100000);

  const high = publicVaultItem({ id: "i", workspaceId: "w", encryption: { iterations: 9_000_000 } });
  assert.ok(high.encryption.iterations <= 600000);

  const missing = publicVaultItem({ id: "i", workspaceId: "w", encryption: {} });
  assert.equal(missing.encryption.iterations, 210000); // default
});

test("items without id/workspace metadata still produce a stable shape", () => {
  const pub = publicVaultItem({});
  assert.equal(pub.hasVideo, false);
  assert.deepEqual(pub.title, { ciphertext: "", iv: "" });
});

test("publicVaultItem masks legacy plaintext displayTitle so dumps never leak the real name", () => {
  const pub = publicVaultItem({
    id: "i1",
    workspaceId: "w1",
    addedByEmail: "alex@x.com",
    displayTitle: "Honeymoon highlight reel",
    title: { ciphertext: "QUJD", iv: "SVY" },
    encryption: { iterations: 210000 },
  });
  assert.equal(pub.displayTitle, "Private Clip");
});
