# Sexualsync - Self-Host Runtime (Node)

This directory is the **Node runtime** for the self-host edition. It runs the
exact same product code as the Cloudflare deployment - the Pages Functions in
`functions/**`, the Pages middleware (`functions/_middleware.js`), and the
static web build in `dist/` - on a plain Node HTTP server.

> It does not touch, and is never imported by, the Cloudflare build or
> `npm run deploy`. See `docs/self-host/` for the architecture and the wider
> plan. **License:** PolyForm Noncommercial 1.0.0 - personal/noncommercial
> self-hosting is permitted; commercial/hosted-service use and the Sexualsync
> brand are reserved (`/LICENSE`).

## How it works

The Cloudflare handlers expect an `env` with a few bindings. The Node server
supplies them:

| Binding | Cloudflare | Self-host (here) |
| --- | --- | --- |
| `STORE` (KV) | KV namespace | `adapters/kv-fs.mjs` - filesystem KV |
| `VAULT_MEDIA` (R2) | R2 bucket | `adapters/r2-fs.mjs` - filesystem objects |
| `ROOMS` (Durable Object) | realtime room | in-process WebSocket room registry (`lib/ws-room.mjs` + zero-dep `lib/ws-protocol.mjs`) |
| `STATE` (Durable Object) | atomic CAS | **absent** - in-process lock (correct for one process) |

Everything else (`APP_SESSION_SECRET`, local password auth, Google OAuth,
Resend email, VAPID, etc.)
is a plain env var read from `process.env`. The handlers are unmodified.

WebSocket upgrades to `/api/room/socket` are handled at the Node server's
`upgrade` event, authenticated with the *same* handler code the Cloudflare
proxy uses, then handed to the in-process room registry. HTTP-side broadcasts
(`broadcastRoomEvent`) reach the same registry via `env.ROOMS`, so live updates
fan out to connected partners exactly as on Cloudflare.

## What works

The full product runs: auth (built-in local email/password, Google OAuth, and
email code), request board, fantasy
backlog, boundaries, approved acts, pile, shelf, vault (encrypted media upload +
playback), profile/workspaces, admin dashboard, push, email, **and the live
realtime room** (presence + live event fan-out + reconnect replay).

**Single-process only (today):** the realtime registry and the state CAS lock
live in one process. Run a single instance. Multi-process / horizontal scaling
needs the shared transports tracked in `docs/self-host/MIGRATION_PLAN.md`
(Postgres advisory-lock CAS; a shared realtime backplane).

## Run it (Node, local)

Requires Node 20+ (developed/tested on Node 22+).

```bash
# 0. Install dependencies (root + web). selfhost:build runs the web build, which
#    needs these - skip this on a fresh clone and the build fails.
npm ci && npm --prefix web ci

# 1. Build the web UI into dist/ (same build the Cloudflare app uses)
npm run selfhost:build

# 2. Configure (OPTIONAL) - on first boot the server auto-generates a strong
#    APP_SESSION_SECRET and persists it under the data dir, so sessions + at-rest
#    encryption work with zero config. Local email/password auth works out of
#    the box. Add an env file only to enable Google/Resend or seed the couple's emails:
cp .env.selfhost.example .env.selfhost
#   optionally set GOOGLE_CLIENT_ID/SECRET or RESEND_API_KEY.

# 3. Run (npm run selfhost:serve auto-loads .env.selfhost via Node --env-file-if-exists)
npm run selfhost:serve
```

### Set up your couple's shared room

A fresh self-host instance starts **empty** - it does not import data from the
Cloudflare deployment. A brand-new sign-in creates a profile but no workspace.
To have the shared room exist on first sign-in, set both partners' emails in
`.env.selfhost`. You typically set **both** of these together -
`PRIVATE_PREVIEW_ALLOWED_EMAILS` controls who may sign in, and
`LEGACY_MEMBERS_JSON` is who shares the workspace:

