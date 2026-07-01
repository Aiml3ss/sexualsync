/**
 * Web Push subscription helpers shared by the Space page (manual enable) and
 * the app-wide silent reconnect (components/PushReconnect). iOS invalidates a
 * push subscription whenever the service worker updates — which is every deploy,
 * since sw.js bakes in the release version — so a subscription that was never
 * re-ensured goes silently dead and the user has to "re-enable" notifications.
 */

import { getConfig, savePushSubscription } from "@/lib/api";

export const PUSH_PREFS_KEY = "sexualsync-push-preferences";

// Dedup the background re-save. The subscription is re-ensured on every app
// launch (PushReconnect) and every Space visit, and each used to POST
// /api/push-subscribe unconditionally — which, across a run of deploys (each
// rotates sw.js → iOS mints a NEW subscription), burned the per-user rate limit
// and left the user unable to (re-)enable notifications. We now skip the POST
// when the endpoint AND prefs are unchanged from the last save and it was saved
// recently. A deploy changes the endpoint, so healing after an update still
// fires; a stable device just stops spamming.
const PUSH_LAST_SAVE_KEY = "sexualsync-push-last-save";
const PUSH_RESAVE_INTERVAL_MS = 6 * 60 * 60 * 1000;

function pushPrefsSignature(prefs: Record<string, boolean>): string {
  return Object.keys(prefs).sort().map((k) => `${k}:${prefs[k] ? 1 : 0}`).join(",");
}

/** Remember a successful save so background re-ensures can skip a redundant POST. */
export function recordPushSave(endpoint: string, prefs: Record<string, boolean>): void {
  if (typeof localStorage === "undefined" || !endpoint) return;
  try {
    localStorage.setItem(PUSH_LAST_SAVE_KEY, JSON.stringify({ endpoint, sig: pushPrefsSignature(prefs), ts: Date.now() }));
  } catch {
    // localStorage unavailable / full — fine, we just re-save next time.
  }
}

function savedRecently(endpoint: string, prefs: Record<string, boolean>): boolean {
  if (typeof localStorage === "undefined" || !endpoint) return false;
  try {
    const raw = JSON.parse(localStorage.getItem(PUSH_LAST_SAVE_KEY) || "null");
    if (!raw || typeof raw !== "object") return false;
    return raw.endpoint === endpoint
      && raw.sig === pushPrefsSignature(prefs)
      && Date.now() - Number(raw.ts) < PUSH_RESAVE_INTERVAL_MS;
  } catch {
    return false;
  }
}

export function readStoredPushPrefs(): Record<string, boolean> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = JSON.parse(localStorage.getItem(PUSH_PREFS_KEY) || "{}");
    return raw && typeof raw === "object" ? (raw as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

// No explicit return annotation: `: Uint8Array` widens to
// Uint8Array<ArrayBufferLike> (TS 5.7+), which PushManager.subscribe's
// applicationServerKey rejects. Inference keeps the ArrayBuffer-backed type.
export function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output;
}

/**
 * Ensure a push subscription exists for this device + workspace and is saved on
 * the server. The caller must have already confirmed `Notification.permission`
 * is "granted" — this never prompts. Idempotent: reuses an existing
 * subscription, creates one only if missing. Re-saves so a server-side record
 * that was pruned (or a freshly re-created subscription after an iOS SW update)
 * is restored — but skips the POST when the endpoint + prefs are unchanged and
 * were saved within the last few hours, so repeated launches don't burn the
 * rate limit. Pass `{ force: true }` for a user-initiated save that must land.
 */
export async function ensurePushSubscription(
  workspaceId: string,
  preferences: Record<string, boolean>,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!workspaceId) return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
  const config = await getConfig();
  if (!config.vapidPublicKey) return;
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
    });
  }
  const json = subscription.toJSON();
  if (!opts.force && savedRecently(json.endpoint || "", preferences)) return;
  await savePushSubscription({ workspaceId, subscription: json, preferences });
  recordPushSave(json.endpoint || "", preferences);
}
