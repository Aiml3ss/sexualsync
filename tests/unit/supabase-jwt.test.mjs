import { test } from "node:test";
import assert from "node:assert/strict";
import {
  relationalBackendEnabled,
  supabaseSubForEmail,
  mintSupabaseJwt,
  mintSupabaseJwtForEmail,
} from "../../functions/api/_supabase_jwt.js";

const SECRET = "test-supabase-jwt-secret-0123456789abcdef";

function b64urlToBytes(s) {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(norm);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function decodeJwtPart(part) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
}
async function verifyHs256(jwt, secret) {
  const [h, p, sig] = jwt.split(".");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`));
}

test("relationalBackendEnabled requires DATA_BACKEND=relational AND a secret", () => {
  assert.equal(relationalBackendEnabled({}), false);
  assert.equal(relationalBackendEnabled({ DATA_BACKEND: "relational" }), false); // no secret
  assert.equal(relationalBackendEnabled({ SUPABASE_JWT_SECRET: SECRET }), false); // no mode
  assert.equal(relationalBackendEnabled({ DATA_BACKEND: "kv", SUPABASE_JWT_SECRET: SECRET }), false);
  assert.equal(relationalBackendEnabled({ DATA_BACKEND: "relational", SUPABASE_JWT_SECRET: SECRET }), true);
});

test("mintSupabaseJwt is inert without a secret", async () => {
  assert.equal(await mintSupabaseJwt({}, { sub: "x" }), null);
  assert.equal(await mintSupabaseJwt({ SUPABASE_JWT_SECRET: SECRET }, {}), null); // no sub
});

test("minted JWT has Supabase-compatible claims and a valid HS256 signature", async () => {
  const jwt = await mintSupabaseJwt({ SUPABASE_JWT_SECRET: SECRET }, { sub: "abc", email: "a@b.com", ttlSeconds: 600 });
  const parts = jwt.split(".");
  assert.equal(parts.length, 3);

  const header = decodeJwtPart(parts[0]);
  assert.equal(header.alg, "HS256");
  assert.equal(header.typ, "JWT");

  const payload = decodeJwtPart(parts[1]);
  assert.equal(payload.sub, "abc");
  assert.equal(payload.role, "authenticated");
  assert.equal(payload.aud, "authenticated");
  assert.equal(payload.email, "a@b.com");
  assert.ok(payload.exp > payload.iat);

  assert.equal(await verifyHs256(jwt, SECRET), true, "signature must verify with the project secret");
  assert.equal(await verifyHs256(jwt, "wrong-secret"), false, "a different secret must not verify");
});

test("supabaseSubForEmail is deterministic, case-insensitive, and a valid UUID", async () => {
  const a = await supabaseSubForEmail("Alex@Example.com");
  const b = await supabaseSubForEmail("alex@example.com  ");
  assert.equal(a, b, "same email (normalized) -> same id");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const c = await supabaseSubForEmail("jordan@example.com");
  assert.notEqual(a, c, "different emails -> different ids");
  assert.equal(await supabaseSubForEmail(""), "");
});

test("mintSupabaseJwtForEmail uses the stable per-email sub", async () => {
  const env = { SUPABASE_JWT_SECRET: SECRET };
  const jwt = await mintSupabaseJwtForEmail(env, "a@b.com");
  const payload = decodeJwtPart(jwt.split(".")[1]);
  assert.equal(payload.sub, await supabaseSubForEmail("a@b.com"));
});
