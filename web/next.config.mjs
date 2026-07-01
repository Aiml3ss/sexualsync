import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */

// In a self-host deployment the Next app and the API handlers are served from
// the same origin by the Node server (`selfhost/server.mjs`); `/api/*` is
// handled there and no rewrite is needed.
//
// In local UI dev (`npm run dev` inside web/), Next runs at
// http://localhost:3000 and does not serve the API — so we proxy `/api/*` to a
// locally running self-host server. Start that server (`npm run selfhost:serve`,
// default port 8788) in another terminal, then the proxied API calls resolve.
//
// Override the target with the API_PROXY_TARGET env var to point at a different
// host or port.

const API_PROXY_TARGET = process.env.API_PROXY_TARGET || "http://localhost:8788";
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
