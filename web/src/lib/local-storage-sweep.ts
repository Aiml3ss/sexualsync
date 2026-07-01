/**
 * Wipe every `ss:*` localStorage and sessionStorage entry.
 *
 * Run on sign-out, lock reset, and any cross-tab "signed-out" broadcast so the
 * next signed-in user on the same device doesn't inherit decrypted vault
 * titles, lock config, install dismissals, or any other namespaced state.
 *
 * Web Crypto-derived material lives in module-scoped Maps that the page
 * tears down on navigation; the in-memory `_keyCache` in vault-crypto.ts is
 * additionally cleared here via the optional hook the caller passes in.
 */

export function clearAllNamespacedLocalState(): void {
  if (typeof window === "undefined") return;
  sweep("localStorage");
  sweep("sessionStorage");
}

function sweep(area: "localStorage" | "sessionStorage"): void {
  try {
    const storage = window[area];
    if (!storage) return;
    const keysToRemove: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && key.startsWith("ss:")) keysToRemove.push(key);
    }
    keysToRemove.forEach((key) => {
      try { storage.removeItem(key); } catch { /* ignore */ }
    });
  } catch {
    // Storage can be unavailable in Safari private mode. Best effort.
  }
}
