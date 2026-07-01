// Client-server timing parity tests.
//
// web/src/lib/request-state.ts mirrors the server's timing machine in
// functions/api/request-board.js (timingAnchorForRequest / expiryDaysForRequest).
// These fixtures pin the PARITY semantics: the anchor fallback chains, the
// accepted-timing-counter chain flip, and the restoredAt "fresh window" rule
// must match what the server uses to expire an Ask, or the Tomorrow→Tonight
// label drifts from the real expiry.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  currentTimingLabel,
  isApprovedSexActStale,
  isStalePendingAsk,
  timingAnchorForRequest,
  timingCopyForRequest,
} from "../request-state";
import type { DecisionItem, RequestRecord } from "../types";

// Distinct, strictly ordered instants so each fallback step is unambiguous.
const T1 = "2026-06-01T10:00:00.000Z";
const T2 = "2026-06-02T10:00:00.000Z";
const T3 = "2026-06-03T10:00:00.000Z";
const T4 = "2026-06-04T10:00:00.000Z";
const T5 = "2026-06-05T10:00:00.000Z";

const ms = (iso: string): number => new Date(iso).getTime();

const TIMING_COUNTER: DecisionItem = {
  label: "Tonight",
  decision: "Counter",
  counter: "Tomorrow",
  counterActId: "",
  note: "",
  targetType: "timing",
  actId: "",
};

function req(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id: "req_1",
    workspaceId: "ws_1",
    status: "sent",
    requester: "requester",
    reviewer: "reviewer",
    requesterEmail: "requester@example.com",
    reviewerEmail: "reviewer@example.com",
    categories: [],
    timing: "Tonight",
    filming: "No",
    decisions: [],
    counters: [],
    boundaryConflicts: [],
    note: "",
    feedback: "",
    createdAt: T1,
    updatedAt: T1,
    ...overrides,
  };
}

describe("timingAnchorForRequest", () => {
  describe("plain Ask (no accepted timing counter)", () => {
    it("anchors at sentAt even when later timestamps exist", () => {
      const anchor = timingAnchorForRequest(req({
        sentAt: T2,
        createdAt: T1,
        reviewedAt: T3,
        counterAcceptedAt: T4, // set, but no timing counter → plain chain
        updatedAt: T5,
      }));
      expect(anchor.getTime()).toBe(ms(T2));
    });

    it("falls back to createdAt when sentAt is missing", () => {
      const anchor = timingAnchorForRequest(req({
        sentAt: undefined,
        createdAt: T1,
        reviewedAt: T3,
        updatedAt: T5,
      }));
      expect(anchor.getTime()).toBe(ms(T1));
    });

    it("falls back to reviewedAt when sentAt and createdAt are missing", () => {
      const anchor = timingAnchorForRequest(req({
        sentAt: undefined,
        createdAt: "",
        reviewedAt: T3,
        counterAcceptedAt: T4,
        updatedAt: T5,
      }));
      expect(anchor.getTime()).toBe(ms(T3));
    });

    it("falls back to counterAcceptedAt before updatedAt", () => {
      const anchor = timingAnchorForRequest(req({
        sentAt: undefined,
        createdAt: "",
        reviewedAt: undefined,
        counterAcceptedAt: T4,
        updatedAt: T5,
      }));
      expect(anchor.getTime()).toBe(ms(T4));
    });

    it("falls back to updatedAt last", () => {
      const anchor = timingAnchorForRequest(req({
        sentAt: undefined,
        createdAt: "",
        reviewedAt: undefined,
        counterAcceptedAt: undefined,
        updatedAt: T5,
      }));
      expect(anchor.getTime()).toBe(ms(T5));
    });
  });

  describe("accepted timing counter (chain flips to counterAcceptedAt first)", () => {
    it("anchors at counterAcceptedAt when acceptedTimingCounter is set", () => {
      const anchor = timingAnchorForRequest(req({
        acceptedTimingCounter: TIMING_COUNTER,
        counterAcceptedAt: T4,
        sentAt: T1, // would win the plain chain — must lose here
        createdAt: T1,
        reviewedAt: T2,
        updatedAt: T5,
      }));
      expect(anchor.getTime()).toBe(ms(T4));
    });

    it("anchors at counterAcceptedAt when acceptedCounters contains a timing counter", () => {
      const anchor = timingAnchorForRequest(req({
        acceptedCounters: [TIMING_COUNTER],
        counterAcceptedAt: T4,
        sentAt: T1,
        createdAt: T1,
        reviewedAt: T2,
        updatedAt: T5,
      }));
      expect(anchor.getTime()).toBe(ms(T4));
    });

    it("ignores accepted counters that are not timing-targeted", () => {
      const anchor = timingAnchorForRequest(req({
        acceptedCounters: [{ ...TIMING_COUNTER, targetType: "act" }],
        counterAcceptedAt: T4,
        sentAt: T2,
        createdAt: T1,
        updatedAt: T5,
      }));
      // act counter → plain chain → sentAt wins
      expect(anchor.getTime()).toBe(ms(T2));
    });

    it("falls back to reviewedAt BEFORE sentAt when counterAcceptedAt is missing", () => {
      const anchor = timingAnchorForRequest(req({
        acceptedTimingCounter: TIMING_COUNTER,
        counterAcceptedAt: undefined,
        reviewedAt: T3,
        sentAt: T1, // plain chain would pick this — counter chain must not
        createdAt: T1,
        updatedAt: T5,
      }));
      expect(anchor.getTime()).toBe(ms(T3));
    });
  });

  describe("restoredAt (manual restore opens a fresh window)", () => {
    it("anchors at restoredAt when it is later than the base anchor", () => {
      const anchor = timingAnchorForRequest(req({
        sentAt: T1,
        createdAt: T1,
        restoredAt: T3,
      }));
      expect(anchor.getTime()).toBe(ms(T3));
    });

    it("keeps the base anchor when restoredAt is earlier", () => {
      const anchor = timingAnchorForRequest(req({
        sentAt: T3,
        createdAt: T1,
        restoredAt: T1,
      }));
      expect(anchor.getTime()).toBe(ms(T3));
    });

    it("anchors at the shared instant when accept_counter stamps restoredAt == counterAcceptedAt", () => {
      // accept_counter writes restoredAt == counterAcceptedAt, so equal stamps
      // are the normal case — both paths must land on that same instant.
      const anchor = timingAnchorForRequest(req({
        acceptedTimingCounter: TIMING_COUNTER,
        counterAcceptedAt: T4,
        restoredAt: T4,
        sentAt: T1,
        createdAt: T1,
        updatedAt: T5,
      }));
      expect(anchor.getTime()).toBe(ms(T4));
    });

    it("anchors at restoredAt when the base anchor is unparseable", () => {
      const anchor = timingAnchorForRequest(req({
        sentAt: undefined,
        createdAt: "",
        reviewedAt: undefined,
        counterAcceptedAt: undefined,
        updatedAt: "",
        restoredAt: T2,
      }));
      expect(anchor.getTime()).toBe(ms(T2));
    });
  });
});

