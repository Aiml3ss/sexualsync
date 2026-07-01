# Self-Host Edition — Architecture

> **Edition, not hard fork.** The diagram below is the *same* product code with
> the Cloudflare-specific pieces isolated behind adapter boundaries. The
> Cloudflare column is what runs in production today and remains the default.

## Runtime selector

`functions/api/_runtime.js` exposes the deployment-level selector:

```js
import { runtimeTarget, isCloudflareRuntime, isSelfHostNodeRuntime } from "./_runtime.js";

runtimeTarget(env);          // "cloudflare" (default) | "node"
isCloudflareRuntime(env);    // true unless SELF_HOST_TARGET=node
isSelfHostNodeRuntime(env);  // true only when SELF_HOST_TARGET=node
```

- Default: `cloudflare`. Missing/empty/unrecognized → `cloudflare`.
- `node` is the only other recognized value and must be set explicitly.
- **This module is a boundary marker, not a switch.** The self-host edition
  imports `runtimeTarget` (`selfhost/lib/env-bindings.mjs`) to report the
  selected runtime in `/api/health` and the startup log; product handlers branch
  through the adapter seams, not this marker.

## Stack mapping

The self-host **Node runtime is shipped (Phase 1)**: the right-hand column lists
the eventual *scale-out* adapter targets, but single-node equivalents already
run today — filesystem storage for the store + Vault media, and an in-process
realtime room — so no external service is required. See "What is implemented
now (Phase 1)" below.

| Concern | Cloudflare (production, default) | Self-host Node edition (adapter target) | Boundary today |
| --- | --- | --- | --- |
| Web UI | Next static build in `web/`, served by Pages | Same static build, served by Node/static host | Build output is runtime-agnostic |
| API handlers | Pages Functions `functions/api/*` — `onRequest(context)` | Same handlers behind a Node HTTP shim that supplies `context`/`env` | `onRequest(context)` signature |
| Middleware | `functions/_middleware.js` using `context.next()` | Node middleware that calls the next handler with the same contract | `context.next()` |
| Durable store | KV `STORE` (or Supabase via `DATA_BACKEND`) | Postgres / SQLite | `getStore(env, name)` in `_kv.js` → `StoreAdapter` |
| Object storage (Vault media) | R2 `VAULT_MEDIA` | S3-compatible (AWS S3 / MinIO) | `VAULT_MEDIA` binding → `ObjectStorageAdapter` |
| Realtime room | `ROOMS` Durable Object (`workers/room`) | Node WebSocket service | `/api/room` proxy → `RealtimeStateAdapter.broadcast` |
| Atomic state (CAS) | `STATE` Durable Object | Postgres advisory lock | `mutateKey` / `mutateRecord` in `_state.js` |
| Email | Resend HTTP API | SMTP (or keep Resend) | `_email.js` send seam |
| Auth | First-party Google OAuth + app-session cookie | Same; OAuth redirect URIs become operator-configured | `AUTH_BASE_URL` + OAuth client env |

## The three core adapter interfaces

Documented as JSDoc typedefs in `functions/api/_runtime.js`. Each mirrors a
surface the Cloudflare code already uses, so the Node implementations are
"fill in the same shape," not a redesign.

### 1. `StoreAdapter` — key/value + JSON documents
- Canonical impl: `functions/api/_kv.js` `getStore(env, name)`.
- Surface: `get`, `setJSON`, `set`, `put`, `delete`, `list` (cursor-paginated).
- Already abstracts KV vs. Supabase `app_data`. The Node edition adds a
  Postgres/SQLite implementation of the same `app_data`-style table. No caller
  changes.

### 2. `ObjectStorageAdapter` — encrypted Vault media
- Canonical impl: the `VAULT_MEDIA` R2 binding in `functions/api/_vault.js` and
  `functions/api/vault-media.js`.
- Surface: `get`, `put`, `delete` on opaque keys (`vault/<ws>/<item>/<name>`).
- Media is already client-side encrypted (E2EE) before upload, so the adapter
  only moves ciphertext bytes. S3/MinIO satisfies the same contract.

### 3. `RealtimeStateAdapter` — realtime fan-out + atomic state
- Canonical impl: `ROOMS` + `STATE` Durable Objects in
  `workers/room/src/index.js`, fronted by `functions/api/_state.js`.
- Two responsibilities:
  - **Broadcast** room events to connected partners (bounded event spine for
    reconnect replay).
  - **Compare-and-set** for contended records (`mutateKey`/`mutateRecord`).
- `_state.js` already falls back to an in-process lock when `STATE` is unbound;
  the Node edition replaces that with a Postgres advisory lock for
  cross-process atomicity, behind the same `mutateKey`/`mutateRecord` API.

## Why this avoids a fork

1. **Product logic never branches on the runtime.** Handlers call
   `getStore` / `mutateKey` / the media binding — not Cloudflare APIs directly.
2. **The seams already exist** for storage (`DATA_BACKEND`) and state
   (`STATE`-absent fallback). The edition widens them; it doesn't duplicate
   them.
3. **One selector, default-safe.** `SELF_HOST_TARGET` picks the adapter family;
   absent/unknown means Cloudflare.

## What is implemented now (Phase 1)

A runnable Node runtime in `selfhost/` that runs the unmodified handlers:

- `selfhost/server.mjs` — Node HTTP server: file-based router mirroring Pages
  routing, runs `functions/_middleware.js`, serves `dist/`, builds `env`.
- `selfhost/adapters/kv-fs.mjs` — `StoreAdapter` over the filesystem (`env.STORE`).
- `selfhost/adapters/r2-fs.mjs` — `ObjectStorageAdapter` over the filesystem
  (`env.VAULT_MEDIA`).
- `selfhost/lib/ws-room.mjs` + `selfhost/lib/ws-protocol.mjs` —
  `RealtimeStateAdapter`: an in-process room registry bound as `env.ROOMS`
  (HTTP broadcasts) plus a zero-dependency WebSocket server wired to the Node
  `upgrade` event for `/api/room/socket`. Presence, live event fan-out, bounded
  event spine, and reconnect replay all match the Durable Object. `STATE`
  remains unbound → in-process CAS lock (correct for one process).
- `Dockerfile` + `docker-compose.yml`. `selfhost/test/realtime.test.mjs` unit-
  tests the WS codec + registry; `selfhost/smoke.mjs` boots the server and
  drives the real handlers, adapters, **and a live WebSocket** end-to-end;
  `selfhost/smoke2.mjs` adds a **two-identity** journey (two real minted
  sessions, no local-preview) — the Sex Quiz + Green Lights double-blind flow
  across real HTTP plus a cross-actor realtime broadcast.

**Single-process topology.** The realtime registry and the state CAS lock are
in-process, so run one instance today. See `MIGRATION_PLAN.md` for the scale-ups
(Postgres/SQLite store, S3/MinIO media, Postgres advisory-lock CAS, shared
realtime backplane) and `selfhost/README.md` for the operator runbook.
