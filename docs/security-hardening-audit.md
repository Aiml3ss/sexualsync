# Privacy And Security Hardening Audit

## Already In Place

- HttpOnly, Secure, SameSite app session cookies.
- First-party Google/email auth with private-preview gating.
- Active-member workspace authorization.
- Route middleware for protected app paths.
- CSP nonce with `strict-dynamic`, `frame-ancestors 'none'`, and no remote runtime scripts in the authenticated app.
- Generic lock-screen push copy through one notification policy chokepoint.
- KV/Supabase app-data encryption at rest for primary stores.
- Vault media encrypted before upload.
- Admin dashboard restricted to configured owner email.
- Audit metadata is allowlisted and drops content-like fields.
- E2EE inventory, crypto vectors, plaintext-reject checks, and AI-boundary checks run in deploy.
- Hidden E2EE legacy status endpoint reports plaintext counts without returning content.
- Audit, Activity, feedback, and expired review-token stores have backend retention windows.
- `/.well-known/security.txt` and incident-response checklist exist.
- Provider retention runbook, crypto review packet, native code-transparency roadmap, and legacy re-encrypt runbook exist.
- Dependency audit runs in CI and deploy.
- Session cookies include revocable ids; logout revokes current sessions and a hidden endpoint can revoke all sessions for an account.
- Deploy runs release, privacy, E2EE, room, RLS, notification, PWA, flow, and live checks.

## Partial

- Session/device management: backend revocation exists; no user-visible device list yet.
- AI boundary: privacy copy, rate limits, and encrypted-content guards exist; keep expanding coverage as AI features change.
- Metadata minimization: notifications are generic and audit metadata is scrubbed; exact activity timestamps/entity ids still exist for product behavior.
- Data retention: workspace deletion purges scoped records and core metadata windows exist; provider retention needs ongoing external review.

## Next Backend Work

- Keep E2EE threat model current.
- Maintain an automated E2EE inventory guard.
- Maintain crypto vector tests for AES-GCM/AAD/blind indexes.
- Add user-visible account/session device list when product is ready for that UI.
- Commission external crypto review using `docs/crypto-review-packet.md`.

## Non-Goals For This Batch

- No visible UI changes.
- No passphrase recovery.
- No native-app key attestation.
- No move away from the shared passphrase model.