```
# Private by default - leave PUBLIC_SIGNUPS_OPEN unset. Restrict sign-in to your emails:
PRIVATE_PREVIEW_ALLOWED_EMAILS=you@example.com,partner@example.com
LEGACY_MEMBERS_JSON=[{"email":"you@example.com","displayName":"You"},{"email":"partner@example.com","displayName":"Partner"}]
```

This mirrors how the Cloudflare app seeds the known couple. Either partner can
then create a local account or sign in with Google/email code and land directly
in the shared workspace.

**Getting your partner in - no invite email required.** Two ways:

1. **Invite link (simplest).** The first partner signs in, sets the room
   passphrase, and the onboarding *share* step shows a claimable **invite link**
   right in the app (with copy / share buttons). Hand that link to the other
   partner directly - over any channel you like. The first signed-in person who
   opens it (other than the inviter) claims it and joins the workspace. No email
   is sent for a claimable link, so Resend is **not** needed for this path.
2. **Seeded emails.** With both emails set as above, each partner just opens the
   same instance URL and registers a local account (or signs in with
   Google/email code) - they land in the shared workspace without a link.

Open http://localhost:8788.

### Push notifications (optional)

Web Push is **optional** - the app runs fine without it; you just won't get
background notifications. To enable it, generate a VAPID key pair and put both
halves in `.env.selfhost`:

```bash
npx web-push generate-vapid-keys
```

```
VAPID_PUBLIC_KEY=<the printed Public Key>
VAPID_PRIVATE_KEY=<the printed Private Key>
VAPID_SUBJECT=mailto:you@example.com
```

The public and private keys must come from the *same* pair, or subscribing
fails. Restart the server after setting them.

For **developer-only localhost preview without real accounts**, set
`HOST=127.0.0.1` and `ALLOW_LOCAL_PREVIEW=1` - requests from a localhost URL
and loopback client IP get a dev identity. The server refuses local-preview mode
on public listen hosts. **Never use this as real auth.** Most self-host users
should use the built-in local account form instead.

## Run it (Docker)

```bash
docker compose version   # requires Docker Compose v2.24+
docker compose up --build
```

If Docker says `compose` is not a command, install Docker Desktop or the Docker
Compose plugin first. `docker --version` alone is not enough; it only confirms
the Docker CLI/Engine, not Compose.

Zero config: the container boots on `127.0.0.1:8788`, auto-generates a strong
`APP_SESSION_SECRET` on the data volume, encrypts at rest out of the box, and
serves `/api/health`. Local email/password sign-in is enabled immediately.
Configure Google or Resend email auth in `.env.selfhost`
(`cp .env.selfhost.example .env.selfhost`) only if you want those methods too.
The env file is picked up automatically (`required: false`, needs Compose
v2.24+).

The Compose service persists data in the named volume `sexualsync-data`
(mounted at `/data`). The image runs as the non-root `node` user and exposes a
liveness `HEALTHCHECK` on `/api/health`.

## Configuration (env)

