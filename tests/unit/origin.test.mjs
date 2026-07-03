import { test } from "node:test";
import assert from "node:assert/strict";
import { trustedOrigin } from "../../functions/api/_origin.js";

function req(url) {
  return { url };
}

test("prefers PUBLIC_BASE_URL over AUTH_BASE_URL and the request origin", () => {
  const origin = trustedOrigin(
    { PUBLIC_BASE_URL: "https://app.sexualsync.io", AUTH_BASE_URL: "https://auth.example" },
    req("https://request-host.example/api/invite")
  );
  assert.equal(origin, "https://app.sexualsync.io");
});

test("falls back to AUTH_BASE_URL when PUBLIC_BASE_URL is unset", () => {
  const origin = trustedOrigin(
    { AUTH_BASE_URL: "https://sexualsync.io" },
    req("https://request-host.example/api/invite")
  );
  assert.equal(origin, "https://sexualsync.io");
});

test("falls back to the request origin when nothing is configured", () => {
  const origin = trustedOrigin({}, req("https://preview.example:8788/api/invite"));
  assert.equal(origin, "https://preview.example:8788");
});

test("a spoofed request Host can never override a configured origin", () => {
  // The core hardening: even if new URL(request.url).host is attacker-controlled
  // (Host / X-Forwarded-Host injection), a configured base URL wins.
  const origin = trustedOrigin(
    { AUTH_BASE_URL: "https://sexualsync.io" },
    req("https://evil.attacker.example/api/review-token")
  );
  assert.equal(origin, "https://sexualsync.io");
});

test("strips a trailing slash from the configured base URL", () => {
  assert.equal(
    trustedOrigin({ PUBLIC_BASE_URL: "https://sexualsync.io/" }, req("https://x/")),
    "https://sexualsync.io"
  );
});

test("preserves a configured path prefix", () => {
  assert.equal(
    trustedOrigin({ PUBLIC_BASE_URL: "https://host.example/app/" }, req("https://x/")),
    "https://host.example/app"
  );
});

test("ignores a malformed configured value and falls through", () => {
  assert.equal(
    trustedOrigin({ PUBLIC_BASE_URL: "not a url", AUTH_BASE_URL: "https://sexualsync.io" }, req("https://x/")),
    "https://sexualsync.io"
  );
});

test("rejects a non-http(s) configured scheme", () => {
  assert.equal(
    trustedOrigin({ PUBLIC_BASE_URL: "javascript:alert(1)" }, req("https://fallback.example/")),
    "https://fallback.example"
  );
});

test("returns empty string when neither config nor request resolves", () => {
  assert.equal(trustedOrigin({}, req("::::not-a-url")), "");
});