describe("currentTimingLabel", () => {
  // Fixed local mid-day "now" so startOfLocalDay math is deterministic in any TZ:
  // today = 2026-06-09 (local).
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 9, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const localIso = (day: number, hour: number): string =>
    new Date(2026, 5, day, hour, 0, 0).toISOString();

  it('rolls "Tomorrow" over to "Tonight" when the anchor is yesterday', () => {
    const label = currentTimingLabel(req({
      timing: "Tomorrow",
      sentAt: localIso(8, 15), // yesterday → "tomorrow" means today
    }));
    expect(label).toBe("Tonight");
  });

  it('rolls "Tomorrow" over to "Tonight" when the anchor is further in the past', () => {
    const label = currentTimingLabel(req({
      timing: "Tomorrow",
      sentAt: localIso(6, 15),
    }));
    expect(label).toBe("Tonight");
  });

  it('keeps "Tomorrow" when the anchor is today', () => {
    const label = currentTimingLabel(req({
      timing: "Tomorrow",
      sentAt: localIso(9, 9), // earlier today, still anchored today
    }));
    expect(label).toBe("Tomorrow");
  });

  it('keeps "Tomorrow" after a restore today, even when the original send is stale', () => {
    const label = currentTimingLabel(req({
      timing: "Tomorrow",
      sentAt: localIso(6, 15),
      restoredAt: localIso(9, 10), // fresh window from the restore
    }));
    expect(label).toBe("Tomorrow");
  });

  it("passes non-Tomorrow timings through unchanged", () => {
    const stale = { sentAt: localIso(6, 15) };
    expect(currentTimingLabel(req({ timing: "Tonight", ...stale }))).toBe("Tonight");
    expect(currentTimingLabel(req({ timing: "Mid-day", ...stale }))).toBe("Mid-day");
    expect(currentTimingLabel(req({ timing: "Next week", ...stale }))).toBe("Next week");
  });

  it('keeps "Tomorrow" when the anchor is unparseable', () => {
    const label = currentTimingLabel(req({
      timing: "Tomorrow",
      sentAt: undefined,
      createdAt: "",
      reviewedAt: undefined,
      counterAcceptedAt: undefined,
      updatedAt: "",
    }));
    expect(label).toBe("Tomorrow");
  });
});

