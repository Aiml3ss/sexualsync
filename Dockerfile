# Sexualsync self-host edition (Node runtime).
#
# This image runs the SAME product code that runs on Cloudflare — the Pages
# Functions in functions/**, behind the Node server in selfhost/, with the web
# UI built into dist/. It does not affect the Cloudflare deploy in any way.
#
#   docker build -t sexualsync-selfhost .
#   docker run -p 8788:8788 --env-file .env.selfhost -v sexualsync-data:/data sexualsync-selfhost
#
# See docs/self-host/ and selfhost/README.md for configuration.

# syntax=docker/dockerfile:1

# ---- build stage: build the web UI and assemble dist/ -----------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund \
 && npm --prefix web ci --no-audit --no-fund \
 && npm run selfhost:build
# Output: /app/dist  (static web build + code-transparency manifest)

# ---- runtime stage: just Node + the app, no build toolchain -----------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only (no wrangler / playwright). In the default
# filesystem-store mode the Supabase SDK is never imported, but it stays
# available so DATA_BACKEND can be switched on later without a rebuild.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# The app code the Node server needs at runtime.
COPY --from=build /app/functions ./functions
COPY --from=build /app/selfhost ./selfhost
COPY --from=build /app/dist ./dist
# Cloudflare Pages applies root `_headers` automatically. The Node runtime reads
# the same file from /app/_headers, so keep it in the runtime image too.
COPY --from=build /app/dist/_headers ./_headers
RUN chmod -R a+rX /app/functions /app/selfhost /app/dist /app/_headers

# Persistent data lives outside the image: filesystem KV + Vault media.
ENV SELFHOST_DATA_DIR=/data \
    SELFHOST_DIST_DIR=/app/dist \
    PORT=8788

# Self-host security default: mint NEW rooms at the stronger PBKDF2 v2 (600k)
# even when the operator hand-rolls a minimal env without copying
# .env.selfhost.example. A value in --env-file / compose env_file still
# overrides this (set ROOM_E2EE_KDF_VERSION=v1 to opt back to 310k). Existing
# rooms are unaffected — each freezes its KDF version in its verifier.
ENV ROOM_E2EE_KDF_VERSION=v2
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
EXPOSE 8788

# Liveness only (the cheap /api/health). Not ?probe=1, which actively probes
# KV / R2 / the (in-process) realtime room and 503s if any are unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "selfhost/server.mjs"]
