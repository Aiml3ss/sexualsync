# Self-Host Edition - Configuration

> The Cloudflare column is the live production configuration and remains the
> default. The self-host **Node runtime is implemented and runnable today**
> (Phase 1: filesystem storage, in-process realtime room, Docker) - see the
> "implemented now" section below and `selfhost/README.md`. Only the
> **scale-out** variables (`DATABASE_URL`, `S3_*`, `SMTP_*`, and the
> multi-process `ROOM_WS_*`/`STATE_ADVISORY_LOCK`) are placeholders for adapters
> that are not wired yet; setting those has no effect (see `MIGRATION_PLAN.md`).

## The one selector

| Variable | Values | Default | Effect |
| --- | --- | --- | --- |
| `SELF_HOST_TARGET` | `cloudflare`, `node` | `cloudflare` | Deployment runtime. Missing or unknown values resolve to `cloudflare`. Read via `functions/api/_runtime.js`. |

## Shared variables (both runtimes)

These are product-level, not Cloudflare-specific, and apply to either runtime.
See `/.env.example` for the authoritative Cloudflare-focused list.

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | First-party Google OAuth. |
| `SELF_HOST_TARGET=node` | Enables the Node self-host runtime, including built-in local email/password accounts. |
| `APP_SESSION_SECRET` | Signs the app-session cookie; also keys at-rest JSON encryption when no `DATA_ENCRYPTION_KEY_V*` is set. On self-host it is auto-generated + persisted when unset (see below). |
| `AUTH_BASE_URL` | Canonical origin for OAuth redirect URIs. Becomes operator-set on self-host. Also the default trusted origin for absolute links in transactional email (see `PUBLIC_BASE_URL`). Under `TRUST_PROXY`, it seeds the `X-Forwarded-Host` allowlist so a spoofed proxy header can't redirect emailed links or cookies. |
| `PUBLIC_BASE_URL` | Optional. Canonical public origin for absolute links in outbound transactional email. Hardens those links against Host / `X-Forwarded-Host` injection. Precedence: `PUBLIC_BASE_URL`, then `AUTH_BASE_URL`, then request origin. Read by `functions/api/_origin.js`. |
| `PRIVATE_PREVIEW_ALLOWED_EMAILS` | Comma/space/semicolon-separated allow-list of emails that may create a session while the instance is private (the default). Read by `functions/api/auth/_private_preview.js` (alias `SEXUALSYNC_ALLOWED_EMAILS`). For a couple instance, set both partners' real emails. Placeholder example addresses are ignored by local-password auth. |
| `PUBLIC_SIGNUPS_OPEN` | Leave **unset** to keep the instance private (the allow-list is enforced). Set to `1`/`true` only to drop the allow-list and accept open sign-ups. Read by `_private_preview.js`. |
| `SEXUALSYNC_ADMIN_EMAIL` | Owner email for the admin dashboard (`functions/api/admin/dashboard.js`); also auto-added to the private-preview allow-list. |
| `LEGACY_MEMBERS_JSON` | Seeds the shared couple workspace on first sign-in. JSON array of `{"email","displayName"}`; preferred form. Read by `functions/api/_workspaces.js`. |
| `LEGACY_MEMBER_EMAILS` / `LEGACY_MEMBER_NAMES` | CSV alternative to `LEGACY_MEMBERS_JSON` (parallel email/name lists). Read by `functions/api/_workspaces.js`. |
| `DATA_ENCRYPTION_KEY_V1` | At-rest JSON encryption key (falls back to `APP_SESSION_SECRET`). Backend-agnostic. |
| `ALLOW_PLAINTEXT_AT_REST` | Secure-by-default: sensitive stores refuse to write plaintext when no key resolves. Leave unset. Set `1` only if you deliberately run keyless because you encrypt at the disk/DB layer. Read by `functions/api/_encrypted_store.js`. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push. Generate the key pair with `npx web-push generate-vapid-keys`. |
| `LLM_ENABLED` | Master AI toggle, **off** by default. Must be set (`1`/`true`) to enable AI helpers, and only takes effect alongside `LLM_BASE_URL` + `LLM_API_KEY`. Read by `functions/api/_llm.js`. |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | Optional AI helper endpoint, credential, and model. Inert unless `LLM_ENABLED` is on. |
| `SENTRY_DSN_PUBLIC` | Optional diagnostics. |
| `APP_VERSION` | Version label surfaced via `/api/config` and `/api/health`. |

## Cloudflare runtime (default, in use today)

