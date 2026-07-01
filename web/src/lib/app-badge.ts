// PWA app-icon badge — the little red count on the home-screen icon, like a
// native app. Uses the web Badging API, which works on installed PWAs including
// iOS 16.4+ (it is a no-op in a regular browser tab — the app must be installed
// to the Home Screen).
//
// Everything here is best-effort and feature-detected: unsupported or blocked
// environments simply do nothing. Privacy note: a badge is only ever a COUNT,
// never any content, so it leaks nothing — consistent with the app's
// discreet-by-default posture.

type BadgeNavigator = Navigator & {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

function badgeNavigator(): BadgeNavigator | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as BadgeNavigator;
  return typeof nav.setAppBadge === "function" ? nav : null;
}

/** True when the running context can show an app-icon badge (installed PWA). */
export function appBadgeSupported(): boolean {
  return badgeNavigator() !== null;
}

/**
 * Set the home-screen badge to `count`. A count of 0 (or less) clears it.
 * Safe to call anywhere — it no-ops when the Badging API isn't available.
 */
export function syncAppBadge(count: number): void {
  const nav = badgeNavigator();
  if (!nav) return;
  const n = Math.max(0, Math.floor(Number(count) || 0));
  try {
    if (n > 0) {
      void nav.setAppBadge?.(n).catch(() => {});
    } else if (typeof nav.clearAppBadge === "function") {
      void nav.clearAppBadge().catch(() => {});
    } else {
      void nav.setAppBadge?.(0).catch(() => {});
    }
  } catch {
    // Badging API present but threw — ignore; the badge is non-essential.
  }
}

/** Clear the home-screen badge entirely (e.g. on sign-out). */
export function clearAppBadge(): void {
  syncAppBadge(0);
}
