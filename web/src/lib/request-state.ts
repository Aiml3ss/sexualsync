import type { DecisionItem, RequestRecord } from "@/lib/types";

export type RequestCounterItem = Pick<DecisionItem, "targetType"> & {
  fromLabel: string;
  label: string;
};

export function requestCounterItems(request: RequestRecord): RequestCounterItem[] {
  const raw = request.counters?.length
    ? request.counters
    : (request.decisions || []).filter((item) => item.counter || item.counterActId);
  return raw
    .map((item) => {
      const label = String(item.counter || item.label || "").trim();
      const rawFromLabel = String(item.label || "").trim();
      const fromLabel = rawFromLabel && rawFromLabel !== label && !/^Counter option \d+$/i.test(rawFromLabel)
        ? rawFromLabel
        : "";
      return {
        fromLabel,
        label,
        targetType: item.targetType || "act",
      };
    })
    .filter((item) => item.label);
}

export function hasPendingRequestCounter(request: RequestRecord): boolean {
  return !request.counterAcceptedAt && requestCounterItems(request).length > 0;
}

export function isApprovedSexActRequest(request: RequestRecord): boolean {
  if (hasPendingRequestCounter(request)) return false;
  const hasApprovedActDecision = (request.decisions || []).some((decision) => (
    decision.decision === "Yes" && (!decision.targetType || decision.targetType === "act")
  ));
  if (hasApprovedActDecision) return request.status === "reviewed" || request.status === "on_deck";
  return request.status === "on_deck" && (request.categories || []).length > 0;
}

// Mirror of functions/api/request-board.js TIMING_EXPIRY_DAYS. The server pads
// room-encrypted (E2EE) Asks to a 7-day window because it can't read the real
// timing — only the partners' clients can. So the client is the source of truth
// for whether an agreed act's scheduled window has actually passed.
const TIMING_EXPIRY_DAYS: Record<string, number> = {
  "Tonight": 1,
  "Mid-day": 1,
  "Tomorrow": 2,
  "Next week": 7,
};

/**
 * True once a request's scheduled timing window has passed, computed from the
 * *decrypted* timing the client can read. Live through the whole window; stale
 * once the local day `days` after the anchor day begins — e.g. a "Tomorrow" act
 * anchored Monday is live Mon–Tue and goes stale Wed 00:00, and a "Tonight" one
 * goes stale at the start of the next day. Matches the server's non-E2EE expiry.
 */
function timingWindowPassed(request: RequestRecord, now: Date): boolean {
  const days = TIMING_EXPIRY_DAYS[request.timing];
  if (!days) return false;
  const anchorDay = startOfLocalDay(timingAnchorForRequest(request));
  if (!anchorDay) return false;
  return now.getTime() >= addLocalDays(anchorDay, days).getTime();
}

/**
 * True once an approved/agreed act's scheduled window has passed (the server
 * keeps E2EE Asks around for up to a week — it can't read their real timing — so
 * without this an agreed "tonight"/"tomorrow" act lingers on the Sexboard for
 * days). Gated to approved acts by its call sites.
 */
export function isApprovedSexActStale(request: RequestRecord, now: Date = new Date()): boolean {
  return timingWindowPassed(request, now);
}

/**
 * True once a still-PENDING/sent Ask's timing window has passed — the same E2EE
 * lingering problem as isApprovedSexActStale, but for an Ask the reviewer never
 * answered. In an encrypted room the server pads the expiry to ~7 days (it can't
 * read the real timing), so a "tonight" Ask the partner didn't respond to would
 * otherwise sit on the Sexboard for days. A still-pending/sent status already
 * means "unanswered" (any reviewer action moves it past those states).
 */
export function isStalePendingAsk(request: RequestRecord, now: Date = new Date()): boolean {
  if (request.status !== "pending" && request.status !== "sent") return false;
  return timingWindowPassed(request, now);
}

export function currentTimingLabel(request: RequestRecord): RequestRecord["timing"] {
  if (request.timing !== "Tomorrow") return request.timing;

  const anchor = timingAnchorForRequest(request);
  const anchorDay = startOfLocalDay(anchor);
  if (!anchorDay) return request.timing;

  const targetDay = addLocalDays(anchorDay, 1);
  const today = startOfLocalDay(new Date());
  if (!today) return request.timing;

  const dayDiff = Math.round((targetDay.getTime() - today.getTime()) / 86_400_000);
  if (dayDiff <= 0) return "Tonight";
  return request.timing;
}

export function timingAnchorForRequest(request: RequestRecord): Date {
  const hasTimingCounter = Boolean(request.acceptedTimingCounter)
    || (request.acceptedCounters || []).some((item) => item.targetType === "timing");
  // Field order MUST mirror the server (functions/api/request-board.js
  // timingAnchorForRequest): counterAcceptedAt first for an accepted timing
  // counter, sentAt first otherwise. A drift here makes the Tomorrow→Tonight
  // label disagree with when the server actually expires the Ask.
  const base = hasTimingCounter
    ? request.counterAcceptedAt || request.reviewedAt || request.sentAt || request.createdAt || request.updatedAt
    : request.sentAt || request.createdAt || request.reviewedAt || request.counterAcceptedAt || request.updatedAt;
  // A manual restore opens a fresh timing window — anchor on whichever is later,
  // matching the server so the label stays in step after a restore.
  if (request.restoredAt) {
    const restoredMs = new Date(request.restoredAt).getTime();
    const baseMs = new Date(base || "").getTime();
    if (Number.isFinite(restoredMs) && (!Number.isFinite(baseMs) || restoredMs > baseMs)) {
      return new Date(request.restoredAt);
    }
  }
  return new Date(base || "");
}

export function startOfLocalDay(value: Date): Date | null {
  const time = value.getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function addLocalDays(value: Date, days: number): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
}

export function timingCopyForRequest(request: RequestRecord): string {
  return currentTimingLabel(request).toLowerCase();
}
