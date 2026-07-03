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

// Pre-`ss:` private-note keys (see private-notes.ts). They hold intimate
// plaintext on installs that predate encryption-at-rest, so sign-out must
// remove them like everything else. Deliberately NOT the broader
// `sexualsync-*` family: the push keys (sexualsync-push-*) survive sign-out
// on purpose — deleting the re-save dedupe would re-burn the push rate limit
// on every login.
const LEGACY_SWEEP_PREFIXES = ["sexualsync.privateNotes", "sexualsync-private-sparks:"];

export function clearAllNamespacedLocalState(): void {
  if (typeof window === "undefined") return;
  sweep("localStorage");
  sweep("sessionStorage");
}

function shouldSweep(key: string): boolean {
  if (key.startsWith("ss:")) return true;
  return LEGACY_SWEEP_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function sweep(area: "localStorage" | "sessionStorage"): void {
  try {
    const storage = window[area];
    if (!storage) return;
    const keysToRemove: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && shouldSweep(key)) keysToRemove.push(key);
    }
    keysToRemove.forEach((key) => {
      try { storage.removeItem(key); } catch { /* ignore */ }
    });
  } catch {
    // Storage can be unavailable in Safari private mode. Best effort.
  }
}