The full matrix is in `docs/self-host/CONFIG.md`. Self-host-specific knobs read
by the Node server:

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8788` | Listen port. |
| `HOST` | `0.0.0.0` | Listen address. |
| `SELFHOST_DATA_DIR` | `./selfhost-data` | Root for filesystem KV (`<dir>/kv`) and media (`<dir>/media`). |
| `SELFHOST_MEDIA_DIR` | `<data>/media` | Override the Vault media directory. |
| `SELFHOST_DIST_DIR` | `<repo>/dist` | Built web UI to serve. |
| `TRUST_PROXY` | `false` | When `true`, honor `X-Forwarded-Proto/Host` (set behind a TLS reverse proxy). |
| `SELF_HOST_TARGET` | `node` | Set automatically by the server. |

## Data & backups

All durable state is under `SELFHOST_DATA_DIR`:

- `kv/` - one file per record (the app's key/value + JSON documents).
- `media/` - encrypted Vault clips (ciphertext only; keys never leave the
  client).
- `session-secret` - the auto-generated `APP_SESSION_SECRET` (present unless you
  set one via env). It signs sessions **and** keys at-rest JSON encryption, so
  treat it like a password: include it in backups, keep it private, and don't
  delete or change it once data exists - doing so logs everyone out and makes
  at-rest data unreadable.

Back up that directory to back up the deployment. JSON records are encrypted at
rest out of the box - the auto-generated secret keys them; set
`DATA_ENCRYPTION_KEY_V1` to use a dedicated key instead - same as Cloudflare.

### Restore

To restore from a backup:

1. **Stop the server** (or `docker compose down`).
2. Restore the `SELFHOST_DATA_DIR` backup over the data dir / Docker volume -
   **including the `session-secret` file**. Without that exact secret, the
   restored `kv/` and `media/` ciphertext is unreadable.
3. **Start the server** again.

Secret rotation is **not** supported for existing at-rest data: the
`session-secret` (or `DATA_ENCRYPTION_KEY_V1`, if you set one) that encrypted the
data is the only thing that can decrypt it. Do **not** change or delete it once a
deployment has data - there is no re-encrypt-in-place step on self-host, so a
changed secret strands every encrypted record.

## Upgrading

Pull the new code and rebuild. Your data dir / Docker volume persists across
upgrades - it lives outside the image and code tree - so the room, accounts, and
Vault survive untouched.

**Docker:**

```bash
git pull
docker compose up --build
```

**Node (no Docker):**

```bash
git pull
npm ci && npm --prefix web ci
npm run selfhost:build
npm run selfhost:serve
```

## Production notes

- `TRUST_PROXY` defaults to **false** - the safe default, so a directly-exposed
  server never trusts spoofable `X-Forwarded-*` headers. Put the app behind a
  TLS-terminating reverse proxy (Caddy/nginx/Traefik) and set `TRUST_PROXY=true`
  (in `.env.selfhost`) so it reads the real https origin for `Secure` cookies and
  OAuth redirects.
- Docker Compose publishes `127.0.0.1:8788` by default. Keep it private and put
  a same-host TLS reverse proxy in front for public access.
- Rate limits key off the canonical client IP the Node bridge places in
  `CF-Connecting-IP`. Direct runs use the socket address and ignore spoofed
  forwarding headers; with `TRUST_PROXY=true`, configure the proxy to overwrite
  `X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Host`.
- With `TRUST_PROXY=true`, `X-Forwarded-Host` is only trusted when it matches the
  host of a configured base URL (`AUTH_BASE_URL` / `PUBLIC_BASE_URL`); a
  non-matching value falls back to the direct `Host`. This is defense-in-depth so
  a spoofed forwarded host can't redirect emailed links or `Secure` cookies. Set
  `AUTH_BASE_URL` to your real public origin (you already do for OAuth) so the
  allowlist is populated.
- Set `AUTH_BASE_URL` to your public origin and register that origin's
  `/api/auth/google/callback` in Google OAuth.
- Single-process is the supported topology today (the in-process state lock is
  not shared across processes). Multi-process needs the Postgres advisory-lock
  CAS - see the migration plan.

## Validate

```bash
npm run selfhost:test    # unit tests: WebSocket frame codec + room registry
npm run selfhost:smoke   # boots the server on an ephemeral port and exercises
                         # the real handlers, adapters, and live WebSocket room
                         # end-to-end (no network)
npm run selfhost:smoke2  # two distinct users (real minted sessions, no local-
                         # preview): the Sex Quiz + Green Lights double-blind
                         # journey across real HTTP + a cross-actor realtime
                         # broadcast - proves the "partner sees it" wiring
npm run selfhost:check   # validates self-host docs/config + runtime default
```

The self-host CI workflow (`.github/workflows/selfhost.yml`) runs all four on
every change and additionally **builds the Docker image and boots the
container**, waiting on its `HEALTHCHECK` - so the `Dockerfile` /
`docker-compose.yml` path stays verified, not just the Node scripts.

Reproduce the image check locally:

```bash
docker build -t sexualsync-selfhost .
docker run -d --name ss sexualsync-selfhost
docker inspect -f '{{.State.Health.Status}}' ss   # "healthy" within ~10s
docker rm -f ss
```
