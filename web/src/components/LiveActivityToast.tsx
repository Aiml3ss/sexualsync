"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clearActivity, dismissActivityItems, getActivity, markActivityRead } from "@/lib/api";
import { OFFLINE_WRITE_DROPPED_EVENT, type DroppedOfflineWriteDetail } from "@/lib/offline-queue";
import { getProfileCached } from "@/lib/profile-cache";
import type { ActivityItem, ActivityResource, ActivityResponse } from "@/lib/types";
import {
  ACTIVITY_RESOURCE_GLYPHS,
  activityHref,
  compactActivityRows,
  dedupeActivity,
  groupActivityByDay,
  mutualAskHref,
  publishActivitySummary,
  textForActivityEvent,
} from "@/lib/activity";
import {
  LIVE_ROOM_EVENT,
  type LiveRoomEventDetail,
} from "@/lib/use-live-room";

interface Notice {
  id: string;
  text: string;
}

const MAX_ACTIVITY_ROWS = 8;
// Collapse repeated live toasts for the same item by the same person within this
// window into one — e.g. a partner changing their reaction emoji on one kink a
// few times shouldn't pop a toast per change.
const TOAST_DEDUP_MS = 15_000;

export function LiveApprovalSplashRedirect() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    function onRoomEvent(event: Event) {
      const detail = (event as CustomEvent<LiveRoomEventDetail>).detail;
      if (
        detail?.resource === "request-board" &&
        detail?.action === "counter_accepted" &&
        pathname !== "/mutual"
      ) {
        router.push(mutualAskHref(detail.entityId || ""));
      }
    }

    window.addEventListener(LIVE_ROOM_EVENT, onRoomEvent);
    return () => {
      window.removeEventListener(LIVE_ROOM_EVENT, onRoomEvent);
    };
  }, [pathname, router]);

  return null;
}

export default function LiveActivityToast() {
  const pathname = usePathname();
  const disabled = pathname === "/sexboard";
  const [notices, setNotices] = useState<Notice[]>([]);
  // Ref, not state: refreshSummary reading workspaceId from state made its
  // useCallback identity change when the mount effect set the id, re-running
  // that effect → a second getProfile + getActivity on EVERY mount (and
  // AppShell mounts per navigation). The ref keeps refreshSummary stable.
  const workspaceIdRef = useRef("");
  // Tracks the last toast time per "resource:entityId:actor" so a burst of
  // updates to the same item collapses into a single toast.
  const recentToastsRef = useRef<Map<string, number>>(new Map());

  const refreshSummary = useCallback(async (nextWorkspaceId?: string) => {
    const id = nextWorkspaceId || workspaceIdRef.current;
    if (!id) return null;
    const next = await getActivity(id);
    publishActivitySummary(next.unreadByResource || {});
    return next;
  }, []);

  const pushNotice = useCallback((text: string, ttlMs = 3600) => {
    const notice = { id: makeId(), text };
    // Append without truncating the rendered queue: each notice must survive
    // long enough under its live region to be announced, and removes itself
    // via its own timeout below.
    setNotices((current) => [...current, notice]);
    window.setTimeout(() => {
      setNotices((current) => current.filter((item) => item.id !== notice.id));
    }, ttlMs);
  }, []);

  useEffect(() => {
    if (disabled) return;
    let alive = true;
    // Cached profile read — AppShell mounts this on every navigation, and the
    // raw getProfile bypassed the 30s dedupe cache built for exactly this.
    getProfileCached()
      .then(async (profile) => {
        if (!alive) return;
        const nextWorkspaceId = profile.activeWorkspaceId || profile.activeWorkspace?.id || "";
        workspaceIdRef.current = nextWorkspaceId;
        if (nextWorkspaceId) await refreshSummary(nextWorkspaceId);
      })
      .catch(() => {
        publishActivitySummary({});
      });

    return () => {
      alive = false;
    };
  }, [disabled, refreshSummary]);

  useEffect(() => {
    if (disabled) return;
    function onRoomEvent(event: Event) {
      const detail = (event as CustomEvent<LiveRoomEventDetail>).detail;
      if (!detail?.passive) {
        const text = textForActivityEvent(detail?.resource, detail?.action);
        if (text && !recentlyToasted(recentToastsRef.current, detail)) pushNotice(text);
      }
      window.setTimeout(() => {
        refreshSummary().catch(() => {});
      }, 450);
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        refreshSummary().catch(() => {});
      }
    }

    window.addEventListener(LIVE_ROOM_EVENT, onRoomEvent);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener(LIVE_ROOM_EVENT, onRoomEvent);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [disabled, refreshSummary, pushNotice]);

  // A queued offline write that was discarded (boundary conflict, signed out)
  // must be surfaced wherever the user is — including the Sexboard, where the
  // activity toasts are otherwise disabled. Longer TTL: this one is news.
  useEffect(() => {
    function onDroppedWrite(event: Event) {
      const detail = (event as CustomEvent<DroppedOfflineWriteDetail>).detail;
      if (detail?.reason) pushNotice(detail.reason, 8000);
    }
    window.addEventListener(OFFLINE_WRITE_DROPPED_EVENT, onDroppedWrite);
    return () => {
      window.removeEventListener(OFFLINE_WRITE_DROPPED_EVENT, onDroppedWrite);
    };
  }, [pushNotice]);

  if (!notices.length) return null;

  return (
    <div className="live-activity-stack">
      {notices.map((notice) => (
        <div className="live-activity-toast" role="status" aria-live="polite" key={notice.id}>
          <span className="live-activity-dot" aria-hidden="true" />
          <span>{notice.text}</span>
        </div>
      ))}
    </div>
  );
}

