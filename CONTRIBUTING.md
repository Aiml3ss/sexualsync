# Contributing to Sexualsync (self-host edition)

Thanks for looking at the code. This repository is the **self-host edition** of
Sexualsync: the same product that runs on Cloudflare, packaged to run on a plain
Node server with filesystem storage. It is open source under the
[PolyForm Noncommercial License 1.0.0](LICENSE), so you can run, modify, and
share it for personal and noncommercial use.

A few things are worth knowing before you open an issue or a pull request.

## This is a curated mirror

Development happens in a separate upstream repository, and this repo is a
hand-curated snapshot of the self-host slice. It drifts behind upstream between
releases, and updates land as squashed `sync self-host edition to vX` commits
rather than the full upstream history. In practice:

- Fixes are welcome, but a maintainer folds accepted changes into the upstream
  source, and they return here on the next sync. Your commit may not appear
  verbatim.
- Large refactors are hard to accept, because they conflict with the next sync.
  Small, targeted patches land much more easily.

## Good things to contribute

- Self-host bugs: build or boot failures, adapter issues (filesystem KV and
  media, the in-process realtime room), Docker and Compose, reverse-proxy setups.
- Portability: making the Node runtime work on more platforms without adding
  Cloudflare-only assumptions.
- Documentation: anything in `docs/self-host/` or the READMEs that was wrong,
  missing, or confusing when you set up your own instance.

## Before you open a pull request

Install and run the gates locally:

```bash
npm ci && npm --prefix web ci
npm test                # shared handler unit tests
npm run selfhost:test   # Node adapters and server
npm run selfhost:smoke  # boots the server, runs a two-user flow
npm run selfhost:check  # config and docs sanity
npm run selfhost:build  # production web build
```

Keep the API handlers under `functions/` Web-standard, with no Cloudflare-only
globals, so they keep running on both runtimes. Reach storage through the seams
(`getStore`, `mutateKey`, `env.VAULT_MEDIA`, `env.ROOMS`) instead of calling a
backend directly. See [docs/self-host/](docs/self-host/) for the architecture.

## Reporting security issues

Please do not file security problems in public issues. [SECURITY.md](SECURITY.md)
explains how to report them privately.

## License and scope

Contributions are accepted under the same PolyForm Noncommercial License that
covers the rest of the repo. The Sexualsync name and brand assets are reserved
and are not part of the open-source grant. Commercial and hosted-service use are
out of scope for this repository; for that, contact hello@sexualsync.io.
