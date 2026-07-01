# Sexualsync Web

This is the Sexualsync web app: Next.js 16 App Router, TypeScript, Tailwind,
and the Cloudflare Pages Functions API.

The product promise is privacy-first: the UI behaves like a normal shared room,
while the API stores durable room JSON as encrypted-at-rest envelopes. Users do
not manage a separate key or passphrase for shared-room data. Vault media and
Vault text remain browser-encrypted before upload.

The old root SPA shell has been retired. Production deploys now run
`next build`, copy the generated app output into `dist`, and serve the app
routes from the main Pages project alongside `functions/api/*`.

## Routes

- `/` — Google sign-in
- `/sexboard` — live room dashboard and activity surface
- `/tonight` — tonight/on-deck state
- `/ask` — Ask composer
- `/ask-detail` — Ask review/detail
- `/inspiration` — source links, Shelf entry, Kinks/Fantasies
- `/inspiration/kink?id=...` — Kink detail
- `/inspiration/kinks/[id]` — route-based Kink detail
- `/inspiration/shelf` — The Shelf
- `/ideas`, `/ideas/[id]`, `/ideas/[id]/reaction` — Ideas list, detail, and reaction helper routes
- `/games`, `/games/pile`, `/games/blind-reveal` — Games
- `/mutual` — mutual-interest surface
- `/limits` — top-level Limits shortcut
- `/more` — secondary navigation
- `/share` — PWA/share target landing
- `/splash` — splash/brand route
- `/space`, `/space/limits`, `/space/acts`, `/space/notes`, `/space/vault`, `/space/health`, `/space/tutorial` — settings and subpages

## Local Development

```sh
cd web
npm install
npm run dev
```

For API-backed local testing, run the Pages Functions server from the repo root:

```sh
npm run dev
```

Then set `API_PROXY_TARGET=http://localhost:8788` when starting the Next dev
server if you want `/api/*` proxied to local Wrangler instead of production:

```sh
API_PROXY_TARGET=http://localhost:8788 npm run dev
```

## Production Build

From the repo root:

```sh
npm run build:v1-preview
npm run build
npm run check:pwa:dist
```

`npm run deploy` runs the release gates, builds the Next output, creates `dist`,
and deploys to Cloudflare Pages.

## Privacy Notes

- Shared-room data such as Asks, Limits, Acts, Kinks, Shelf entries, feedback,
  activity, presence, push subscriptions, audit logs, and review tokens is
  encrypted before durable KV/Supabase storage.
- The frontend contract should not change because decryption happens inside the
  API after workspace authorization.
- Vault media, titles, comments, and moments use the separate browser-side Vault
  encryption flow.