describe("timingCopyForRequest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 9, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lowercases the current label", () => {
    expect(timingCopyForRequest(req({
      timing: "Next week",
      sentAt: "2026-06-09T01:00:00.000Z",
    }))).toBe("next week");
  });

  it("lowercases the rolled-over label", () => {
    expect(timingCopyForRequest(req({
      timing: "Tomorrow",
      sentAt: new Date(2026, 5, 8, 15, 0, 0).toISOString(), // yesterday → Tonight
    }))).toBe("tonight");
  });
});

describe("isStalePendingAsk", () => {
  // today = 2026-06-09 (local), mid-day so day math is TZ-stable.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 9, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const localIso = (day: number, hour: number): string =>
    new Date(2026, 5, day, hour, 0, 0).toISOString();

  it("keeps a pending Tonight Ask sent today (still live tonight)", () => {
    expect(isStalePendingAsk(req({ status: "sent", timing: "Tonight", sentAt: localIso(9, 9) }))).toBe(false);
  });

  it("marks a pending Tonight Ask from last night stale on the new day (the reported bug)", () => {
    expect(isStalePendingAsk(req({ status: "sent", timing: "Tonight", sentAt: localIso(8, 21) }))).toBe(true);
  });

  it("applies to 'pending' status too, not just 'sent'", () => {
    expect(isStalePendingAsk(req({ status: "pending", timing: "Tonight", sentAt: localIso(8, 21) }))).toBe(true);
  });

  it("does NOT apply once the Ask has moved past pending/sent (answered/agreed)", () => {
    expect(isStalePendingAsk(req({ status: "on_deck", timing: "Tonight", sentAt: localIso(8, 21) }))).toBe(false);
    expect(isStalePendingAsk(req({ status: "reviewed", timing: "Tonight", sentAt: localIso(8, 21) }))).toBe(false);
  });

  it("keeps a pending Tomorrow Ask whose day is today (still live)", () => {
    expect(isStalePendingAsk(req({ status: "sent", timing: "Tomorrow", sentAt: localIso(8, 15) }))).toBe(false);
  });
});

describe("isApprovedSexActStale", () => {
  // today = 2026-06-09 (local), mid-day so day math is TZ-stable.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 9, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const localIso = (day: number, hour: number): string =>
    new Date(2026, 5, day, hour, 0, 0).toISOString();

  it("keeps a Tonight act agreed today (live through its window)", () => {
    expect(isApprovedSexActStale(req({ timing: "Tonight", sentAt: localIso(9, 9) }))).toBe(false);
  });

  it("marks a Tonight act agreed yesterday as stale", () => {
    expect(isApprovedSexActStale(req({ timing: "Tonight", sentAt: localIso(8, 20) }))).toBe(true);
  });

  it("keeps a Tomorrow act agreed yesterday (its day is today — still live)", () => {
    expect(isApprovedSexActStale(req({ timing: "Tomorrow", sentAt: localIso(8, 15) }))).toBe(false);
  });

  it("marks a Tomorrow act stale once two days have passed", () => {
    expect(isApprovedSexActStale(req({ timing: "Tomorrow", sentAt: localIso(6, 15) }))).toBe(true);
  });

  it("uses the accepted timing-counter anchor — the reported bug: countered to Tomorrow, days ago", () => {
    // She countered "Tonight" with "Tomorrow" and it was accepted on the 5th;
    // by the 9th the Tomorrow window (anchor + 2 days) is long gone.
    expect(isApprovedSexActStale(req({
      timing: "Tomorrow",
      status: "on_deck",
      acceptedTimingCounter: TIMING_COUNTER,
      counterAcceptedAt: localIso(5, 10),
      sentAt: localIso(1, 10),
    }))).toBe(true);
  });

  it("respects a fresh restore window (restored today is not stale)", () => {
    expect(isApprovedSexActStale(req({
      timing: "Tomorrow",
      sentAt: localIso(2, 15),
      restoredAt: localIso(9, 10),
    }))).toBe(false);
  });

  it("keeps a Next week act well within its 7-day window", () => {
    expect(isApprovedSexActStale(req({ timing: "Next week", sentAt: localIso(8, 15) }))).toBe(false);
  });

  it("never marks stale when the anchor is unparseable", () => {
    expect(isApprovedSexActStale(req({
      timing: "Tonight",
      sentAt: undefined,
      createdAt: "",
      reviewedAt: undefined,
      counterAcceptedAt: undefined,
      updatedAt: "",
    }))).toBe(false);
  });
});
