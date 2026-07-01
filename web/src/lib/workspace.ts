/**
 * Helpers for reading workspace state. Pure functions, no fetching here.
 */

import type { AuthInfo, RequestRecord, Workspace } from "./types";
import { currentTimingLabel } from "./request-state";

export function normalizeEmail(value: string | undefined | null): string {
  return String(value || "").trim().toLowerCase();
}

export function memberByEmail(workspace: Workspace | null | undefined, email: string) {
  if (!workspace) return null;
  const target = normalizeEmail(email);
  return (workspace.members || []).find((m) => normalizeEmail(m.email) === target) || null;
}

export function partnerOf(workspace: Workspace | null | undefined, email: string) {
  if (!workspace) return null;
  const target = normalizeEmail(email);
  return (workspace.members || []).find((m) => normalizeEmail(m.email) !== target) || null;
}

export function isFromPartner(request: RequestRecord, me: AuthInfo): boolean {
  return normalizeEmail(request.requesterEmail) !== normalizeEmail(me.email);
}

/** Group active requests by the brief's five timing buckets.
 * Note: the backend currently uses four buckets ("Tonight" | "Mid-day" |
 * "Tomorrow" | "Next week"). We surface a "This week" alias for "Next week"
 * and add a virtual "Later" group that's always empty for now — wired so the
 * UI is ready when the backend grows the fifth bucket. */
export const TIMING_BUCKETS = [
  { key: "Tonight",   label: "Tonight" },
  { key: "Mid-day",   label: "Mid-day" },
  { key: "Tomorrow",  label: "Tomorrow" },
  { key: "Next week", label: "This week" },
  { key: "Later",     label: "Later" },
] as const;

export type TimingBucketKey = (typeof TIMING_BUCKETS)[number]["key"];

export function groupByTiming(requests: RequestRecord[]) {
  const grouped: Record<TimingBucketKey, RequestRecord[]> = {
    "Tonight": [],
    "Mid-day": [],
    "Tomorrow": [],
    "Next week": [],
    "Later": [],
  };
  for (const req of requests) {
    const timing = currentTimingLabel(req);
    const key = (timing as TimingBucketKey) in grouped ? (timing as TimingBucketKey) : "Later";
    grouped[key].push(req);
  }
  return grouped;
}

/** Per the brief: a pending request from your partner outranks everything.
 *  Sort so those float to the top, then the rest by updatedAt desc. */
export function rankActive(requests: RequestRecord[], me: AuthInfo): RequestRecord[] {
  return [...requests].sort((a, b) => {
    const aTop = a.status === "pending" && isFromPartner(a, me);
    const bTop = b.status === "pending" && isFromPartner(b, me);
    if (aTop && !bTop) return -1;
    if (!aTop && bTop) return 1;
    return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
  });
}
