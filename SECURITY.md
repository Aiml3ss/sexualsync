# Security Policy

Sexualsync handles sensitive private-room data - intimate messages, encrypted
Vault media, invite links, and account data - so please report suspected
vulnerabilities privately.

## Supported version

The supported version is the current `main` branch of this repository. That
branch builds **both editions**: the Cloudflare production deployment and the
self-hosted Node edition (`SELF_HOST_TARGET=node`). A report against either is in
scope.

## Reporting a vulnerability

Please do **not** open a public issue containing exploit details, secrets,
private media, account data, invite links, room identifiers, or reproduction
steps that expose someone else's data.

Report privately, in order of preference:

1. **GitHub private vulnerability reporting** for this repository
   (Security - Report a vulnerability), if enabled.
2. **Email the security contact** published in the operator's
   [`/.well-known/security.txt`](.well-known/security.txt) (for example,
   `security@your-host.example` - each operator sets their own).

If neither is available to you, open a short public issue asking for a private
security contact channel and leave all technical detail out of the issue body.

A useful private report includes:

- the affected route, feature, or edition (Cloudflare vs. self-host)
- the impact
- the smallest safe reproduction you can share
- whether any real user data may have been exposed

I prioritize issues involving authentication, room access, Private Vault media,
invite links, the encryption boundaries (at-rest envelopes and Room
Encryption / E2EE), or data deletion.

## How Sexualsync is hardened

The security and privacy design is documented in [`docs/`](docs/):

- [E2EE threat model](docs/e2ee-threat-model.md) and
  [crypto-review packet](docs/crypto-review-packet.md) - the Room Encryption
  (end-to-end) design, exactly what it protects, and its known limits.
- [Code transparency](docs/code-transparency.md) - every production deploy
  publishes a signed (Ed25519) manifest at
  `/.well-known/code-transparency.json`, verifiable against the public key at
  `/.well-known/code-transparency-key.json`, so the running build can be checked
  against this source.
- [Security hardening audit](docs/security-hardening-audit.md),
  [incident-response checklist](docs/incident-response-checklist.md), and
  [provider-retention runbook](docs/provider-retention-runbook.md).

Durable records are encrypted at rest (versioned AES-GCM envelopes keyed by
`DATA_ENCRYPTION_KEY_V1`, falling back to `APP_SESSION_SECRET`). Room Encryption
additionally lets a couple end-to-end encrypt their sensitive room content with a
passphrase the server never receives. Vault media is encrypted in the browser
before upload.

## Scope note

There is no public hosted service to sign up for - Sexualsync is self-hosted.
Each operator runs their own instance. Reports against a specific deployment
should go to that instance's operator (see its `/.well-known/security.txt`);
reports against this source code, or against your own self-hosted deployment,
are welcome under the process above.
