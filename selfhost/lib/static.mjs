// Serves the static web build (the `dist/` directory produced by
// `npm run build`) the way Cloudflare Pages serves assets: try the exact path,
// then `<path>.html`, then `<path>/index.html`, with `/` -> index.html.
//
// The Pages middleware still post-processes HTML responses (CSP nonce
// injection), so this only locates and streams the bytes.

import { promises as fs, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".rsc": "text/x-component",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8"
};

export function createStaticServer(distDir) {
  const root = path.resolve(distDir);

  async function resolveFile(pathname) {
    const rel = decodeURIComponent(pathname.replace(/^\/+/, ""));
    const candidates = rel === "" ? ["index.html"] : [rel, `${rel}.html`, path.join(rel, "index.html")];
    for (const candidate of candidates) {
      const abs = path.resolve(root, candidate);
      if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) continue; // traversal guard
      try {
        const stat = await fs.stat(abs);
        if (stat.isFile()) return { abs, size: stat.size };
      } catch { /* try next candidate */ }
    }
    return null;
  }

  return {
    async serve(pathname) {
      const found = await resolveFile(pathname);
      if (!found) return null;
      const ext = path.extname(found.abs).toLowerCase();
      const headers = new Headers({
        "content-type": CONTENT_TYPES[ext] || "application/octet-stream",
        "content-length": String(found.size)
      });
      return new Response(Readable.toWeb(createReadStream(found.abs)), { status: 200, headers });
    }
  };
}
