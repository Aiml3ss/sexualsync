<p align="center">
  <img src="docs/assets/readme-wave.svg" alt="Sexualsync" width="820">
</p>

<h1 align="center">Sexualsync</h1>

<p align="center">
  <strong>A self-hosted private room for two.</strong><br>
  Asks, limits, fantasies, notes, messages, and encrypted media, without joining a hosted service.<br>
  <a href="#run-it">Run it</a> · <a href="#privacy-and-security">Privacy</a> · <a href="#code-map">Code map</a>
</p>

Sexualsync is an app for two people who share one private room. It helps with the
conversations that are easier to write down than to start out loud: what you want
to try, where your limits are, what you have been thinking about.

There are no public profiles and nothing to sign up for. You host your own copy.

This is the self-host edition. It runs on a Node server with filesystem storage
and an in-process realtime room, so it works with no external services. You can
add Google sign-in, email codes, web push, and AI helpers later by setting a few
environment variables.

For consenting adults, 18+. Personal and noncommercial self-hosting is allowed;
commercial or hosted-service use is reserved. See the [license](#license).

## What's inside

- **Sexboard** — the home screen: active asks, what your partner has been up to,
  overlaps, and anything waiting on you.
- **Asks** — send a concrete request with acts, timing, and a filming preference.
  Your partner can accept, counter, pass, park it, or answer later.
- **Sext** — a private message thread for two. Images are encrypted in the browser
  before they upload.
- **Reveals** — Sex Quiz, Green Lights, The Pile, and Blind Reveal let both people
  answer privately before anything is shown.
- **Inspiration and Shelf** — save kinks, links, clips, and passages before they
  turn into a plan.
- **Limits** — hard nos, talk-first items, and soft limits, with ask-blocking when
  a line would be crossed.
- **Vault** — private media encrypted in the browser with a passphrase the server
  never sees.
- Notes, data export, account deletion, PWA install, and generic notifications.

## Privacy and security

Sexualsync is built for a private room, not a social network.

- Sensitive records are encrypted at rest with versioned AES-GCM envelopes. On
  first boot the server generates and saves a strong `APP_SESSION_SECRET` if you
  have not set one.
- **Room Encryption** end-to-end encrypts new asks, limits, kinks, Shelf saves,
  Blind Reveals, custom acts, and Pile drops under a shared passphrase. The server
  never receives it, and a lost passphrase cannot be recovered.
- Vault media and Sext images are encrypted in the browser before upload.
- Sessions use HttpOnly, Secure, SameSite cookies. Protected routes are gated by
  middleware, and responses that carry private state are sent `no-store`.
- Notifications and outbound email stay generic by default. No public search, no
  room listing, no ad profiles.

What it cannot protect against: an unlocked device someone else is holding, a
malicious browser extension, screen recording, or server-delivered JavaScript
that has been tampered with can all expose plaintext going forward. Read the
[threat model](docs/e2ee-threat-model.md) and the
[crypto review notes](docs/crypto-review-packet.md) before you rely on Room
Encryption for anything high-risk.

## Run it

### Docker

```bash
git clone https://github.com/Aiml3ss/sexualsync.git
cd sexualsync
docker compose up --build
```

Open http://localhost:8788.

Docker binds only `127.0.0.1:8788` by default. Put Caddy, nginx, or Traefik in
front of it for public TLS. Data lives in the `sexualsync-data` volume; back it
up, including the generated `session-secret`.

### Node

Node 20 or newer.

```bash
npm ci
npm --prefix web ci
npm run selfhost:build
cp .env.selfhost.example .env.selfhost
npm run selfhost:serve
```

Open http://localhost:8788.

For a private two-person room, set both emails in `.env.selfhost`:

```dotenv
PRIVATE_PREVIEW_ALLOWED_EMAILS=you@example.com,partner@example.com
LEGACY_MEMBERS_JSON=[{"email":"you@example.com","displayName":"You"},{"email":"partner@example.com","displayName":"Partner"}]
```

With no allowlist set, local email/password accounts are enabled so you can try a
fresh instance right away. Do not expose an instance publicly until you have set
the allowed emails, or deliberately set `PUBLIC_SIGNUPS_OPEN=1`.

## Optional services

The app runs without any of these.

- **Google OAuth** — `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_BASE_URL`.
- **Email codes and invites** — `RESEND_API_KEY` plus the sender vars.
- **Web Push** — a matching VAPID public/private key pair.
- **AI helpers** — `LLM_ENABLED=1`, `LLM_BASE_URL`, `LLM_API_KEY`. Intimate-content
  features also need `LLM_SENSITIVE_CONTENT_ALLOWED=1`.

Full config reference: [docs/self-host/CONFIG.md](docs/self-host/CONFIG.md).

## Verify it

```bash
npm test                # shared handler and product unit tests
npm run selfhost:test   # Node adapters and server
npm run selfhost:smoke  # boots the server and runs a two-user flow
npm run selfhost:check  # config and Docker sanity
npm run selfhost:build  # production web build
```

Before you open an instance beyond one private couple, read
[docs/self-host/GOING-PUBLIC.md](docs/self-host/GOING-PUBLIC.md). Open signup is
not a single flag. You will need database-backed storage, real moderation and
reporting, and a legal posture that matches how you run it.

## Code map

```text
web/            Next.js app, built into dist/
functions/api/  Web-standard API handlers, the product logic
functions/      Middleware and routing glue
selfhost/       Node server, filesystem storage adapters, WebSocket room
workers/room/   StateStoreDurableObject, the CAS coordinator used by the tests
docs/           self-host, security, crypto, and threat-model notes
scripts/        build and config-check scripts
tests/          unit tests for the shared handlers
```

The API handlers are Web-standard, so they run unchanged on the Node server.
Reach storage through the seams (`getStore(env, name)`, `mutateKey`,
`mutateRecord`, `env.VAULT_MEDIA`, `env.ROOMS`) rather than calling a backend
directly.

## License

Sexualsync is under the
[PolyForm Noncommercial License 1.0.0](LICENSE). Personal and noncommercial
self-hosting, modification, and redistribution are allowed. Commercial or
hosted-service use, and use of the Sexualsync name, logo, wordmark, or brand
assets, are reserved. For a commercial license, contact the copyright holder
through the project's source repository.
