"use client";

/**
 * Silently re-ensures this device's push subscription on app launch.
 *
 * iOS invalidates a PWA's push subscription whenever the service worker updates,
 * which happens on every deploy (sw.js bakes in the release version). Before
 * this, the subscription only got re-created if the user happened to open the
 * Space page — so after each update notifications went quiet until they manually
 * "re-enabled" them. Running once per launch, when permission is already
 * granted, makes a stale subscription self-heal with no user action.
 *
 * Mounted app-wide in layout.tsx alongside PwaBridge. Renders nothing.
 */

import { useEffect, useRef } from "react";
import { getProfileCached } from "@/lib/profile-cache";
import { ensurePushSubscription, readStoredPushPrefs } from "@/lib/push-subscription";

export default function PushReconnect() {
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (typeof window === "undefined") return;
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
    // Only re-ensure for users who already opted in. We never prompt here.
    if (Notification.permission !== "granted") return;

    (async () => {
      try {
        const profile = await getProfileCached();
        const workspaceId = profile.activeWorkspaceId || profile.workspaces?.[0]?.id || "";
        if (!workspaceId) return;
        await ensurePushSubscription(workspaceId, readStoredPushPrefs());
      } catch {
        // Best effort — the Space page can still enable notifications manually.
      }
    })();
  }, []);

  return null;
}
