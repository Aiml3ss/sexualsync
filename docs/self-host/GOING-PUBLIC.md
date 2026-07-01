# Before opening signups

Sexualsync is meant to be a private self-hosted room. Opening it to strangers,
marketing a hosted URL, or setting `PUBLIC_SIGNUPS_OPEN=1` changes the risk
profile. Do the work below before you run it as a public service.

## Data layer

Do not open signups while durable app records are on Cloudflare KV or the
single-process self-host filesystem store.

Sexualsync is write-heavy: asks, replies, reactions, Pile drops, Blind Reveals,
Vault metadata, activity, and audit records all mutate shared room state. KV is
eventually consistent and write-limited. The Node self-host runtime uses an
in-process lock and realtime registry, which is correct for one process but not
for horizontal scale.

Before open signup:

- Move durable app records to Postgres, D1, or another database with real write
  concurrency.
- Replace the in-process realtime and state lock with shared transports.
- Run the migration dry runs and parity checks before switching traffic.
- Keep at-rest JSON encryption enabled after the move.

The current seams are `functions/api/_kv.js`, `functions/api/_state.js`, and
the scale-out plan in [MIGRATION_PLAN.md](MIGRATION_PLAN.md).

## Legal and safety

An intimate-content service needs operating processes, not just code.

- Age-gate and eligibility policy for adults only.
- Abuse, safety, and removal reporting.
- CSAM and non-consensual intimate content handling.
- DMCA process.
- Terms and privacy policy that match the way you run the service.
- Data export and deletion handling.
- Provider retention review for logs, email, storage, diagnostics, and AI.

Do not rely on the bundled static legal pages as legal advice. They are a
starting point for the project, not a substitute for your own review.

## License

The repository uses the PolyForm Noncommercial License 1.0.0. Personal and
noncommercial self-hosting is allowed. Commercial use, hosted-service use, and
use of the Sexualsync brand are reserved unless you have a separate license.

## Abuse controls

Before accepting strangers:

- Add bot protection on signup and public forms.
- Keep auth and AI rate limits fail-closed.
- Put the app behind TLS.
- Set `TRUST_PROXY=true` only behind a proxy that overwrites forwarded headers.
- Set `AUTH_BASE_URL` or `PUBLIC_BASE_URL` so forwarded-host allowlists work.
- Keep notification and email copy discreet.

## Flip last

`PUBLIC_SIGNUPS_OPEN=1` should be the last step, after storage, moderation,
legal, backup, and abuse controls are ready.