export function LiveActivitySection({
  workspaceId,
  myEmail,
  partnerName,
  partnerLastSeen = "",
  initialActivity = null,
  refreshOnRoomEvent = true,
}: {
  workspaceId: string;
  myEmail: string;
  partnerName: string;
  partnerLastSeen?: string | null;
  initialActivity?: ActivityResponse | null;
  refreshOnRoomEvent?: boolean;
}) {
  const [activity, setActivity] = useState<ActivityResponse | null>(initialActivity);
  const [loading, setLoading] = useState(!initialActivity);
  const [markingRead, setMarkingRead] = useState(false);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());

  const refreshActivity = useCallback(async () => {
    if (!workspaceId) return null;
    const next = await getActivity(workspaceId);
    setActivity(next);
    publishActivitySummary(next.unreadByResource || {});
    return next;
  }, [workspaceId]);

  useEffect(() => {
    // Re-seed local activity state when the parent supplies a fresher
    // initialActivity for the current workspace (e.g. after a route change).
    if (initialActivity && initialActivity.workspaceId === workspaceId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActivity(initialActivity);
      setLoading(false);
      publishActivitySummary(initialActivity.unreadByResource || {});
    }
  }, [initialActivity, workspaceId]);

  useEffect(() => {
    if (activity?.workspaceId === workspaceId) {
      // Already have the right workspace cached — flush loading + summary.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      publishActivitySummary(activity.unreadByResource || {});
      return;
    }
    let alive = true;
    setLoading(true);
    refreshActivity()
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // Only fires when the active workspace changes — the activity.* reads
    // inside the early-return branch are intentionally not deps; adding them
    // would re-fetch on every cached-activity update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshActivity, workspaceId]);

  useEffect(() => {
    if (!refreshOnRoomEvent) return;
    function onRoomEvent() {
      window.setTimeout(() => {
        refreshActivity().catch(() => {});
      }, 500);
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        refreshActivity().catch(() => {});
      }
    }

    window.addEventListener(LIVE_ROOM_EVENT, onRoomEvent);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener(LIVE_ROOM_EVENT, onRoomEvent);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshActivity, refreshOnRoomEvent]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        refreshActivity().catch(() => {});
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [refreshActivity]);

  const partnerFirstName = firstName(partnerName) || "Partner";
  const items = useMemo(() => {
    return compactActivityRows(dedupeActivity((activity?.items || [])
      .filter((item) => !sameEmail(item.actorEmail, myEmail))
      .filter((item) => !dismissedIds.has(item.id))
    )).slice(0, MAX_ACTIVITY_ROWS);
  }, [activity?.items, dismissedIds, myEmail]);
  const groupedItems = useMemo(() => groupActivityByDay(items), [items]);
  const unreadTotal = activity?.unreadTotal || 0;
  const lastActiveLine = activityStatusLine(items[0]?.at || "", partnerLastSeen || "", partnerFirstName);

  // "Mark read" empties the box: mark everything read AND clear every row (not
  // just the unread ones), so a single tap leaves a clean inbox-zero state.
  // markResourceRead (row open) still does the lighter mark-read-only path.
  async function markVisibleRead() {
    if (!workspaceId || markingRead) return;
    setMarkingRead(true);
    try {
      const next = await clearActivity({ workspaceId });
      setActivity(next);
      publishActivitySummary(next.unreadByResource || {});
    } catch {
      // Best effort; it will refresh on the next room event or app focus.
    } finally {
      setMarkingRead(false);
    }
  }

  function markResourceRead(resource: ActivityResource) {
    if (!workspaceId) return;
    markActivityRead({ workspaceId, resource })
      .then((next) => {
        setActivity(next);
        publishActivitySummary(next.unreadByResource || {});
      })
      .catch(() => {});
  }

  function dismissItem(item: ActivityItem) {
    const ids = item.sourceIds?.length ? item.sourceIds : [item.id];
    setDismissedIds((current) => {
      const next = new Set(current);
      next.add(item.id);
      ids.forEach((id) => next.add(id));
      return next;
    });
    if (!workspaceId) return;
    dismissActivityItems({ workspaceId, ids })
      .then((next) => {
        setActivity(next);
        publishActivitySummary(next.unreadByResource || {});
      })
      .catch(() => {
        if (item.unread) markResourceRead(item.resource);
      });
  }

  return (
    <section className="sexboard-activity-card" aria-label={`${possessiveName(partnerFirstName)} Activity`}>
      <div className="sexboard-activity-head">
        <div>
          <p className="eyebrow">Live room</p>
          <h2>{possessiveName(partnerFirstName)} Activity</h2>
          <p className="sexboard-activity-last">{lastActiveLine}</p>
        </div>
        <button
          type="button"
          className="live-activity-read-btn pressable"
          onClick={markVisibleRead}
          disabled={!items.length || markingRead}
        >
          Mark read
        </button>
      </div>

      <p className="sexboard-activity-summary">
        {unreadTotal
          ? `${unreadTotal} unread update${unreadTotal === 1 ? "" : "s"} from ${partnerFirstName}.`
          : `Quick view of what ${partnerFirstName} has been doing in the app.`}
      </p>

      <div className="live-activity-list sexboard-activity-list">
        {loading ? (
          <LiveActivitySkeleton />
        ) : groupedItems.length ? groupedItems.map((group) => (
          <div className="live-activity-group" key={group.label}>
            <p className="live-activity-group-label">{group.label}</p>
            <div className="live-activity-group-list">
              {group.items.map((item) => (
                <ActivityRow
                  key={item.id}
                  item={item}
                  myEmail={myEmail}
                  fallbackActorName={partnerFirstName}
                  onOpen={() => markResourceRead(item.resource)}
                  onDismiss={() => dismissItem(item)}
                />
              ))}
            </div>
          </div>
        )) : (
          <p className="live-activity-empty">
            {`${partnerFirstName}'s saves, reactions, reveals, Pile locks, and Blind Reveal moves will collect here.`}
          </p>
        )}
      </div>
    </section>
  );
}

