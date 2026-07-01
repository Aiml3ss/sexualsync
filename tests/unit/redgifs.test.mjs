import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequestGet as redgifs } from "../../functions/api/redgifs.js";
import { redgifsCandidatesFromText } from "../../functions/api/_redgifs.js";
import { getStore } from "../../functions/api/_kv.js";
import { makeStateEnv } from "./helpers.mjs";

const call = (env, url) => redgifs({ request: new Request(url, { method: "GET" }), env });

// Seeding the server-side gif cache lets us exercise the endpoint (auth, id
// candidates, response shape) without reaching the RedGifs network.
async function seedGif(env, id, payload) {
  await getStore(env, "sexualsync-redgifs-cache").setJSON(`redgifs:v2:gif:${id}`, payload);
}

test("candidate extraction mirrors the shelf: handles watch/share paths, dashed slugs, bare ids", () => {
  // Standard watch URL → the one id.
  assert.deepEqual(redgifsCandidatesFromText("https://www.redgifs.com/watch/test123"), ["test123"]);
  // Share-button style path (any /<word>/<id>) still yields the id.
  assert.deepEqual(redgifsCandidatesFromText("https://www.redgifs.com/share/test123"), ["test123"]);
  // Dashed slug → tries the last segment, then the de-hyphenated whole.
  assert.deepEqual(redgifsCandidatesFromText("https://www.redgifs.com/watch/a-b-cee"), ["cee", "abcee"]);
  // A bare id pasted on its own.
  assert.deepEqual(redgifsCandidatesFromText("test123"), ["test123"]);
  // No RedGifs reference and not a bare token-ish string → nothing.
  assert.deepEqual(redgifsCandidatesFromText("https://example.com/x"), []);
});

test("resolves a RedGifs link (Share-button style) to direct video URLs", async () => {
  const env = makeStateEnv();
  env.ALLOW_LOCAL_PREVIEW = "1";
  await seedGif(env, "test123", {
    hd: "https://media.redgifs.com/Test123.mp4",
    sd: "",
    poster: "https://media.redgifs.com/Test123-poster.jpg",
  });
  // A full URL on a non-standard /share/ path must still resolve via candidates.
  const res = await call(env, "http://localhost/api/redgifs?url=" + encodeURIComponent("https://www.redgifs.com/share/test123"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.hd, "https://media.redgifs.com/Test123.mp4");
  assert.equal(body.poster, "https://media.redgifs.com/Test123-poster.jpg");
});

test("a bare id still works (back-compat with ?id=)", async () => {
  const env = makeStateEnv();
  env.ALLOW_LOCAL_PREVIEW = "1";
  await seedGif(env, "test123", { hd: "https://media.redgifs.com/Test123.mp4", sd: "", poster: "" });
  const res = await call(env, "http://localhost/api/redgifs?id=Test123");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).hd, "https://media.redgifs.com/Test123.mp4");
});

test("a request with no resolvable id is a 400", async () => {
  const env = makeStateEnv();
  env.ALLOW_LOCAL_PREVIEW = "1";
  const res = await call(env, "http://localhost/api/redgifs");
  assert.equal(res.status, 400);
});

test("an unauthenticated request is rejected", async () => {
  const env = makeStateEnv(); // no ALLOW_LOCAL_PREVIEW, no session
  const res = await call(env, "http://localhost/api/redgifs?id=test123");
  assert.ok(res.status === 401 || res.status === 403, `expected auth rejection, got ${res.status}`);
});
