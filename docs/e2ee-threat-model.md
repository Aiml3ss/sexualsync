# Room E2EE Threat Model

## Scope

Sexualsync Room Encryption uses a shared passphrase chosen by the partners. New encrypted room content is encrypted in the browser before it is sent to the API. The passphrase is not sent to Sexualsync.

## Protects Against

- Database/KV/R2 dumps exposing encrypted room text.
- Backend operators reading encrypted room text at rest.
- Accidental logs/backups revealing protected room text.
- Partner devices that do not know the shared room passphrase.

## Does Not Protect Against

- A compromised device after the room is unlocked.
- Screenshots, clipboard, browser extensions, malware, or physical access to an unlocked device.
- A malicious or compromised app bundle served to the browser. PWAs receive JavaScript from the server, so server integrity still matters.
- Metadata that remains intentionally operational: account email, membership, invite state, timestamps, entity ids, notification settings, audit events, and similar security records.
- Text a user explicitly sends to AI-assisted features.

## Shared Passphrase Policy

- Partners choose one room passphrase together.
- The passphrase unlocks the room on each device.
- Lost passphrase means encrypted room content cannot be recovered.
- The app may cache derived key material for the current browser session so navigation does not re-prompt, but it clears that cache on relock, signout, and stale background return.

## Current Encryption Coverage

- Asks and replies.
- Limits.
- Inspiration Kinks, comments, and reaction notes.
- Shelf content and titles.
- Blind Reveal prompts and answers.
- Custom Acts labels/tags.
- Pile labels and match labels.
- Vault media and private Vault text use Vault encryption before upload.

## Metadata Boundary

E2EE protects content, not all metadata. Metadata minimization should prefer:

- Generic activity and notification copy.
- Counts instead of item labels.
- Opaque ids instead of titles/text.
- Coarse or retention-limited records where exact timestamps are not needed.
- No passphrase, plaintext encrypted content, or AI-decrypted content in logs.

## Invariants

- When `roomE2eeEnabled` is true, sensitive new room text must arrive as a `RoomEncryptedBox`.
- Server placeholders must be generic and non-content-bearing.
- AES-GCM additional authenticated data must bind ciphertext to workspace and purpose.
- Blind indexes must never include plaintext values.
- Wrong passphrase, wrong workspace, or wrong purpose must fail decryption.