function ActivityRow({
  item,
  myEmail,
  fallbackActorName,
  onOpen,
  onDismiss,
}: {
  item: ActivityItem;
  myEmail: string;
  fallbackActorName: string;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const startX = useRef<number | null>(null);
  const swiped = useRef(false);
  const [dragX, setDragX] = useState(0);
  const [swipeStarted, setSwipeStarted] = useState(false);
  const actor = sameEmail(item.actorEmail, myEmail) ? "You" : (firstName(item.actorName) || fallbackActorName || "Partner");
  const meta = item.groupedCount && item.groupedCount > 1
    ? `${item.groupedCount} updates - ${item.resourceLabel}`
    : item.action === "focused" ? "heat signal"
    : item.passive ? "quick view" : item.resourceLabel;
  const clampedDragX = Math.max(-104, Math.min(104, dragX));
  const swipeActive = swipeStarted && Math.abs(clampedDragX) > 6;
  const swipeReady = Math.abs(clampedDragX) >= 54;

  function startSwipe(clientX: number) {
    startX.current = clientX;
    swiped.current = false;
    setSwipeStarted(true);
    setDragX(0);
  }

  function moveSwipe(clientX: number) {
    if (startX.current === null) return;
    const moved = clientX - startX.current;
    if (Math.abs(moved) > 8) swiped.current = true;
    setDragX(Math.max(-104, Math.min(104, moved)));
  }

  function finishSwipe(clientX: number) {
    if (startX.current === null) return;
    const moved = clientX - startX.current;
    startX.current = null;
    setSwipeStarted(false);
    setDragX(0);
    if (Math.abs(moved) < 54) return;
    onDismiss();
  }

  function cancelSwipe() {
    startX.current = null;
    setSwipeStarted(false);
    setDragX(0);
  }

  return (
    <span
      className={[
        "live-activity-swipe-wrap",
        swipeActive ? "is-swiping" : "",
        swipeReady ? "is-ready" : "",
        clampedDragX > 0 ? "is-right" : "is-left",
      ].filter(Boolean).join(" ")}
    >
      <span className="live-activity-swipe-indicator" aria-hidden="true">
        <span className="live-activity-swipe-icon">✓</span>
        <span>Mark read</span>
      </span>
      <Link
        className={`live-activity-item pressable ${item.unread ? "is-unread" : ""} ${item.passive ? "is-passive" : ""}`}
        href={activityHref(item)}
        style={{ transform: `translateX(${clampedDragX}px)` }}
        onPointerDown={(event) => {
          startSwipe(event.clientX);
        }}
        onPointerMove={(event) => moveSwipe(event.clientX)}
        onPointerUp={(event) => finishSwipe(event.clientX)}
        onPointerCancel={(event) => {
          if (event.pointerType !== "touch") cancelSwipe();
        }}
        onTouchStart={(event) => {
          const touch = event.touches[0];
          if (touch) startSwipe(touch.clientX);
        }}
        onTouchMove={(event) => {
          const touch = event.touches[0];
          if (touch) moveSwipe(touch.clientX);
        }}
        onTouchEnd={(event) => {
          const touch = event.changedTouches[0];
          if (touch) finishSwipe(touch.clientX);
        }}
        onTouchCancel={cancelSwipe}
        onClick={(event) => {
          if (swiped.current) {
            event.preventDefault();
            swiped.current = false;
            return;
          }
          onOpen();
        }}
      >
        <span className="live-activity-glyph" aria-hidden="true">{ACTIVITY_RESOURCE_GLYPHS[item.resource]}</span>
        <span className="live-activity-main">
          <span className="live-activity-title">{item.label}</span>
          <span className="live-activity-meta">{actor} - {meta}</span>
        </span>
        <span className="live-activity-time">{timeLabel(item.at)}</span>
      </Link>
      <button
        type="button"
        className="live-activity-dismiss pressable"
        aria-label={`Dismiss: ${item.label}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          onDismiss();
        }}
      >
        <span aria-hidden="true">✓</span>
      </button>
    </span>
  );
}

function LiveActivitySkeleton() {
  return (
    <div className="live-activity-skeleton-list" aria-label="Loading activity">
      {[0, 1, 2].map((item) => (
        <span className="live-activity-skeleton-row" key={item} aria-hidden="true" />
      ))}
    </div>
  );
}

function firstName(value?: string) {
  return String(value || "").trim().split(/\s+/)[0] || "";
}

function possessiveName(value: string) {
  return value.endsWith("s") ? `${value}'` : `${value}'s`;
}

function sameEmail(a?: string, b?: string) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// True when a toast for this same item + actor already fired within the dedup
// window (so we skip this one). Records the time when it returns false — i.e.
// when a toast is about to fire. Only item-scoped events (with an entityId) are
// de-duped; everything else always toasts.
function recentlyToasted(recent: Map<string, number>, detail: LiveRoomEventDetail | undefined): boolean {
  const entityId = detail?.entityId || "";
  if (!entityId) return false;
  const key = `${detail?.resource || ""}:${entityId}:${(detail?.actorEmail || "").toLowerCase()}`;
  const now = Date.now();
  const last = recent.get(key) || 0;
  if (now - last <= TOAST_DEDUP_MS) return true;
  recent.set(key, now);
  if (recent.size > 64) {
    for (const [key2, at] of recent) {
      if (now - at > TOAST_DEDUP_MS) recent.delete(key2);
    }
  }
  return false;
}

function timeLabel(value: string) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "";
  const diff = Math.max(0, Date.now() - time);
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(time);
}

function activityStatusLine(activityAt: string, partnerLastSeen: string, partnerFirstName: string) {
  const activityTime = new Date(activityAt || "").getTime();
  const presenceTime = new Date(partnerLastSeen || "").getTime();
  const latest = Math.max(
    Number.isFinite(activityTime) ? activityTime : 0,
    Number.isFinite(presenceTime) ? presenceTime : 0
  );
  if (!latest) return `Waiting for ${partnerFirstName}'s first signal.`;
  return `${partnerFirstName} active ${longTimeLabel(latest)}`;
}

function longTimeLabel(time: number) {
  const diff = Math.max(0, Date.now() - time);
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(time);
}
