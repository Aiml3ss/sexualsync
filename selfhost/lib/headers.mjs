// Applies the project's Cloudflare Pages `_headers` rules on the self-host Node
// runtime. Cloudflare attaches these (security headers + per-path cache
// control) automatically; Node does not, so without this a self-host deploy
// would ship without Referrer-Policy / X-Content-Type-Options /
// Permissions-Policy / HSTS / COOP / the static CSP fallback.
//
// Merge rule: headers are only ADDED when the response does not already carry
// them. That keeps the middleware's per-request CSP-nonce header (set on HTML
// navigations) authoritative, while the static `_headers` CSP still covers
// assets and API responses — exactly mirroring Cloudflare's precedence.

import { promises as fs } from "node:fs";

function parseHeadersFile(text) {
  const blocks = [];
  let current = null;
  for (const rawLine of text.split("\n")) {
    if (!rawLine.trim()) { continue; }
    if (!/^\s/.test(rawLine)) {
      current = { pattern: rawLine.trim(), headers: [] };
      blocks.push(current);
    } else if (current) {
      const idx = rawLine.indexOf(":");
      if (idx > 0) current.headers.push([rawLine.slice(0, idx).trim(), rawLine.slice(idx + 1).trim()]);
    }
  }
  return blocks;
}

function matches(pattern, pathname) {
  if (pattern === "/*") return true;
  if (pattern.endsWith("*")) return pathname.startsWith(pattern.slice(0, -1));
  return pathname === pattern;
}

export async function loadHeaderRules(headersFilePath) {
  let text = "";
  try { text = await fs.readFile(headersFilePath, "utf8"); } catch { return { apply: (response) => response, count: 0 }; }
  const blocks = parseHeadersFile(text);
  return {
    count: blocks.length,
    apply(response, pathname) {
      const merged = new Map();
      for (const block of blocks) {
        if (!matches(block.pattern, pathname)) continue;
        for (const [key, value] of block.headers) merged.set(key, value);
      }
      if (merged.size === 0) return response;
      const headers = new Headers(response.headers);
      let changed = false;
      for (const [key, value] of merged) {
        if (!headers.has(key)) { headers.set(key, value); changed = true; }
      }
      if (!changed) return response;
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
  };
}
