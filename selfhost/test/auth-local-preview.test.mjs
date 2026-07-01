import assert from "node:assert/strict";
import { test } from "node:test";
import { getAuthenticatedIdentity } from "../../functions/api/_auth.js";

const env = { ALLOW_LOCAL_PREVIEW: "1" };

test("local preview accepts localhost requests when no canonical client IP is present", async () => {
  const identity = await getAuthenticatedIdentity({
    env,
    request: new Request("http://localhost/api/profile")
  });

  assert.equal(identity.ok, true);
  assert.equal(identity.email, "local-preview@example.test");
});

test("local preview accepts loopback canonical client IPs", async () => {
  const identity = await getAuthenticatedIdentity({
    env,
    request: new Request("http://localhost/api/profile", {
      headers: { "cf-connecting-ip": "127.0.0.1" }
    })
  });

  assert.equal(identity.ok, true);
  assert.equal(identity.email, "local-preview@example.test");
});

test("local preview rejects forged Host: localhost from a non-loopback client IP", async () => {
  const identity = await getAuthenticatedIdentity({
    env,
    request: new Request("http://localhost/api/profile", {
      headers: { "cf-connecting-ip": "203.0.113.9" }
    })
  });

  assert.equal(identity.ok, false);
  assert.equal(identity.response.status, 401);
});
