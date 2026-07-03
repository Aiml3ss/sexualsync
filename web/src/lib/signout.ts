/**
 * Pre-sign-out hooks. Run synchronously from the click handler on any logout
 * trigger so the next signed-in user on this device cannot inherit decrypted
 * vault title cache, lock attempt counter, install dismissals, or any other
 * namespaced state, and so every other open tab knows to relock.
 *
 * The server-side logout (`/api/auth/logout`) clears the session cookie. The
 * helpers here clear the client-side artifacts that the cookie clear cannot
 * touch.
 */

import { clearAllNamespacedLocalState } from "./local-storage-sweep";
import { markIntentionalSignOut } from "./auth-state";
import { clearChatImageBlobCache } from "./api";
import { clearRoomE2eeKeyCache } from "./room-crypto";
import { clearVaultKeyCache } from "./vault-crypto";
import { clearResourceCache } from "./resource-cache";
import { clearAppBadge } from "./app-badge";

// The offline write queue (web/src/lib/offline-queue.ts) persists plaintext
// request bodies for queueable composes to IndexedDB so they survive a PWA
// cold launch. On a shared device those bodies are intimate PII that must not
// outlive the session, so we drop the whole database on sign-out. Fire-and-
// forget with swallowed errors: a `blocked`/`error`/absent-DB event must never
// throw or hang the synchronous sign-out path.
function clearOfflineQueueDb(): void {
  if (typeof indexedDB === "undefined") return;
  try {
    const request = indexedDB.deleteDatabase("ss-offline-queue");
    request.onerror = () => {};
    request.onblocked = () => {};
  } catch {
    // deleteDatabase can throw in privacy modes / restricted webviews; the
    // queue is best-effort state, so swallow and continue signing out.
  }
}

export function broadcastSignedOut(): void {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel("ss:auth");
    channel.postMessage({ kind: "signed-out" });
    channel.close();
  } catch {
    // BroadcastChannel can be unsupported (older Safari, some webviews); the
    // server-side cookie clear still wins on next API call.
  }
}

export function prepareSignOut(): void {
  clearAllNamespacedLocalState();
  clearRoomE2eeKeyCache();
  clearVaultKeyCache();
  clearResourceCache();
  clearChatImageBlobCache();
  clearOfflineQueueDb();
  clearAppBadge();
  markIntentionalSignOut();
  broadcastSignedOut();
}
