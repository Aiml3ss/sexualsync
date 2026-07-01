# Legacy E2EE Re-Encrypt Runbook

Server cannot re-encrypt legacy plaintext by itself because the passphrase never reaches the backend.

## Backend Foundation

- `/api/e2ee/status?workspaceId=...` returns counts only.
- It does not return plaintext.
- It scans Room E2EE surfaces for records missing encrypted fields.
- It reports whether browser re-encrypt can run for the room.

## Browser Migration Shape

1. User unlocks room with shared passphrase.
2. Browser fetches normal authorized data.
3. Browser encrypts legacy plaintext fields locally.
4. Browser saves encrypted replacements through existing APIs.
5. Browser calls `/api/e2ee/status` until total is zero.
6. Browser clears local plaintext caches.

## Do Not Do

- Do not send passphrase to server.
- Do not add server-side plaintext export.
- Do not log migration payloads.
- Do not show hidden plaintext counts in user UI until product copy is ready.
