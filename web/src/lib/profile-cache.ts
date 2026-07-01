/**
 * Client-side profile cache. Pages that read `getProfile()` on mount used
 * to fetch it cold every time the user navigated home → vault → home →
 * settings (two extra round trips per nav). This module deduplicates that
 * traffic with a tiny TTL + an explicit invalidation API for mutations.
 *
 * Why so small: the cached value is intentionally short-lived (30 s) and
 * mutations that change profile/workspace state call `invalidateProfile()`
 * explicitly. Anything that fetches the profile in pursuit of a
 * just-completed write (rename room, accept invite, etc.) still gets fresh
 * data because the caller invalidates before re-reading. Background nav
 * within the TTL window skips the round trip.
 *
 * Cross-tab logout already flushes all `ss:*` state via signout.ts, so the
 * cache doesn't have to track its own logout invalidation.
 */

import { getProfile } from "./api";
import type { ProfileResponse } from "./types";

const TTL_MS = 30 * 1000;

interface CacheEntry {
  fetchedAt: number;
  value: ProfileResponse;
}

let cached: CacheEntry | null = null;
let inFlight: Promise<ProfileResponse> | null = null;
const listeners = new Set<(profile: ProfileResponse) => void>();

// External invalidation signal. api.ts dispatches this event after any
// profile- or workspace-mutating write (rename room, invite accept/decline,
// settings update) so the next getProfileCached() call refetches instead
// of handing back stale data. Listening here avoids a circular import
// between api.ts and profile-cache.ts.
export const PROFILE_STALE_EVENT = "ss:profile-stale";
if (typeof window !== "undefined") {
  window.addEventListener(PROFILE_STALE_EVENT, () => { cached = null; });
}

function notify(profile: ProfileResponse): void {
  listeners.forEach((fn) => {
    try { fn(profile); } catch { /* listener errors are non-fatal */ }
  });
}

/**
 * Returns a cached profile if fresh, otherwise fetches. Concurrent calls
 * during an in-flight fetch share the same Promise.
 *
 * @param options.force - skip the cache and always fetch. Use after a
 *   profile-mutating write that you know flipped state.
 */
export async function getProfileCached(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<ProfileResponse> {
  const now = Date.now();
  if (!options.force && cached && now - cached.fetchedAt < TTL_MS) {
    return cached.value;
  }
  if (inFlight && !options.force) {
    return inFlight;
  }
  const fetchPromise = (async () => {
    const profile = await getProfile(options.signal);
    cached = { fetchedAt: Date.now(), value: profile };
    notify(profile);
    return profile;
  })();
  inFlight = fetchPromise;
  try {
    return await fetchPromise;
  } finally {
    if (inFlight === fetchPromise) inFlight = null;
  }
}

/**
 * Drop the cache. Call after any mutation that could change profile or
 * workspace state — workspace rename, invite accept/decline, push
 * preferences update, account deletion schedule, etc.
 */
export function invalidateProfile(): void {
  cached = null;
}

/**
 * Subscribe to fresh profile fetches. Pages can use this to re-render
 * when a sibling page updated the profile through the same cache.
 */
export function subscribeProfile(fn: (profile: ProfileResponse) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
