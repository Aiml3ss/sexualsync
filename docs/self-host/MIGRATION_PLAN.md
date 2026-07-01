# Self-Host Edition — Migration Plan

> **Edition, not hard fork.** Every phase below adds a runtime adapter beside
> the Cloudflare stack. The Cloudflare path stays the default and stays shipping
> throughout. No phase is allowed to change production behavior unless
> `SELF_HOST_TARGET=node` is explicitly set.

## Guardrails (apply to every phase)

- `SELF_HOST_TARGET` defaults to `cloudflare`; unknown values fall back to it.
- Do not modify the `deploy` script chain, `wrangler.toml`, `_routes.json`,
  `_headers`, KV/R2/Durable Object bindings, or any existing `check:*` gate.
- New adapters are added behind the existing surfaces (`getStore`,
  `mutateKey`/`mutateRecord`, the media binding, the email send seam) so
  handlers never branch on the runtime.
- Each phase ships its own self-host test(s); the Cloudflare unit suite
  (`npm test`) must stay green at every step.

## Phase 0 — Scaffolding (this batch, done)

- `functions/api/_runtime.js`: runtime selector + adapter interface typedefs
  (boundary marker, imported by nothing yet).
- `docs/self-host/*`: README, ARCHITECTURE, MIGRATION_PLAN, CONFIG.
- `.env.selfhost.example`: self-host env template.
- `scripts/selfhost-config-check.mjs` + `npm run selfhost:check`:
  docs/config/runtime-default validation only (not in the deploy chain).
- `tests/unit/runtime-target.test.mjs`: proves the default is `cloudflare` and
  that selecting `node` does not alter existing wiring.

## Phase 1 — Filesystem Node runtime (done, deployable)

A working single-node runtime that runs the **unmodified** Cloudflare handlers:

- `selfhost/server.mjs`: Node HTTP server. File-based router mirroring Pages
  routing, runs `functions/_middleware.js`, serves `dist/`, supplies `env`.
- `selfhost/adapters/kv-fs.mjs`: filesystem `StoreAdapter` bound as `env.STORE`
  (the KV-namespace surface `_kv.js` expects). Default `kv` mode, unchanged.
- `selfhost/adapters/r2-fs.mjs`: filesystem `ObjectStorageAdapter` bound as
  `env.VAULT_MEDIA`.
- `selfhost/lib/ws-room.mjs` + `selfhost/lib/ws-protocol.mjs`: in-process room
  registry bound as `env.ROOMS` plus a zero-dep WebSocket server on the Node
  `upgrade` event — the live room works (presence, fan-out, replay).
- `STATE` intentionally unbound → CAS uses the existing in-process lock (correct
  for one process).
- `Dockerfile` + `docker-compose.yml`: container build + persistent volume.
- `selfhost/test/realtime.test.mjs` (`npm run selfhost:test`): WS codec +
  registry unit tests. `selfhost/smoke.mjs` (`npm run selfhost:smoke`): boots
  the server and drives the real handlers, FS KV + R2 adapters, and a live
  WebSocket end-to-end. `selfhost/smoke2.mjs` (`npm run selfhost:smoke2`): a
  two-identity journey — two real minted sessions drive the Sex Quiz + Green
  Lights double-blind flow over real HTTP, plus a cross-actor realtime fan-out.
- Scripts: `selfhost:build`, `selfhost:serve`, `selfhost:test`, `selfhost:smoke`,
  `selfhost:smoke2`.

This is enough to deploy and use the product (HTTP API + full web UI). The
items below are scale-ups and the realtime enhancement.

## Build checklist

Status legend: **Not started** · **In progress** · **Done**.
(No code is gated on these yet; this is the planned order of work.)