| Binding / Variable | Set where | Role |
| --- | --- | --- |
| `STORE` (KV) | `wrangler.toml` | Durable key/value store. |
| `VAULT_MEDIA` (R2) | `wrangler.toml` | Encrypted Vault media. |
| `ROOMS`, `STATE` (Durable Objects) | `wrangler.toml` | Realtime room + atomic state. |
| `DATA_BACKEND` | secret/env | `kv` (default), `dual`, or `supabase` for durable stores. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` / `SUPABASE_ANON_KEY` | secrets | Used when `DATA_BACKEND` is not `kv`. |
| `RESEND_API_KEY` / `RESEND_FROM` / `RESEND_REPLY_TO` | secrets | Transactional email. |
| `CODE_TRANSPARENCY_*` | secrets | Signed build transparency manifest. |

## Self-host (Node) runtime - implemented now (Phase 1)

Read by `selfhost/server.mjs`. The filesystem store/media adapters need no
external services.

| Variable | Default | Role |
| --- | --- | --- |
| `PORT` | `8788` | HTTP listen port. |
| `HOST` | `0.0.0.0` | Listen address. |
| `SELFHOST_DATA_DIR` | `./selfhost-data` | Root for filesystem KV (`<dir>/kv`) + Vault media (`<dir>/media`). |
| `SELFHOST_MEDIA_DIR` | `<data>/media` | Override the media directory. |
| `SELFHOST_DIST_DIR` | `<repo>/dist` | Built web UI to serve. |
| `TRUST_PROXY` | `false` | Honor `X-Forwarded-Proto/Host` behind a TLS reverse proxy. |
| `SELF_HOST_TARGET` | `node` | Set automatically by the server. |

The shared product vars above (`APP_SESSION_SECRET`, `GOOGLE_*`, `RESEND_*`,
`VAPID_*`, and `DATA_ENCRYPTION_KEY_V1`) apply unchanged. Built-in local
email/password auth works on Node with no external provider. Email-code auth
works on Node via `RESEND_API_KEY` today.

**Secret bootstrap (zero-config security).** If `APP_SESSION_SECRET` is unset, the
Node server generates a strong 256-bit secret on first boot and persists it to
`<data dir>/session-secret` (mode `0600`), so sessions and at-rest JSON encryption
work with no manual setup. Precedence: an env value always wins, then the
persisted file, then a newly generated secret. The Docker image also defaults
`ROOM_E2EE_KDF_VERSION=v2` (600k). Keep the `session-secret` file backed up and
stable: it decrypts at-rest data (rows are tagged with key id `app-session-v1`),
so deleting it or changing the secret after data exists strands that data.

**Backup / restore.** Back up the entire `SELFHOST_DATA_DIR` - it holds the KV
store (`<dir>/kv`), Vault media (`<dir>/media`), **and** the `session-secret`
file. Restore them together. Do not rotate `APP_SESSION_SECRET` / regenerate
`session-secret` (or set `DATA_ENCRYPTION_KEY_V1` after the fact) once data
exists, or the at-rest data becomes unreadable.

**Realtime** needs no configuration: the live room runs in-process (WebSocket
upgrades on `/api/room/socket` + an in-process `env.ROOMS` registry). It is
single-process. The `ROOM_WS_*` vars below are only for a future multi-process
backplane.

## Self-host scale backends - planned placeholders

Not yet wired (the filesystem adapters cover single-node). Names are proposals
so `.env.selfhost.example` and the adapters can target a stable shape.

| Variable | Adapter | Role (planned) |
| --- | --- | --- |
| `DATABASE_URL` | `StoreAdapter` | Postgres connection string for the `app_data`-style store. |
| `SQLITE_PATH` | `StoreAdapter` | Alternative single-node SQLite file (instead of `DATABASE_URL`). |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | `ObjectStorageAdapter` | S3/MinIO Vault media. |
| `ROOM_WS_URL` / `ROOM_WS_TOKEN` | `RealtimeStateAdapter` | External realtime backplane for multi-process fan-out (single-process realtime is already in-process, no config). |
| `STATE_ADVISORY_LOCK` | `RealtimeStateAdapter` | Toggle Postgres advisory-lock CAS (vs. the in-process lock used today). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | email seam | SMTP transport (alternative to Resend). |

## Validation

`npm run selfhost:check` validates that the self-host docs and
`.env.selfhost.example` are present and coherent and that the runtime default
is still `cloudflare`. It performs **no** deployment actions and is **not** part
of the `deploy` chain.
