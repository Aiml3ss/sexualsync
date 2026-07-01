<p align="center">
  <img src="docs/assets/readme-wave.svg?v=get-curious" alt="Sexualsync wave logo" width="820">
</p>

<h1 align="center">Sexualsync</h1>

<p align="center">
  <strong>A self-hosted private room for two consenting adults.</strong><br>
  Share asks, limits, fantasies, notes, messages, and encrypted media without joining a hosted service.<br>
  <a href="#run-it">Run it</a> | <a href="#privacy-and-security">Privacy and security</a> | <a href="#code-map">Code map</a>
</p>

Sexualsync is a couples app for conversations that are easier to write down
than start cold. One room, two people, no public profiles, no discovery feed,
and no hosted account to join.

The self-host edition runs the same product code as the Cloudflare deployment,
but on a Node server with filesystem storage and an in-process realtime room.
It works without external services. Optional Google sign-in, email codes, push,
and AI helpers can be added by setting env vars.

For consenting adults, 18+. Read the license before running anything public:
personal and noncommercial self-hosting is allowed, but commercial or hosted
service use is reserved.

## What it does

- Sexboard: the home screen for active asks, partner activity, overlaps, and
  anything waiting on you.
- Asks: send a concrete request with acts, timing, filming preference, and a
  note. Your partner can accept, counter, pass, park, or answer later.
- Sext: a private two-person message thread. Uploaded images are encrypted in
  the browser before upload.
- Reveals: Sex Quiz, Green Lights, The Pile, and Blind Reveal help both people
  answer privately before matches or answers are shown.
- Inspiration and Shelf: save kinks, fantasies, links, clips, passages, and
  ideas before they become a plan.
- Limits: hard nos, talk-first items, soft limits, and ask blocking when a line
  is crossed.
- Vault: private media encrypted in the browser with a passphrase the server
  never receives.
- Notes, export, deletion, PWA install, generic notifications, and basic admin
  status tools.

## Privacy and security

Sexualsync is built for a private room, not a social network.

- App records in sensitive stores are encrypted at rest with versioned AES-GCM
  envelopes. Self-host generates and persists a strong `APP_SESSION_SECRET` on
  first boot if you do not set one.
- Room Encryption can end-to-end encrypt new asks, limits, kinks, Shelf saves,
  Blind Reveals, custom acts, and Pile drops with a shared passphrase. The
  server never receives that passphrase. Lost passphrases cannot be recovered.
- Vault media and Sext image uploads are encrypted in the browser before upload.
- Sessions use HttpOnly, Secure, SameSite cookies. Protected app routes are
  gated by middleware.
- API responses that expose private state are `no-store`.
- Notifications and outbound email copy stay generic by default.
- No public search, no public room listing, no ad profiles.

Limits are documented too. A compromised unlocked device, malicious browser
extension, screen recording, or compromised server-delivered JavaScript can still
expose future plaintext. Read [docs/e2ee-threat-model.md](docs/e2ee-threat-model.md)
and [docs/crypto-review-packet.md](docs/crypto-review-packet.md) before relying
on Room Encryption for high-risk use.

## Run it

### Docker

```bash
git clone <your-repo-url> sexualsync
cd sexualsync
docker compose up --build
```

Open `http://localhost:8788`.

Docker publishes only `127.0.0.1:8788` by default. Put Caddy, nginx, or Traefik
in front of it for public TLS. The container stores data in the
`sexualsync-data` volume. Back it up, including the generated `session-secret`.

### Node

Requires Node 20 or newer.

```bash
npm ci
npm --prefix web ci
npm run selfhost:build
cp .env.selfhost.example .env.selfhost
npm run selfhost:serve
```

Open `http://localhost:8788`.

For a private two-person room, set both emails in `.env.selfhost`:

```dotenv
PRIVATE_PREVIEW_ALLOWED_EMAILS=you@example.com,partner@example.com
LEGACY_MEMBERS_JSON=[{"email":"you@example.com","displayName":"You"},{"email":"partner@example.com","displayName":"Partner"}]
```

With no real allowlist, local email/password accounts are enabled so a fresh
self-host can be tested immediately. Do not expose an instance publicly until
you set the allowed emails or intentionally set `PUBLIC_SIGNUPS_OPEN=1`.

## Optional services

The app runs without these.

- Google OAuth: set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
  `AUTH_BASE_URL`.
- Email codes and invite email: set `RESEND_API_KEY` and sender vars.
- Web Push: set a matching VAPID public/private key pair.
- AI helpers: set `LLM_ENABLED=1`, `LLM_BASE_URL`, and `LLM_API_KEY`. Intimate
  content features also require `LLM_SENSITIVE_CONTENT_ALLOWED=1`.

Full config: [docs/self-host/CONFIG.md](docs/self-host/CONFIG.md).

## Verify it

```bash
npm test
npm --prefix web test
npm run selfhost:test
npm run selfhost:smoke
npm run selfhost:check
npm run check:security-privacy
npm run check:e2ee
```

Before opening an instance beyond one private couple, read
[docs/self-host/GOING-PUBLIC.md](docs/self-host/GOING-PUBLIC.md). Open signup is
not a single env flip. You need database-backed storage, stronger moderation and
reporting operations, and a legal posture that matches the way you run it.

## Code map

```text
web/             Next.js app, built into dist/
functions/api/   Web-standard API handlers used by both runtimes
functions/       Pages middleware and routing glue
selfhost/        Node server, filesystem KV/R2 adapters, WebSocket room
workers/room/    Cloudflare Durable Object realtime and CAS worker
docs/            self-host, security, crypto, and operations notes
supabase/        optional app_data schema and migration helpers
scripts/         release, privacy, E2EE, migration, and build checks
```

Use `getStore(env, name)`, `mutateKey`, `mutateRecord`, `env.VAULT_MEDIA`, and
`env.ROOMS` from shared handlers. Do not call Cloudflare bindings directly from
product code, because those handlers also run under Node self-host.

## License

Sexualsync is licensed under the
[PolyForm Noncommercial License 1.0.0](LICENSE). Personal and noncommercial
self-hosting, modification, and redistribution are permitted. Commercial or
hosted-service use, and use of the Sexualsync name, logo, wordmark, or brand
assets, are reserved. For a commercial license, contact the copyright holder
through the project's source repository.