| # | Deliverable | Replaces (Cloudflare) | Behind interface | Status |
| --- | --- | --- | --- | --- |
| 1 | **Postgres/SQLite `STORE` adapter** | KV `STORE` | `StoreAdapter` (`_kv.js` `getStore`) | Filesystem adapter **done**; Postgres/SQLite (multi-process/scale) not started |
| 2 | **S3/MinIO `VAULT_MEDIA` adapter** | R2 `VAULT_MEDIA` | `ObjectStorageAdapter` | Filesystem adapter **done**; S3/MinIO not started |
| 3 | **Node WebSocket room service** | `ROOMS` Durable Object | `RealtimeStateAdapter.broadcast` | **Done** in-process (single-process); shared multi-process backplane not started |
| 4 | **Postgres advisory-lock `STATE` replacement** | `STATE` Durable Object CAS | `mutateKey`/`mutateRecord` (`_state.js`) | Not started (in-process lock works for single process) |
| 5 | **SMTP email option** | Resend HTTP API | `_email.js` send seam | Resend works on Node today; SMTP transport not started |
| 6 | **Docker Compose stack** | Cloudflare-managed infra | Node app + persistent volume | **Done** (filesystem build); +Postgres/MinIO/room services later |
| 7 | **License decision** | Source-Available License v1.0 | n/a (legal) | **Done** — relicensed to PolyForm Noncommercial 1.0.0 (noncommercial self-hosting permitted; commercial/hosted service reserved) |

### Notes per item

1. **Store adapter.** A filesystem `StoreAdapter` shipped in Phase 1
   (`selfhost/adapters/kv-fs.mjs`, bound as `env.STORE`); single-node is covered.
   For multi-process / larger scale, reuse the Supabase `app_data` shape (`store_name`,
   `record_key`, `value_type`, `value_json`/`value_text`, `expires_at`) already
   in `supabase/schema.sql`. Implement `get/setJSON/set/put/delete/list` with
   the same cursor-pagination contract as the KV adapter. At-rest JSON
   encryption (`_encrypted_store.js`) is backend-agnostic and stays on.
2. **Object storage adapter.** A filesystem `ObjectStorageAdapter` shipped in
   Phase 1 (`selfhost/adapters/r2-fs.mjs`, bound as `env.VAULT_MEDIA`). Vault
   media is E2EE ciphertext; the adapter only streams opaque bytes by key. The
   S3 variant (so AWS S3 and MinIO work) is the remaining scale item; preserve
   `no-store` and workspace authorization in `vault-media.js`.
3. **Room service.** Done in-process: `selfhost/lib/ws-room.mjs` ports the
   bounded event spine + reconnect replay (`EVENT_RETENTION_LIMIT`, replay after
   `lastEventSeq`, keep-first dedupe) and `selfhost/lib/ws-protocol.mjs` is a
   zero-dep RFC 6455 WebSocket server on the Node `upgrade` event. Remaining: a
   shared backplane (e.g. Redis pub/sub or Postgres LISTEN/NOTIFY) so multiple
   app processes can fan out to each other's sockets.
4. **State CAS.** Replace the Durable Object compare-and-set with a Postgres
   advisory lock providing the same cross-process atomicity that
   `blockConcurrencyWhile` gives today. `_state.js` already has the local-lock
   fallback path to model behavior against.
5. **Email.** Add an SMTP transport alongside Resend; select by env. Keep the
   generic display name / lock-screen-safe copy constraints.
6. **Docker Compose.** Shipped in Phase 1: `Dockerfile` (multi-stage: build the
   web UI, then a slim Node runtime) + `docker-compose.yml` (single service +
   persistent `/data` volume). Postgres/MinIO/room-service containers get added
   as items 1–4 land.
7. **License.** Done: relicensed from the Source-Available License v1.0 to the
   **PolyForm Noncommercial License 1.0.0** (`/LICENSE`). Noncommercial and
   personal self-hosting are permitted; commercial/hosted-service use and the
   Sexualsync brand remain reserved to the copyright holder. Commercial license
   inquiries go to the copyright holder through the project's source repository.

## Definition of done (per adapter)

- Implements the documented interface with parity tests against the Cloudflare
  behavior.
- Selected only when `SELF_HOST_TARGET=node` (plus its own backend env).
- Cloudflare default path verified unchanged by the existing unit suite.
