"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import AppShell from "@/components/AppShell";
import AskReplyForm, { type ReplyDecisionPayload } from "@/components/AskReplyForm";
import ScreenHeader from "@/components/ScreenHeader";
import { EmptyState, ErrorState, SkeletonList } from "@/components/States";
import { combineBuiltInAndSavedActs } from "@/lib/built-in-acts";
import { splitActLabel } from "@/lib/act-label";
import { lastRequestEventAt, mutualAskHref } from "@/lib/activity";
import { currentTimingLabel, isApprovedSexActRequest, requestCounterItems, timingCopyForRequest } from "@/lib/request-state";
import {
  ApiUnauthorizedError,
  createAct,
  getActs,
  getRequestBoard,
  remindAsk,
  replyToRequest,
  updateRequestAction,
} from "@/lib/api";
import { getProfileCached } from "@/lib/profile-cache";
import { hasUnlockedRoomE2eeKey, restoreRoomE2eeSession, setRoomE2eeEnabled } from "@/lib/room-crypto";
import { useLiveRoomReload } from "@/lib/use-live-room";
import { useDayRollover } from "@/lib/use-day-rollover";
import type {
  Act,
  AuthInfo,
  DecisionItem,
  ProfileResponse,
  RequestBoardResponse,
  RequestRecord,
  Workspace,
} from "@/lib/types";

type RequestAction = "revoke" | "accept_counter" | "archive" | "pass" | "restore";
type BusyAction = RequestAction | "reply" | "remind";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unauthorized" }
  | { kind: "no-workspace" }
  | {
      kind: "ready";
      auth: AuthInfo;
      workspace: Workspace;
      board: RequestBoardResponse;
      acts: Act[];
    };

export default function AskDetailPage() {
  return (
    <Suspense fallback={<DetailShell><SkeletonList count={4} /></DetailShell>}>
      <AskDetail />
    </Suspense>
  );
}

