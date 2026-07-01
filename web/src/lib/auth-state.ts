const INTENTIONAL_SIGN_OUT_KEY = "ss:intentional-sign-out";
const INTENTIONAL_SIGN_OUT_TTL_MS = 2 * 60 * 1000;

export function markIntentionalSignOut(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(INTENTIONAL_SIGN_OUT_KEY, String(Date.now()));
  } catch {
    // Storage can be unavailable in private/webview contexts. Server logout
    // still clears cookies; this marker only suppresses PWA auto-reconnect.
  }
}

export function clearIntentionalSignOut(): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.removeItem(INTENTIONAL_SIGN_OUT_KEY); } catch { /* ignore */ }
}

export function hasIntentionalSignOut(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(INTENTIONAL_SIGN_OUT_KEY);
    if (!raw) return false;
    const markedAt = Number(raw);
    if (!Number.isFinite(markedAt) || markedAt <= 0) {
      clearIntentionalSignOut();
      return false;
    }
    if (Date.now() - markedAt > INTENTIONAL_SIGN_OUT_TTL_MS) {
      clearIntentionalSignOut();
      return false;
    }
    return true;
  }
  catch { return false; }
}
