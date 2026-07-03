import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */

// In production, the Next app and the Cloudflare Pages Functions live at the
// same origin (sexualsync.io). `/api/*` is served by `functions/api/*.js`.
//
// In local dev (`npm run dev`), Next runs at http://localhost:3000 and the
// API doesn't exist locally — so we proxy `/api/*` to the deployed Pages
// origin. Auth in dev: the deployed origin is behind Cloudflare Access, so
// these requests will return 302 to a Google login unless the developer
// already has a `CF_Authorization` cookie for sexualsync.io. The simplest
// path: sign in at https://sexualsync.io once in your browser, then `next
// dev` will surface 302s in the network tab — for real API testing, set
// `API_PROXY_TARGET=http://localhost:8788` (wrangler dev) instead.
//
// Override with API_PROXY_TARGET env var for testing against wrangler dev or
// a preview deploy.

const API_PROXY_TARGET = process.env.API_PROXY_TARGET || "https://sexualsync.io";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  turbopack: {
    root: __dirname,
  },
  // We only run `rewrites` in dev. In prod (CF Pages), `/api/*` is served by
  // the Pages Functions sitting next to this app.
  async rewrites() {
    if (process.env.NODE_ENV === "production") return [];
    return [
      {
        source: "/api/:path*",
        destination: `${API_PROXY_TARGET}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