function AskDetail() {
  const params = useSearchParams();
  const router = useRouter();
  const requestId = params.get("id") || "";
  const highlightedFromActivity = params.get("activity") === "1";
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Cheap guard so a live-room push doesn't refetch while a reload it
  // triggered is still in flight (useLiveRoomReload also debounces, but a
  // visibility flip can race with it).
  const reloadInFlight = useRef(false);

  // Fetch profile + board + acts and re-derive the ready state. `signal` only
  // gates our own setState calls below — it is deliberately NOT forwarded to
  // getProfileCached, whose in-flight promise is shared across consumers:
  // aborting it (on unmount, or a StrictMode/fast remount) would also reject
  // the fetch for whoever else joined that same promise. The board/acts
  // endpoints don't accept a signal either, so callers must still drop
  // superseded results themselves. A re-derive over a ready state replaces it
  // in place so a live push doesn't flash the loading skeleton.
  const load = useCallback(async (signal?: AbortSignal) => {
    if (reloadInFlight.current) return;
    reloadInFlight.current = true;
    try {
      const profile: ProfileResponse = await getProfileCached();
      if (signal?.aborted) return;
      if (!profile.activeWorkspace) {
        setState({ kind: "no-workspace" });
        return;
      }
      const [board, actsRes] = await Promise.all([
        getRequestBoard(profile.activeWorkspace.id),
        getActs(profile.activeWorkspace.id),
      ]);
      if (signal?.aborted) return;
      const workspace = profile.activeWorkspace;
      setState({
        kind: "ready",
        auth: profile.auth,
        workspace,
        board,
        acts: combineBuiltInAndSavedActs(actsRes.acts, workspace.id),
      });
    } finally {
      reloadInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        await load(controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiUnauthorizedError) {
          setState({ kind: "unauthorized" });
          return;
        }
        setState({ kind: "error", message: error instanceof Error ? error.message : "Couldn't load this Ask." });
      }
    })();
    return () => {
      controller.abort();
      // A StrictMode (or any fast) remount tears this mount down mid-load and
      // aborts above. Release the in-flight guard too — otherwise the
      // remount's load bails on a flag the aborted run never reached its
      // finally to clear, stranding the page on its loading skeleton.
      reloadInFlight.current = false;
    };
  }, [load]);

  // H7: surface incoming counters/replies live. The reply surface lives here,
  // so a partner's counter or reply must appear without a manual refresh. We
  // re-fetch + re-derive on a request-board push, and add a visibilitychange
  // floor so returning to a backgrounded tab also resyncs (the socket may
  // have dropped while hidden).
  const onLiveReload = useCallback(() => {
    if (state.kind !== "ready") return;
    load().catch(() => {});
  }, [load, state.kind]);

  useLiveRoomReload({
    workspaceId: state.kind === "ready" ? state.workspace.id : undefined,
    actorEmail: state.kind === "ready" ? state.auth.email : undefined,
    resources: ["request-board"],
    onReload: onLiveReload,
  });

  useEffect(() => {
    if (state.kind !== "ready") return;
    function onVisibility() {
      if (document.visibilityState === "visible") onLiveReload();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [state.kind, onLiveReload]);

  // H6: retry wired into the error ErrorState. Resets to the skeleton, then
  // re-runs the same load + error mapping as the initial mount.
  const retryLoad = useCallback(() => {
    setState({ kind: "loading" });
    load().catch((error) => {
      if (error instanceof ApiUnauthorizedError) {
        setState({ kind: "unauthorized" });
        return;
      }
      setState({ kind: "error", message: error instanceof Error ? error.message : "Couldn't load this Ask." });
    });
  }, [load]);

  async function runAction(action: RequestAction) {
    if (state.kind !== "ready" || !requestId) return;
    setBusyAction(action);
    setActionError(null);
    try {
      const result = await updateRequestAction({
        workspaceId: state.workspace.id,
        id: requestId,
        action,
      });
      if (result.revoked) {
        router.push("/sexboard");
        return;
      }
      if (action === "accept_counter") {
        router.push(mutualAskHref(
          result.request?.id || requestId,
          result.request?.categories || [],
          result.request?.matchNarration || "",
        ));
        return;
      }
      if (action === "pass") {
        router.push("/sexboard");
        return;
      }
      setState({
        ...state,
        board: {
          workspaceId: result.workspaceId,
          requests: result.requests,
          activeRequests: result.activeRequests,
          history: result.history,
        },
      });
      if (navigator.vibrate) navigator.vibrate(6);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Couldn't update this Ask.");
    } finally {
      setBusyAction(null);
    }
  }

  async function runRemind() {
    if (state.kind !== "ready" || !requestId) return;
    setBusyAction("remind");
    setActionError(null);
    try {
      const result = await remindAsk({ workspaceId: state.workspace.id, id: requestId });
      setState({
        ...state,
        board: {
          workspaceId: result.workspaceId,
          requests: result.requests,
          activeRequests: result.activeRequests,
          history: result.history,
        },
      });
      if (navigator.vibrate) navigator.vibrate(8);
    } catch (error) {
      // A too-soon tap comes back as a cooldown error — surface its gentle copy.
      setActionError(error instanceof Error ? error.message : "Couldn't send the reminder.");
    } finally {
      setBusyAction(null);
    }
  }

  async function runReply(decisions: ReplyDecisionPayload[], note: string) {
    if (state.kind !== "ready" || !requestId) return;
    setBusyAction("reply");
    setActionError(null);
    try {
      // Room Encryption: a reply in an E2EE room must be encrypted client-side,
      // which needs the room key unlocked this session. The gate normally
      // guarantees that, but the in-memory key can be dropped (full reload,
      // background relock). Mirror the create flow (ask/page.tsx runSend): re-
      // check, try to restore the session, and re-arm the passphrase gate —
      // otherwise the server silently 400s the reply and the user dead-ends.
      const requiresE2ee = Boolean(state.workspace.settings?.roomE2eeEnabled);
      if (requiresE2ee && !hasUnlockedRoomE2eeKey(state.workspace.id)) {
        const restored = await restoreRoomE2eeSession(state.workspace.id);
        if (!restored) {
          setRoomE2eeEnabled(state.workspace.id, true);
          setActionError("Unlock Room Encryption to send this reply.");
          return;
        }
      }
      const result = await replyToRequest({
        workspaceId: state.workspace.id,
        id: requestId,
        decisions,
        note,
      });
      setState({
        ...state,
        board: {
          workspaceId: result.workspaceId,
          requests: result.requests,
          activeRequests: result.activeRequests,
          history: result.history,
        },
      });
      if (navigator.vibrate) navigator.vibrate(8);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // Backstop: local E2EE state read "unlocked" but the authoritative server
      // setting still required encryption and rejected the reply. Re-arm the
      // gate so the user can unlock and resend instead of stranding the reply.
      if (/room encryption requires encrypted/i.test(message)) {
        setRoomE2eeEnabled(state.workspace.id, true);
        setActionError("Unlock Room Encryption, then send your reply again.");
      } else {
        setActionError(message || "Couldn't send this reply.");
      }
    } finally {
      setBusyAction(null);
    }
  }

  async function runCreateCounterAct(label: string) {
    if (state.kind !== "ready") throw new Error("This Ask is not ready yet.");
    const result = await createAct({
      workspaceId: state.workspace.id,
      label,
      myComfort: "curious",
    });
    setState({
      ...state,
      acts: combineBuiltInAndSavedActs(result.acts, state.workspace.id),
    });
    return result.act;
  }

  if (state.kind === "loading") return <DetailShell><SkeletonList count={4} /></DetailShell>;
  if (state.kind === "unauthorized") {
    return (
      <DetailShell>
        <ErrorState
          title="Session expired"
          body="Sign in again to open this Ask."
          action={<Link href="/" className="btn-ghost">Back to sign-in</Link>}
        />
      </DetailShell>
    );
  }
  if (state.kind === "no-workspace") {
    return (
      <DetailShell>
        <ErrorState
          title="No partner space yet"
          body="Asks are scoped to a shared space."
          action={<Link href="/space" className="btn-ghost">Open Space</Link>}
        />
      </DetailShell>
    );
  }
  if (state.kind === "error") {
    return (
      <DetailShell>
        <ErrorState
          title="Couldn't load Ask"
          body={state.message}
          action={<button type="button" className="btn-ghost" onClick={retryLoad}>Try again</button>}
        />
      </DetailShell>
    );
  }

  const request = state.board.requests.find((item) => item.id === requestId);
  if (!request) {
    return (
      <DetailShell>
        <EmptyState
          title="Ask not found"
          body="It may have been revoked, archived, or expired."
          action={<Link href="/sexboard" className="btn-ghost">Back to Sexboard</Link>}
        />
      </DetailShell>
    );
  }

  return (
    <DetailShell title="Ask detail" subtitle={statusLabel(request.status)}>
      <RequestDetail
        request={request}
        me={state.auth}
        acts={state.acts}
        busyAction={busyAction}
        actionError={actionError}
        onAction={runAction}
        onRemind={runRemind}
        onReply={runReply}
        onCreateCounterAct={runCreateCounterAct}
        highlightedFromActivity={highlightedFromActivity}
      />
    </DetailShell>
  );
}

function DetailShell({
  children,
  title = "Ask detail",
  subtitle,
}: {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
}) {
  return (
    <AppShell hideTabBar>
      <ScreenHeader
        eyebrow={
          <Link href="/sexboard" className="ask-detail-back-link pressable" aria-label="Back to Sexboard">
            <span className="ask-detail-back-arrow" aria-hidden="true">‹</span>
            <span>Back to Sexboard</span>
          </Link>
        }
        title={title}
        subtitle={subtitle}
      />
      {children}
    </AppShell>
  );
}

function RequestDetail({
  request,
  me,
  acts,
  busyAction,
  actionError,
  onAction,
  onRemind,
  onReply,
  onCreateCounterAct,
  highlightedFromActivity = false,
}: {
  request: RequestRecord;
  me: AuthInfo;
  acts: Act[];
  busyAction: BusyAction | null;
  actionError: string | null;
  onAction: (action: RequestAction) => Promise<void>;
  onRemind: () => Promise<void>;
  onReply: (decisions: ReplyDecisionPayload[], note: string) => Promise<void>;
  onCreateCounterAct: (label: string) => Promise<Act>;
  highlightedFromActivity?: boolean;
}) {
  useDayRollover();

  const mine = normalize(request.requesterEmail) === normalize(me.email);
  const fromName = mine ? "You" : (request.requesterName || request.requester || "Partner");
  const toName = mine ? (request.reviewerName || request.reviewer || "Partner") : "you";
  const counters = requestCounterItems(request);
  const hasCounter = counters.length > 0;
  const timingCopy = timingCopyForRequest(request);
  const awaitingMyReply = !mine && ["pending", "sent"].includes(request.status);
  const canRevoke = mine && ["draft", "pending", "sent"].includes(request.status);
  const canAcceptCounter = mine
    && hasCounter
    && ["reviewed", "on_deck"].includes(request.status)
    && !request.counterAcceptedAt;
  const canPassAgreed = !awaitingMyReply && isApprovedSexActRequest(request);
  const canArchive = !awaitingMyReply && !canPassAgreed && !["completed", "archived", "expired"].includes(request.status);
  const canRestore = request.status === "archived";
  // Manual "Remind": only the requester, only while the Ask is still waiting.
  // Mirror the server's 1h anti-spam cooldown so the button reflects it locally.
  const canRemind = mine && ["pending", "sent"].includes(request.status);
  const lastReminderMs = request.lastReminderAt ? Date.parse(request.lastReminderAt) : 0;
  const reminderCooldownActive = lastReminderMs > 0 && Date.now() - lastReminderMs < 60 * 60 * 1000;
  const remindedAgo = lastReminderMs > 0 ? relativeAgo(lastReminderMs) : "";

  const decisions = useMemo(() => request.decisions || [], [request.decisions]);
  const partnerFeedback = String(request.feedback || "").trim();
  const responseAuthorName = request.reviewerName || request.reviewer || (mine ? "Partner" : "You");

  return (
    <div
      className={`activity-detail-stage space-y-4 px-5 pb-24 ${highlightedFromActivity ? "is-activity-highlight" : ""}`}
      data-activity-highlight={highlightedFromActivity ? "true" : undefined}
    >
      <section className="card p-5">
        <p className="text-xs uppercase tracking-[0.14em] text-ink-3">
          {fromName} to {toName}
        </p>
        {request.categories.length ? (
          <>
            <h1 className="mt-2 font-display text-display-lg italic leading-tight text-ink">
              {request.categories.length} {request.categories.length === 1 ? "Act" : "Acts"}
            </h1>
            <ul className="ask-acts mt-4">
              {request.categories.map((label, index) => {
                const { emoji, text } = splitActLabel(label);
                return (
                  <li key={`${label}-${index}`} className="ask-act">
                    <span className="ask-act-emoji" aria-hidden="true">{emoji || "•"}</span>
                    <span className="ask-act-name">{text}</span>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <h1 className="mt-2 font-display text-display-lg italic leading-tight text-ink">
            No Acts selected
          </h1>
        )}
        <div className="mt-4 flex flex-wrap gap-1.5">
          <span className="chip">{currentTimingLabel(request)}</span>
          <span className="chip">Filming: {request.filming}</span>
          <span className="chip">{statusLabel(request.status)}</span>
        </div>
        {request.note && (
          <p className="mt-4 text-sm leading-relaxed text-ink-2">{request.note}</p>
        )}
        <p className="mt-4 text-xs text-ink-3">
          Updated {formatWhen(lastRequestEventAt(request))}
        </p>
      </section>

      {request.boundaryConflicts.length > 0 && (
        <section className="card p-4" style={{ borderColor: "rgb(var(--gold-rgb) / 0.4)" }}>
          <p className="text-xs font-semibold uppercase tracking-wide text-gold">Limits touched</p>
          <ul className="mt-2 space-y-1 text-sm text-ink-2">
            {request.boundaryConflicts.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      )}

      {(decisions.length > 0 || partnerFeedback) && (
        <section className="card p-4">
          <SectionTitle title="Partner response" />
          {partnerFeedback && (
            <div className="mt-3 rounded-[14px] border border-line bg-surface p-3">
              <p className="text-xs uppercase tracking-[0.14em] text-ink-3">Note from {responseAuthorName}</p>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">{partnerFeedback}</p>
            </div>
          )}
          {decisions.length > 0 && (
            <ul className="mt-3 space-y-2">
              {decisions.map((decision, index) => (
                <DecisionRow key={`${decision.label}-${index}`} item={decision} />
              ))}
            </ul>
          )}
        </section>
      )}

      {counters.length > 0 && (
        <section className="card p-4">
          <SectionTitle title={request.counterAcceptedAt ? "Accepted counter" : "Counter offer"} />
          <ul className="mt-3 space-y-2">
            {counters.map((counter, index) => (
              <li key={`${counter.label}-${index}`} className="rounded-[14px] border border-line bg-surface p-3">
                <p className="text-sm font-medium text-ink">{counter.label}</p>
                {counter.fromLabel && (
                  <p className="mt-1 text-xs text-ink-3">Counter for {counter.fromLabel}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {awaitingMyReply && (
        <AskReplyForm
          requestedActs={request.categories}
          requestedTiming={request.timing}
          acts={acts}
          submitting={busyAction === "reply"}
          onCreateAct={onCreateCounterAct}
          onSubmit={onReply}
        />
      )}

      {actionError && (
        <p className="text-sm" style={{ color: "rgb(var(--no-rgb))" }} role="alert" aria-live="assertive">{actionError}</p>
      )}

      {canPassAgreed && (
        <section className="card p-5" style={{ borderColor: "rgb(var(--accent-rgb) / 0.45)" }}>
          <p className="text-xs font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--accent)" }}>It&rsquo;s on</p>
          <h2 className="mt-2 font-display text-display-md italic leading-tight text-ink">Both of you said yes.</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">This Ask is agreed. Pass on it below if {timingCopy} changes.</p>
          <Link
            href={mutualAskHref(request.id, request.categories || [], request.matchNarration || "")}
            className="btn-primary w-full mt-4"
          >
            See the match
          </Link>
        </section>
      )}

      {canRemind && (
        <section className="card p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-3">Waiting on {toName}</p>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">
            {reminderCooldownActive
              ? `Reminded ${remindedAgo}. They'll get nudged again automatically if it keeps waiting.`
              : `Give ${toName} a nudge to come take a look — it sends a quiet notification.`}
          </p>
          <button
            type="button"
            className="btn-primary w-full mt-4"
            disabled={!!busyAction || reminderCooldownActive}
            onClick={onRemind}
            data-testid="ask-action-remind"
          >
            {busyAction === "remind"
              ? "Sending reminder…"
              : reminderCooldownActive
                ? `Reminded ${remindedAgo}`
                : `Remind ${toName}`}
          </button>
        </section>
      )}

      {(canRevoke || canAcceptCounter || canPassAgreed || canArchive || canRestore) && (
        <section className="space-y-2">
          {canAcceptCounter && (
            <button
              type="button"
              className="btn-primary w-full"
              disabled={!!busyAction}
              onClick={() => onAction("accept_counter")}
              data-testid="ask-action-accept-counter"
            >
              {busyAction === "accept_counter" ? "Accepting..." : "Accept counter"}
            </button>
          )}
          {canPassAgreed && (
            <button
              type="button"
              className="btn-ghost w-full"
              disabled={!!busyAction}
              onClick={() => onAction("pass")}
              data-testid="ask-action-pass"
            >
              {busyAction === "pass" ? "Passing..." : `Pass ${timingCopy}`}
            </button>
          )}
          {canRevoke && (
            <button
              type="button"
              className="btn-ghost w-full"
              disabled={!!busyAction}
              onClick={() => onAction("revoke")}
              data-testid="ask-action-revoke"
            >
              {busyAction === "revoke" ? "Taking it back..." : "Take back this Ask"}
            </button>
          )}
          {canArchive && !canRevoke && (
            <button
              type="button"
              className="btn-ghost w-full"
              disabled={!!busyAction}
              onClick={() => onAction("archive")}
              data-testid="ask-action-archive"
            >
              {busyAction === "archive" ? "Archiving..." : "Archive"}
            </button>
          )}
          {canRestore && (
            <button
              type="button"
              className="btn-ghost w-full"
              disabled={!!busyAction}
              onClick={() => onAction("restore")}
              data-testid="ask-action-restore"
            >
              {busyAction === "restore" ? "Restoring..." : "Restore to Sexboard"}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

function SectionTitle({ title }: { title: string }) {
  return <h2 className="font-display text-lg italic text-ink">{title}</h2>;
}

function DecisionRow({ item }: { item: DecisionItem }) {
  return (
    <li className="rounded-[14px] border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-ink">{item.label}</p>
        <span className="chip">{item.decision || "Reply"}</span>
      </div>
      {item.counter && (
        <p className="mt-2 text-sm leading-relaxed text-ink-2">Counter: {item.counter}</p>
      )}
      {item.note && (
        <p className="mt-2 text-sm leading-relaxed text-ink-2">{item.note}</p>
      )}
    </li>
  );
}

function normalize(value: string) {
  return String(value || "").trim().toLowerCase();
}

function relativeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function statusLabel(status: RequestRecord["status"]): string {
  switch (status) {
    case "pending":   return "pending review";
    case "sent":      return "sent";
    case "reviewed":  return "reviewed";
    case "on_deck":   return "on Sexboard";
    case "completed": return "done";
    case "expired":   return "expired";
    case "archived":  return "archived";
    case "draft":     return "draft";
    default:          return status;
  }
}

function formatWhen(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = Date.now() - date.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
