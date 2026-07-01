import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeRequestToWeb } from "../lib/http-bridge.mjs";

function req({ headers = {}, remoteAddress = "10.0.0.5", url = "/api/config", method = "GET" } = {}) {
  return {
    method,
    url,
    headers: { host: "internal.example", ...headers },
    socket: { remoteAddress }
  };
}

test("direct self-host requests ignore spoofed client IP headers", () => {
  const request = nodeRequestToWeb(req({
    headers: {
      "cf-connecting-ip": "203.0.113.99",
      "x-forwarded-for": "198.51.100.77"
    },
    remoteAddress: "10.1.2.3"
  }));

  assert.equal(new URL(request.url).origin, "http://internal.example");
  assert.equal(request.headers.get("cf-connecting-ip"), "10.1.2.3");
  assert.equal(request.headers.get("x-forwarded-for"), null);
});

test("trusted proxy mode maps forwarded address into the canonical rate-limit header", () => {
  const request = nodeRequestToWeb(req({
    headers: {
      "x-forwarded-for": "198.51.100.10, 10.0.0.20",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "app.example.test"
    },
    remoteAddress: "10.0.0.20",
    url: "/signin?returnTo=%2Fspace"
  }), { trustProxy: true });

  const url = new URL(request.url);
  assert.equal(url.origin, "https://app.example.test");
  assert.equal(url.pathname, "/signin");
  assert.equal(request.headers.get("cf-connecting-ip"), "198.51.100.10");
});

test("an allowlisted X-Forwarded-Host is honored (correctly-configured proxy)", () => {
  const request = nodeRequestToWeb(req({
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "app.example.test" }
  }), { trustProxy: true, allowedHosts: new Set(["app.example.test"]) });

  assert.equal(new URL(request.url).origin, "https://app.example.test");
});

test("a spoofed X-Forwarded-Host is ignored when an allowlist is configured", () => {
  const request = nodeRequestToWeb(req({
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "evil.attacker.example",
      host: "app.example.test"
    }
  }), { trustProxy: true, allowedHosts: new Set(["app.example.test"]) });

  // Falls back to the direct Host, never the attacker-supplied forwarded host.
  assert.equal(new URL(request.url).origin, "https://app.example.test");
});

test("allowlist matching is case-insensitive", () => {
  const request = nodeRequestToWeb(req({
    headers: { "x-forwarded-proto": "https", "x-forwarded-host": "App.Example.Test" }
  }), { trustProxy: true, allowedHosts: new Set(["app.example.test"]) });

  assert.equal(new URL(request.url).origin, "https://app.example.test");
});
