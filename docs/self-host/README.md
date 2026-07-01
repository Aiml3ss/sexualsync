# Sexualsync - Self-Host Edition

> **Status: runnable (Phase 1).** A Node runtime now runs the *same* product
> code on filesystem-backed storage - **an edition of the same product, not a
> hard fork** - without changing the live Cloudflare app. Operator runbook:
> [`selfhost/README.md`](../../selfhost/README.md). The Cloudflare path is
> untouched and remains the default.

## What this is

The Sexualsync codebase runs in production on Cloudflare (Pages + Functions +
KV + R2 + Durable Objects). The "self-host edition" is a second runtime target
for the **same product code** so an operator can run Sexualsync on ordinary
infrastructure (a Node server) instead of Cloudflare. Phase 1 ships a working
Node runtime (`selfhost/`) backed by filesystem storage; Postgres / S3 backends
are planned scale-ups (see `MIGRATION_PLAN.md`).

It is deliberately **not a fork**:

- One repository, one set of product/domain logic.
- The Cloudflare and self-host runtimes differ only at a small set of
  **adapter boundaries** (storage, object storage, realtime/state, email).
- A single deployment-level selector, `SELF_HOST_TARGET`, chooses the runtime.
  It defaults to `cloudflare`.

## Core rule: Cloudflare stays the default path

**Nothing in the self-host edition changes the live app's behavior unless an
operator explicitly opts in via env.**

- `SELF_HOST_TARGET` is unset in production - resolves to `cloudflare`.
- Any missing or unrecognized value also resolves to `cloudflare` (a typo can
  never divert production).
- `npm run deploy`, `wrangler.toml`, Pages Functions, KV (`STORE`), R2
  (`VAULT_MEDIA`), the `ROOMS`/`STATE` Durable Objects, and every release check
  are untouched by this work.

The runtime marker lives beside the existing Cloudflare stack in
`functions/api/_runtime.js`. Importing it changes nothing on its own - it only
*reports* which runtime was selected so future adapters can branch in one
place.

## Documents in this directory

| File | Purpose |
| --- | --- |
| `README.md` | This overview: what the edition is and the non-negotiable Cloudflare-default rule. |
| `ARCHITECTURE.md` | Current Cloudflare stack mapped to the adapter boundaries the Node edition will implement. |
| `MIGRATION_PLAN.md` | Phased plan and the explicit build checklist (storage, object storage, realtime/state, email, Docker, license). |
| `CONFIG.md` | Environment variable matrix: which vars the Cloudflare path uses vs. the self-host path. |

## Related existing seams (already in the codebase)

The adapter pattern is not new here - production already switches backends by
env, which is why a self-host edition can be added without a fork:

- `functions/api/_kv.js` - `DATA_BACKEND=kv|dual|supabase` selects the durable
  store backend behind a single `getStore(env, name)` surface.
- `functions/api/_state.js` - falls back to an in-process lock when the `STATE`
  Durable Object binding is absent, behind `mutateKey` / `mutateRecord`.

The self-host edition extends these existing seams rather than introducing a
parallel codebase.

## License (noncommercial self-hosting is permitted)

The repository is licensed under the **PolyForm Noncommercial License 1.0.0**
(`/LICENSE`). This **permits personal and noncommercial self-hosting** -
individuals and noncommercial organizations may run, modify, and self-host the
software.

It does **not** permit commercial or public hosted-service use: you may not use
the software to provide a hosted, commercial, public, or production service. The
copyright holder operates Sexualsync commercially as the licensor and retains
all rights to do so; the "Sexualsync" name and brand assets are reserved. For a
commercial license, contact the copyright holder through the project's source
repository.
