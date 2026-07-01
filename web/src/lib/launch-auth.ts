const LAUNCH_SESSION_KEY = "ss:auth:launch-ok";
const LAUNCH_COOKIE = "sxs-launch";

let memoryLaunchOk = false;

export function markLaunchAuthenticated(): void {
  memoryLaunchOk = true;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(LAUNCH_SESSION_KEY, "1");
  } catch {
    // WebViews/private mode can block storage; memory still covers this tab.
  }
}

export function hasLaunchAuthenticated(): boolean {
  if (memoryLaunchOk) return true;
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(LAUNCH_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function consumeLaunchCookie(): boolean {
  if (typeof document === "undefined") return false;
  const hasCookie = document.cookie
    .split(";")
    .map((part) => part.trim())
    .some((part) => part === `${LAUNCH_COOKIE}=1`);
  if (!hasCookie) return false;
  markLaunchAuthenticated();
  document.cookie = `${LAUNCH_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
  return true;
}

export function ensureLaunchAuthenticated(): boolean {
  return hasLaunchAuthenticated() || consumeLaunchCookie();
}

// Loop guard for reauth-on-launch. The launch-authenticated marker lives in
// sessionStorage + memory, and the server's one-shot `sxs-launch` cookie is
// consumed (deleted) on first read. In a standalone PWA where sessionStorage is
// partitioned or cleared between document loads, that marker can vanish — and
// with no cap, RoomEncryptionGate would log the user out on every protected
// page load forever (logout -> sign in -> land -> logout ...). We stamp each
// forced reauth in localStorage and refuse to reauth again within a short
// window: at most one forced reauth per launch, then trust the still-valid
// session instead of looping.
//
// The key is deliberately NOT `ss:`-prefixed so it survives
// clearAllNamespacedLocalState() (which the sign-out path runs) — otherwise the
// logout half of the reauth would wipe the very marker meant to break the loop.
const LAUNCH_REAUTH_ATTEMPT_KEY = "sxs-launch-reauth-at";
const LAUNCH_REAUTH_COOLDOWN_MS = 2 * 60 * 1000;

export function launchReauthRecentlyAttempted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const at = Number(window.localStorage.getItem(LAUNCH_REAUTH_ATTEMPT_KEY)) || 0;
    return at > 0 && Date.now() - at < LAUNCH_REAUTH_COOLDOWN_MS;
  } catch {
    return false;
  }
}

export function recordLaunchReauthAttempt(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAUNCH_REAUTH_ATTEMPT_KEY, String(Date.now()));
  } catch {
    // localStorage blocked too — nothing else to persist; the gate then falls
    // through to marking the launch authenticated so the user is never trapped.
  }
}
