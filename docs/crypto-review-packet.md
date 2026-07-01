# Crypto Review Packet

Use this packet for an outside cryptography review.

## Scope

- Room E2EE shared-passphrase model.
- Browser-side PBKDF2 key derivation.
- AES-GCM encrypted `RoomEncryptedBox` records.
- AES-GCM AAD binding by workspace and purpose.
- HMAC-SHA-256 blind indexes for Pile matching.
- Server plaintext rejection when `roomE2eeEnabled` is true.

## Current Primitives

- KDF: PBKDF2, SHA-256, 310,000 iterations.
- Encryption: AES-GCM.
- AAD: `sxs-room-e2ee-v1:<workspaceId>:<purpose>`.
- Verifier: encrypted workspace-verifier payload; passphrase never sent.
- Blind index: derived blind-index key, HMAC-SHA-256, no plaintext label sent.

## Security Properties Wanted

- Wrong passphrase fails verifier decrypt.
- Wrong workspace or purpose fails decrypt through AAD.
- Server cannot read protected content from new E2EE writes.
- Database dump reveals ciphertext, operational metadata, and generic placeholders only.
- Pile overlap works from blind tokens without plaintext labels.

## Known Limits

- PWA JavaScript is served by the server, so compromised deploy pipeline can attack future sessions.
- A compromised unlocked device can read plaintext.
- Shared passphrase means no individual per-user key control yet.
- Lost passphrase means protected room content cannot be recovered.
- Metadata remains for auth, membership, audit, notifications, and product state.

## Test Inventory

- `npm run check:e2ee`
- `node scripts/room-e2ee-vector-check.mjs`
- `node scripts/e2ee-runtime-guard-check.mjs`
- `node scripts/e2ee-migration-status-check.mjs`

## Review Questions

- Is PBKDF2 iteration count acceptable for 2026 mobile browsers?
- Should Argon2id/WebCrypto fallback be added when broadly available?
- Are AAD purpose strings complete and collision-resistant enough?
- Are blind indexes scoped enough to prevent cross-room correlation?
- Are generic placeholders and metadata boundaries acceptable for the threat model?
