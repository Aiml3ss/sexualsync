"use client";

/**
 * Sexboard body — every component below the route shell:
 * NoWorkspaceView / WaitingOnPartner / PendingInviteBanner / TonightBoard
 * / HandoffSection / HandoffRow, plus the handoff-builder helpers that
 * shape `LoadState` into the renderable handoff items.
 *
 * Extracted from page.tsx as part of H-2 so the route shell stays a
 * thin wrapper around state + reload + AppShell.
 */

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { syncAppBadge } from "@/lib/app-badge";
import { LiveActivitySection } from "@/components/LiveActivityToast";
import { ErrorState, SkeletonList } from "@/components/States";
import WaitingForPartner from "@/components/WaitingForPartner";
import PartnerTurnOns from "@/components/PartnerTurnOns";
import SharedDesires from "@/components/SharedDesires";
import { acceptInvite, declineInvite } from "@/lib/api";
import { mutualAskHref } from "@/lib/activity";
import { useDayRollover } from "@/lib/use-day-rollover";
import type {
  AuthInfo,
  BlindReveal,
  GameRoundStatus,
  KinkIdea,
  PendingInvite,
  PileSession,
  PileView,
  RequestRecord,
  Workspace,
} from "@/lib/types";
import { isFromPartner, partnerOf, rankActive } from "@/lib/workspace";
import {
  approvedRequestBody,
  blindRevealHasTwoAnswers,
  compactScheduledLabel,
  currentTimingLabel,
  friendlyDateLabel,
  hasPendingRequestCounter,
  hasJoinedPartner,
  isApprovedSexActRequest,
  isApprovedSexActStale,
  isStalePendingAsk,
  kinkReviewHref,
  requestTitle,
  safeDateMs,
  scheduledLabel,
  sharedKinksHref,
  statusLabel,
  unansweredKinksFor,
} from "./_sexboard-helpers";
import { PresenceBand, PulseWaves } from "./_sexboard-presence";
import type { HandoffItem, HandoffSummary, LoadState } from "./_sexboard-types";

const DASHBOARD_COPY = "Check here for live reveals, active requests, and anything that needs your response.";

export function Body({
  state,
  removingPileSessionId,
  viewedLockedPileSessionIds,
  viewedLockedBlindRevealIds,
  onRemoveLockedPile,
  onViewLockedPile,
  onViewLockedBlindReveal,
}: {
  state: LoadState;
  removingPileSessionId: string;
  viewedLockedPileSessionIds: Set<string>;
  viewedLockedBlindRevealIds: Set<string>;
  onRemoveLockedPile: (sessionId: string) => void;
  onViewLockedPile: (sessionId: string) => void;
  onViewLockedBlindReveal: (revealId: string) => void;
}) {
  const dayTick = useDayRollover();

  if (state.kind === "loading") return <SkeletonList count={3} />;
  if (state.kind === "unauthorized") {
    return (
      <ErrorState
        title="Session expired"
        body="Sign in again to see your Sexboard."
        action={
          <Link href="/" className="btn-ghost">Back to sign-in</Link>
        }
      />
    );
  }
  if (state.kind === "error") {
    return (
      <ErrorState
        title="Couldn't load Sexboard"
        body={state.message || "Something went sideways. Try again."}
      />
    );
  }
  if (state.kind === "no-workspace") {
    return <NoWorkspaceView pendingInvites={state.pendingInvites} />;
  }

  const partnerJoined = hasJoinedPartner(state.workspace, state.auth.email);
  if (!partnerJoined) {
    return (
      <WaitingOnPartner
        workspace={state.workspace}
        pendingInvites={state.pendingInvites}
      />
    );
  }

  return (
    <>
      {state.pendingInvites.length > 0 && (
        <div className="sexboard-pending-banner-wrap">
          <PendingInviteBanner invite={state.pendingInvites[0]} mode="ready" />
        </div>
      )}
      <TonightBoard
        state={state}
        dayTick={dayTick}
        removingPileSessionId={removingPileSessionId}
        viewedLockedPileSessionIds={viewedLockedPileSessionIds}
        viewedLockedBlindRevealIds={viewedLockedBlindRevealIds}
        onRemoveLockedPile={onRemoveLockedPile}
        onViewLockedPile={onViewLockedPile}
        onViewLockedBlindReveal={onViewLockedBlindReveal}
      />
    </>
  );
}

function NoWorkspaceView({ pendingInvites }: { pendingInvites: PendingInvite[] }) {
  if (pendingInvites.length > 0) {
    return (
      <div className="sexboard-waiting-shell">
        <PendingInviteBanner invite={pendingInvites[0]} mode="no-workspace" />
      </div>
    );
  }
  return (
    <div className="sexboard-waiting-shell">
      <RoomSyncMark mode="create" />
      <h2 className="sexboard-waiting-title">Set up your room.</h2>
      <p className="sexboard-waiting-body">A private space for two &mdash; you and one other person. Takes a minute.</p>
      <div className="sexboard-waiting-actions">
        <Link href="/onboarding" className="btn-primary sexboard-waiting-cta">Create my room</Link>
      </div>
    </div>
  );
}

function WaitingOnPartner({
  workspace,
  pendingInvites,
}: {
  workspace: Workspace;
  pendingInvites: PendingInvite[];
}) {
  return (
    <>
      {pendingInvites.length > 0 && (
        <div className="sexboard-pending-banner-wrap">
          <PendingInviteBanner invite={pendingInvites[0]} mode="ready" />
        </div>
      )}
      <WaitingForPartner workspace={workspace} />
    </>
  );
}

function RoomSyncMark({ mode }: { mode: "create" | "waiting" }) {
  return (
    <div className="sexboard-waiting-orb" data-mode={mode} aria-hidden="true">
      <svg className="sexboard-waiting-wave" viewBox="0 0 160 112" fill="none" focusable="false">
        <path className="sexboard-waiting-wave-back" pathLength={1} d="M 18 42 C 42 14 62 14 80 42 C 98 70 118 70 142 42" />
        <path className="sexboard-waiting-wave-line" pathLength={1} d="M 18 42 C 42 14 62 14 80 42 C 98 70 118 70 142 42" />
        <path className="sexboard-waiting-wave-sweep" pathLength={1} d="M 18 42 C 42 14 62 14 80 42 C 98 70 118 70 142 42" />
        <path className="sexboard-waiting-wave-back is-lower" pathLength={1} d="M 18 70 C 42 42 62 42 80 70 C 98 98 118 98 142 70" />
        <path className="sexboard-waiting-wave-line is-lower" pathLength={1} d="M 18 70 C 42 42 62 42 80 70 C 98 98 118 98 142 70" />
        <path className="sexboard-waiting-wave-sweep is-lower" pathLength={1} d="M 18 70 C 42 42 62 42 80 70 C 98 98 118 98 142 70" />
        <circle className="sexboard-waiting-spark a" cx="80" cy="24" r="1.8" />
        <circle className="sexboard-waiting-spark b" cx="41" cy="58" r="1.45" />
        <circle className="sexboard-waiting-spark c" cx="119" cy="87" r="1.45" />
      </svg>
    </div>
  );
}

function PendingInviteBanner({ invite, mode }: { invite: PendingInvite; mode: "ready" | "no-workspace" }) {
  const [busy, setBusy] = useState<"" | "accept" | "decline">("");
  const [error, setError] = useState<string | null>(null);
  const inviter = invite.inviterName?.split(" ")[0] || "Someone";
  const room = invite.workspaceName || "their room";

  async function handle(action: "accept" | "decline") {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      if (action === "accept") {
        await acceptInvite(invite.id);
        window.location.assign("/welcome");
      } else {
        await declineInvite(invite.id);
        window.location.reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update this invite.");
      setBusy("");
    }
  }

  return (
    <div className="sexboard-pending-banner" role="region" aria-label="Pending invite">
      <p className="sexboard-pending-eyebrow">New invite</p>
      <h2 className="sexboard-pending-title">{inviter} invited you to {mode === "no-workspace" ? "a private room" : "their room"}</h2>
      <p className="sexboard-pending-body">
        {mode === "no-workspace"
          ? `Accepting puts you in ${room} with ${inviter}.`
          : `If you accept, you'll move into ${room}. Your current empty room here gets closed.`}
      </p>
      {error && <p className="sexboard-pending-error" role="alert">{error}</p>}
      <div className="sexboard-pending-row">
        <button type="button" className="sexboard-pending-accept" disabled={Boolean(busy)} onClick={() => void handle("accept")}>
          {busy === "accept" ? "Accepting..." : "Accept & move in"}
        </button>
        <button type="button" className="sexboard-pending-decline" disabled={Boolean(busy)} onClick={() => void handle("decline")}>
          {busy === "decline" ? "Declining..." : "Not now"}
        </button>
      </div>
    </div>
  );
}

// Mirrors the "Needs you" count onto the PWA home-screen icon badge whenever the
// Sexboard (the app's default landing surface) is mounted, so opening the app
// reconciles the badge to reality. No-op off-PWA / on browsers without the
// Badging API. Live updates while the app is closed land via the service-worker
// push path (it reads a `badge` count from the payload), tracked separately.
function BadgeSync({ count }: { count: number }) {
  useEffect(() => { syncAppBadge(count); }, [count]);
  return null;
}

function TonightBoard({
  state,
  dayTick,
  removingPileSessionId,
  viewedLockedPileSessionIds,
  viewedLockedBlindRevealIds,
  onRemoveLockedPile,
  onViewLockedPile,
  onViewLockedBlindReveal,
}: {
  state: Extract<LoadState, { kind: "ready" }>;
  dayTick: number;
  removingPileSessionId: string;
  viewedLockedPileSessionIds: Set<string>;
  viewedLockedBlindRevealIds: Set<string>;
  onRemoveLockedPile: (sessionId: string) => void;
  onViewLockedPile: (sessionId: string) => void;
  onViewLockedBlindReveal: (revealId: string) => void;
}) {
  // Derive the handoff summary from state plus day-rollover ticks. A Remove
  // click should not rebuild unrelated handoff arrays under live-room churn.
  const summary = useMemo(
    () => handoffSummaryFor(state, viewedLockedPileSessionIds, viewedLockedBlindRevealIds),
    [state, viewedLockedPileSessionIds, viewedLockedBlindRevealIds, dayTick],
  );
  const {
    ranked,
    activeGamesCount,
    latestPile,
    latestBlindReveal,
    kinksNeedingMe,
    handoffs,
    needsCount,
    waitingCount,
    partnerName,
  } = summary;
  const dashboardState = sexboardDashboardState(ranked, state.auth, Boolean(activeGamesCount), kinksNeedingMe.length, latestPile, latestBlindReveal);
  const pulseState = pulseStateFor(dashboardState);
  // { pre, accent, post } so the key phrase renders in the editorial <em>
  // (italic, accent-colored). The reassembled text is identical to before.
  const headline = useMemo<{ pre: string; accent: string; post: string }>(() => (
    kinksNeedingMe.length && needsCount === 1
      ? { pre: "", accent: `${kinksNeedingMe.length} kink${kinksNeedingMe.length === 1 ? "" : "s"}`, post: " need your response." }
      : needsCount === 0
      ? waitingCount === 0
        ? handoffs.locked.length
          ? { pre: "Tonight is ", accent: "locked in.", post: "" }
          : { pre: "You're ", accent: "caught up.", post: "" }
        : waitingCount === 1
          ? { pre: "Waiting on ", accent: `${partnerName}.`, post: "" }
          : { pre: "", accent: `${waitingCount} things`, post: ` waiting on ${partnerName}.` }
      : needsCount === 1
      ? { pre: "", accent: "1 thing", post: " needs a response." }
      : { pre: "", accent: `${needsCount} things`, post: " need a response." }
  ), [kinksNeedingMe.length, needsCount, waitingCount, handoffs.locked.length, partnerName]);
  // Stabilize the parent's remove handler so the Locked-in section's React.memo
  // only re-renders when its own items / removing flag actually change.
  const handleRemoveLockedPile = useCallback(
    (sessionId: string) => onRemoveLockedPile(sessionId),
    [onRemoveLockedPile],
  );
  const handleViewLockedPile = useCallback(
    (sessionId: string) => onViewLockedPile(sessionId),
    [onViewLockedPile],
  );
  const handleViewLockedBlindReveal = useCallback(
    (revealId: string) => onViewLockedBlindReveal(revealId),
    [onViewLockedBlindReveal],
  );
  const lockedSection = useMemo(() => (
    handoffs.locked.length ? (
      <HandoffSection
        title="Locked in"
        emptyEyebrow=""
        emptyTitle=""
        emptyBody=""
        items={handoffs.locked}
        removingPileSessionId={removingPileSessionId}
        onRemoveLockedPile={handleRemoveLockedPile}
        onViewLockedPile={handleViewLockedPile}
        onViewLockedBlindReveal={handleViewLockedBlindReveal}
      />
    ) : null
  ), [handoffs.locked, removingPileSessionId, handleRemoveLockedPile, handleViewLockedPile, handleViewLockedBlindReveal]);

  return (
    <section className="dashboard-home" data-dashboard-state={dashboardState}>
      <BadgeSync count={handoffs.needsYou.length} />
      <article className="card pulse-card sexboard-card sexboard-handoff-card" data-pulse-state={pulseState} aria-label="Sexboard">
        <PresenceBand workspace={state.workspace} auth={state.auth} presence={state.presence} />

        <section className="sexboard-wave-panel" aria-label="Sexboard status">
          <PulseWaves state={pulseState} synced={dashboardState === "tonight"} />
          <div className="sexboard-status-copy">
            <h2>{headline.pre}<em>{headline.accent}</em>{headline.post}</h2>
            <p>{DASHBOARD_COPY}</p>
          </div>
        </section>

        {!handoffs.needsYou.length ? lockedSection : null}

        <HandoffSection
          title="Needs you"
          attention
          emptyEyebrow="All clear"
          emptyTitle="Nothing needs your response"
          emptyBody="New requests, reveals, and kink responses will show here."
          items={handoffs.needsYou}
        />

        {handoffs.needsYou.length ? lockedSection : null}

        <HandoffSection
          title={`Waiting on ${partnerName}`}
          emptyEyebrow="Nothing sent"
          emptyTitle={`Nothing waiting on ${partnerName}`}
          emptyBody={`Asks, Pile lists, and kinks you send to ${partnerName} will show here.`}
          items={handoffs.waiting}
        />
      </article>

      <SharedDesires workspaceId={state.workspace.id} />

      <PartnerTurnOns workspaceId={state.workspace.id} />

      <LiveActivitySection
        workspaceId={state.workspace.id}
        myEmail={state.auth.email}
        partnerName={partnerName}
        partnerLastSeen={state.presence?.partner?.lastSeen || ""}
        initialActivity={state.activity}
        refreshOnRoomEvent={false}
      />
    </section>
  );
}

const HandoffSection = memo(function HandoffSection({
  title,
  attention = false,
  emptyEyebrow,
  emptyTitle,
  emptyBody,
  items,
  removingPileSessionId = "",
  onRemoveLockedPile,
  onViewLockedPile,
  onViewLockedBlindReveal,
}: {
  title: string;
  attention?: boolean;
  emptyEyebrow: string;
  emptyTitle: string;
  emptyBody: string;
  items: HandoffItem[];
  removingPileSessionId?: string;
  onRemoveLockedPile?: (sessionId: string) => void;
  onViewLockedPile?: (sessionId: string) => void;
  onViewLockedBlindReveal?: (revealId: string) => void;
}) {
  const sectionClass = `sexboard-handoff-section ${attention && items.length ? "is-attention" : ""}`;
  return (
    <section className={sectionClass} aria-label={title}>
      <div className="sexboard-section-head">
        <span>{title}</span>
      </div>
      {items.length ? (
        <div className="sexboard-handoff-list">
          {items.map((item) => (
            <HandoffRow
              key={item.id}
              item={item}
              removing={Boolean(item.removeSessionId && removingPileSessionId === item.removeSessionId)}
              onRemoveLockedPile={onRemoveLockedPile}
              onViewLockedPile={onViewLockedPile}
              onViewLockedBlindReveal={onViewLockedBlindReveal}
            />
          ))}
        </div>
      ) : (
        <div className="sexboard-handoff-row sexboard-handoff-row--empty">
          <span className="sexboard-handoff-copy">
            <span className="sexboard-handoff-eyebrow">{emptyEyebrow}</span>
            <strong>{emptyTitle}</strong>
            <small>{emptyBody}</small>
          </span>
        </div>
      )}
    </section>
  );
});

const HandoffRow = memo(function HandoffRow({
  item,
  removing,
  onRemoveLockedPile,
  onViewLockedPile,
  onViewLockedBlindReveal,
}: {
  item: HandoffItem;
  removing: boolean;
  onRemoveLockedPile?: (sessionId: string) => void;
  onViewLockedPile?: (sessionId: string) => void;
  onViewLockedBlindReveal?: (revealId: string) => void;
}) {
  const rowClass = [
    "sexboard-handoff-row",
    item.removeSessionId ? "" : "pressable",
    item.tone ? `sexboard-handoff-row--${item.tone}` : "",
    item.glow ? "sexboard-handoff-row--approved-match" : "",
  ].filter(Boolean).join(" ");
  const actionClass = [
    "sexboard-handoff-action",
    item.actionGlow ? "sexboard-handoff-action--glow" : "",
  ].filter(Boolean).join(" ");
  const content = (
    <span className="sexboard-handoff-copy">
      <span className="sexboard-handoff-eyebrow">{item.eyebrow}</span>
      <strong>{item.title}</strong>
      <small>{item.body}</small>
      {item.tags?.length ? (
        <span className="sexboard-handoff-tags">
          {item.tags.slice(0, 4).map((tag) => (
            <span key={tag} className="sexboard-handoff-tag">{tag}</span>
          ))}
          {item.tags.length > 4 ? (
            <span className="sexboard-handoff-tag">+{item.tags.length - 4}</span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
  const hasViewDismiss = Boolean(
    (item.dismissOnViewSessionId && onViewLockedPile)
      || (item.dismissOnViewRevealId && onViewLockedBlindReveal)
  );
  const onViewClick = hasViewDismiss
    ? () => {
        if (item.dismissOnViewSessionId) onViewLockedPile?.(item.dismissOnViewSessionId);
        if (item.dismissOnViewRevealId) onViewLockedBlindReveal?.(item.dismissOnViewRevealId);
      }
    : undefined;

  if (item.removeSessionId && onRemoveLockedPile) {
    return (
      <div className={rowClass}>
        <Link href={item.href} className="sexboard-handoff-main pressable" onClick={onViewClick}>
          {content}
        </Link>
        <span className="sexboard-handoff-action-stack">
          <Link href={item.href} className={`${actionClass} pressable`} onClick={onViewClick}>
            {item.action}
          </Link>
          <button
            type="button"
            className="sexboard-handoff-remove pressable"
            onClick={() => item.removeSessionId && onRemoveLockedPile(item.removeSessionId)}
            disabled={removing}
          >
            {removing ? "Removing" : "Remove"}
          </button>
        </span>
      </div>
    );
  }

  return (
    <Link href={item.href} className={rowClass} onClick={onViewClick}>
      {content}
      <span className={actionClass}>
        {item.action}
      </span>
    </Link>
  );
});

function handoffSummaryFor(
  state: Extract<LoadState, { kind: "ready" }>,
  viewedLockedPileSessionIds: Set<string>,
  viewedLockedBlindRevealIds: Set<string>,
): HandoffSummary {
  // Drop any Ask whose scheduled window has already passed — both agreed acts AND
  // still-pending Asks the partner never answered. The server keeps room-encrypted
  // Asks for up to a week (it can't read their real timing), so without this a
  // "tonight" Ask sent last night keeps showing the next day for days.
  const ranked = rankActive(state.board.activeRequests, state.auth)
    .filter((request) => !(
      (isApprovedSexActRequest(request) && isApprovedSexActStale(request))
      || isStalePendingAsk(request)
    ));
  const visibleBlindReveal = state.blindReveal && !(
    state.blindReveal.status === "revealed"
    && viewedLockedBlindRevealIds.has(String(state.blindReveal.id || ""))
  )
    ? state.blindReveal
    : null;
  const visiblePile = sexboardVisiblePile(state.pile);
  const activeGamesCount = Number(Boolean(visiblePile)) + Number(Boolean(visibleBlindReveal));
  const latestPile = state.pileSessions.find((session) => session.id && !viewedLockedPileSessionIds.has(String(session.id)));
  const latestBlindReveal = state.blindReveals.find((reveal) => {
    if (reveal.id === visibleBlindReveal?.id) return false;
    if (viewedLockedBlindRevealIds.has(String(reveal.id || ""))) return false;
    return reveal.status !== "open" && (reveal.entries || []).length > 0;
  });
  const kinksNeedingMe = unansweredKinksFor(state.fantasy.ideas, state.auth.email, "from-partner");
  const kinksWaitingOnPartner = unansweredKinksFor(state.fantasy.ideas, state.auth.email, "from-me");
  const hasApprovedSexActRequest = ranked.some(isApprovedSexActRequest);
  const partner = partnerOf(state.workspace, state.auth.email);
  const partnerName = partner?.displayName?.split(" ")[0] || "your partner";
  const handoffs = buildHandoffs({
    pile: visiblePile,
    blindReveal: visibleBlindReveal,
    requests: ranked,
    kinksNeedingMe,
    kinksWaitingOnPartner,
    latestPile,
    latestBlindReveal,
    hasApprovedSexActRequest,
    sexQuiz: state.sexQuiz,
    greenLights: state.greenLights,
    me: state.auth,
    partnerName,
  });
  return {
    ranked,
    latestPile,
    latestBlindReveal,
    activeGamesCount,
    kinksNeedingMe,
    kinksWaitingOnPartner,
    handoffs,
    needsCount: handoffs.needsYou.length,
    waitingCount: handoffs.waiting.length,
    partnerName,
  };
}

function sexboardVisiblePile(pile: PileView | null): PileView | null {
  if (!pile) return null;
  if (pile.isRevealed) return pile;
  const revealAt = safeDateMs(pile.revealAt);
  return revealAt > 0 && revealAt <= Date.now() ? null : pile;
}

function buildHandoffs({
  pile,
  blindReveal,
  requests,
  kinksNeedingMe,
  kinksWaitingOnPartner,
  latestPile,
  latestBlindReveal,
  hasApprovedSexActRequest,
  sexQuiz,
  greenLights,
  me,
  partnerName,
}: {
  pile: PileView | null;
  blindReveal: BlindReveal | null;
  requests: RequestRecord[];
  kinksNeedingMe: KinkIdea[];
  kinksWaitingOnPartner: KinkIdea[];
  latestPile?: PileSession;
  latestBlindReveal?: BlindReveal;
  hasApprovedSexActRequest: boolean;
  sexQuiz: GameRoundStatus | null;
  greenLights: GameRoundStatus | null;
  me: AuthInfo;
  partnerName: string;
}): { needsYou: HandoffItem[]; waiting: HandoffItem[]; locked: HandoffItem[] } {
  const needsYou: HandoffItem[] = [];
  const waiting: HandoffItem[] = [];
  const locked: HandoffItem[] = [
    latestPile ? lockedPileHandoff(latestPile, hasApprovedSexActRequest) : null,
    latestBlindReveal ? lockedBlindRevealHandoff(latestBlindReveal) : null,
  ].filter(Boolean) as HandoffItem[];

  if (pile) {
    const mineCount = pile.mine?.length || 0;
    const maxDropCount = pile.maxDropCount || pile.targetDropCount || 0;
    const usesDropLimit = maxDropCount > 0;
    const mineReady = mineCount > 0;
    const revealLabel = compactScheduledLabel(scheduledLabel(pile.revealAt));
    const revealDue = safeDateMs(pile.revealAt) <= Date.now();
    const pileItem: HandoffItem = pile.isRevealed
      ? {
          id: "pile-reveal",
          href: "/games/pile",
          eyebrow: "The Pile reveal is open",
          title: "Open the reveal",
          body: pile.overlap?.length
            ? `${pile.overlap.length} overlap${pile.overlap.length === 1 ? "" : "s"} ready.`
            : "See what matched and what stayed private.",
          action: "Open",
        }
      : {
          id: "pile-live",
          href: "/games/pile",
          eyebrow: usesDropLimit
            ? `The Pile allows up to ${maxDropCount} each`
            : pile.partnerHasDropped
            ? `${partnerName} added acts`
            : "The Pile is live",
          title: mineCount
            ? "Edit your acts"
            : "Add your acts",
          body: mineCount
            ? revealDue && !pile.partnerHasDropped
              ? `Waiting for ${partnerName} to add at least one Act.`
              : `Your list is saved. You can update it before reveal in ${revealLabel}.`
            : usesDropLimit
            ? revealDue
              ? `Drop 1 to ${maxDropCount} Acts to open the reveal.`
              : `Drop 1 to ${maxDropCount} Acts before reveal in ${revealLabel}.`
            : `Matches reveal in ${revealLabel} if you both picked the same acts.`,
          action: "Open Pile",
        };
    if (pile.isRevealed || !mineReady) needsYou.push(pileItem);
    else waiting.push({
      ...pileItem,
      eyebrow: usesDropLimit ? `Up to ${maxDropCount} each` : pile.partnerHasDropped ? "Both added acts" : "You added acts",
      title: pile.partnerHasDropped
        ? "Both Pile lists are in"
        : "Your Pile list is in",
      body: pile.partnerHasDropped
        ? `Reveal in ${revealLabel}. You can still edit before it opens.`
        : revealDue
        ? `Waiting for ${partnerName} to add at least one Act.`
        : `Waiting for ${partnerName} and reveal in ${revealLabel}.`,
      action: "Edit",
    });
  }

  if (blindReveal) {
    const needsSubmission = blindReveal.status !== "revealed" && !blindReveal.mySubmitted;
    const partnerSubmitted = blindReveal.partnerSubmitted;
    const hasTwoAnswers = blindRevealHasTwoAnswers(blindReveal);
    const item: HandoffItem = {
      id: `blind-${blindReveal.id}`,
      href: "/games/blind-reveal",
      eyebrow: partnerSubmitted ? `${partnerName} answered Blind Reveal` : "Blind Reveal is open",
      title: blindReveal.status === "revealed" ? "Open the answers" : "Answer Blind Reveal",
      body: blindReveal.status === "revealed"
        ? "Both answers are visible."
        : `${blindReveal.submittedCount}/${blindReveal.requiredCount} answers locked.`,
      action: blindReveal.status === "revealed" ? "Open" : needsSubmission ? "Answer" : "View",
      actionGlow: hasTwoAnswers,
    };
    if (blindReveal.status === "revealed") locked.push(lockedBlindRevealHandoff(blindReveal, hasTwoAnswers));
    else if (needsSubmission) needsYou.push(item);
    else waiting.push({
      ...item,
      eyebrow: "You answered Blind Reveal",
      title: "Answer locked",
      body: `Waiting on ${partnerName}.`,
      action: "View",
    });
  }

  // Sex Quiz / Green Lights — mirror the Pile/Blind Reveal in-flight states:
  // partner finished and you haven't (needs you), or you finished and they
  // haven't (waiting). Both done / revealed shows neither.
  if (sexQuiz) {
    if (sexQuiz.partnerSubmitted && !sexQuiz.mySubmitted) {
      needsYou.push({
        id: "sexquiz-needs-you",
        href: "/games/sex-quiz",
        eyebrow: `${partnerName} took the Sex Quiz`,
        title: "Take the Sex Quiz",
        body: "Answer yours to unlock what you're both into.",
        action: "Take it",
      });
    } else if (sexQuiz.mySubmitted && !sexQuiz.partnerSubmitted) {
      waiting.push({
        id: "sexquiz-waiting",
        href: "/games/sex-quiz",
        eyebrow: "Your Sex Quiz is in",
        title: `Waiting on ${partnerName}`,
        body: `Your answers are saved — ${partnerName} hasn't finished theirs.`,
        action: "View",
      });
    }
  }
  if (greenLights) {
    if (greenLights.partnerSubmitted && !greenLights.mySubmitted) {
      needsYou.push({
        id: "greenlights-needs-you",
        href: "/games/green-lights",
        eyebrow: `${partnerName} took Green Lights`,
        title: "Take Green Lights",
        body: "Answer yours to see where you align.",
        action: "Take it",
      });
    } else if (greenLights.mySubmitted && !greenLights.partnerSubmitted) {
      waiting.push({
        id: "greenlights-waiting",
        href: "/games/green-lights",
        eyebrow: "Your Green Lights are in",
        title: `Waiting on ${partnerName}`,
        body: `Your answers are saved — ${partnerName} hasn't finished theirs.`,
        action: "View",
      });
    }
  }

  if (kinksNeedingMe.length) {
    needsYou.push(kinkResponseHandoff({
      id: "kinks-need-me",
      href: kinkReviewHref(kinksNeedingMe),
      count: kinksNeedingMe.length,
      actorName: partnerName,
      mode: "needs-me",
    }));
  }

  if (kinksWaitingOnPartner.length) {
    waiting.push(kinkResponseHandoff({
      id: "kinks-waiting-partner",
      href: sharedKinksHref(),
      count: kinksWaitingOnPartner.length,
      actorName: partnerName,
      mode: "waiting-partner",
    }));
  }

  requests.forEach((request) => {
    const fromPartner = isFromPartner(request, me);
    const title = requestTitle(request);
    const href = requestHandoffHref(request);
    const pendingCounter = hasPendingRequestCounter(request);
    const approvedSexAct = isApprovedSexActRequest(request);
    const timingLabel = currentTimingLabel(request);
    const action = approvedSexAct ? "It's on!" : pendingCounter && !fromPartner ? "Review" : "Open";
    if (fromPartner && request.status === "pending") {
      needsYou.push({
        id: `request-${request.id}`,
        href,
        eyebrow: `${request.requesterName || partnerName} sent an Ask`,
        title,
        body: `${timingLabel} · waiting for your yes, no, or counter.`,
        action: "Reply",
      });
      return;
    }

    // A deferred Ask. On the reviewer's board it's a "needs you" — she owes a
    // final call — with copy that escalates from "decide by <when>" to a direct
    // "yes or no?" once the timing window has actually arrived (Tomorrow rolls
    // to Tonight via currentTimingLabel). On the requester's board it's a soft
    // waiting row with a Nudge that routes to the Ask (where Remind lives).
    if (request.status === "maybe") {
      const decideNow = timingLabel === "Tonight" || timingLabel === "Mid-day";
      if (fromPartner) {
        needsYou.push({
          id: `request-${request.id}`,
          href,
          eyebrow: `${request.requesterName || partnerName} sent an Ask`,
          title,
          body: decideNow
            ? "Still a maybe from earlier — yes or no?"
            : `Maybe · decide closer to ${timingLabel.toLowerCase()}.`,
          action: decideNow ? "Decide" : "Decide now",
        });
      } else {
        waiting.push({
          id: `request-${request.id}`,
          href,
          eyebrow: "You sent an Ask",
          title,
          body: `${partnerName} said maybe · deciding by ${timingLabel.toLowerCase()}.`,
          action: "Nudge",
        });
      }
      return;
    }

    if (!fromPartner) {
      waiting.push({
        id: `request-${request.id}`,
        href,
        eyebrow: "You sent an Ask",
        title,
        body: request.status === "on_deck"
          ? approvedRequestBody(request)
          : request.status === "reviewed"
          ? pendingCounter
            ? `${partnerName} countered. Review it.`
            : `${partnerName} reviewed it.`
          : `Waiting on ${partnerName}.`,
        action,
        actionGlow: approvedSexAct && request.status === "on_deck",
      });
    } else {
      waiting.push({
        id: `request-${request.id}`,
        href,
        eyebrow: `${request.requesterName || partnerName} sent an Ask`,
        title,
        body: request.status === "on_deck"
          ? approvedRequestBody(request)
          : request.status === "reviewed" && pendingCounter
          ? "Counter offered."
          : `${statusLabel(request.status)} · ${timingLabel}.`,
        action,
        actionGlow: approvedSexAct && request.status === "on_deck",
      });
    }
  });

  return { needsYou, waiting, locked };
}

function requestHandoffHref(request: RequestRecord) {
  // An approved all-yes Ask (status reviewed *or* on_deck) routes to the
  // /mutual celebration — not just on_deck — so a plain "Yes to all" reply that
  // lands in `reviewed` still lands on "Both of you said yes." rather than the
  // Pass/Archive-only Ask detail.
  if (isApprovedSexActRequest(request)) return mutualAskHref(request.id, request.categories || [], request.matchNarration || "");
  return `/ask-detail?id=${encodeURIComponent(request.id)}`;
}

function lockedPileHandoff(session: PileSession, hasApprovedSexActRequest = false): HandoffItem {
  const acts = session.acts || session.overlap || [];
  const matchLabel = `${acts.length} match${acts.length === 1 ? "" : "es"}`;
  return {
    id: `locked-pile-${session.id}`,
    href: `/games/pile?session=${encodeURIComponent(session.id)}&activity=1`,
    eyebrow: `${friendlyDateLabel(session.lockedAt || session.revealAt)} · ${matchLabel}`,
    title: session.revealNarration || `${matchLabel} locked in`,
    body: "Pile overlap locked in for tonight.",
    action: "View",
    tags: acts,
    tone: "locked",
    glow: hasApprovedSexActRequest && acts.length > 0,
    removeSessionId: session.id,
    dismissOnViewSessionId: session.id,
  };
}

function lockedBlindRevealHandoff(reveal: BlindReveal, hasTwoAnswers = false): HandoffItem {
  return {
    id: `locked-blind-${reveal.id}`,
    href: `/games/blind-reveal?id=${encodeURIComponent(reveal.id)}&activity=1`,
    eyebrow: `${friendlyDateLabel(reveal.archivedAt || reveal.revealedAt || reveal.updatedAt)} · Blind Reveal`,
    title: reveal.prompt || "Closed Blind Reveal",
    body: "Both answers can be reopened.",
    action: "View",
    tone: "locked",
    actionGlow: hasTwoAnswers,
    dismissOnViewRevealId: reveal.id,
  };
}

function kinkResponseHandoff({
  id,
  href,
  count,
  actorName,
  mode,
}: {
  id: string;
  href: string;
  count: number;
  actorName: string;
  mode: "needs-me" | "waiting-partner";
}): HandoffItem {
  if (mode === "needs-me") {
    return {
      id,
      href,
      eyebrow: `${actorName} shared ${count} kink${count === 1 ? "" : "s"}`,
      title: "Review kink responses",
      body: count === 1 ? "One quick reaction is waiting." : `${count} quick reactions are waiting.`,
      action: count === 1 ? "Review" : `Review ${count}`,
    };
  }
  return {
    id,
    href,
    eyebrow: `You shared ${count} kink${count === 1 ? "" : "s"}`,
    title: count === 1 ? "Waiting on a kink response" : `${count} kinks waiting`,
    body: `Waiting on ${actorName} to respond.`,
    action: "Open",
  };
}

function sexboardDashboardState(
  requests: RequestRecord[],
  auth: AuthInfo,
  hasActiveGame: boolean,
  pendingKinkResponses: number,
  latestPile?: PileSession,
  latestBlindReveal?: BlindReveal,
): "quiet" | "needs-you" | "active" | "tonight" {
  if (requests.some((request) => request.status === "pending" && isFromPartner(request, auth))) return "needs-you";
  if (pendingKinkResponses > 0) return "needs-you";
  if (
    requests.some((request) => (
      isApprovedSexActRequest(request)
        ? currentTimingLabel(request) === "Tonight"
        : !hasPendingRequestCounter(request) && currentTimingLabel(request) === "Tonight"
    ))
    || hasActiveGame
    || latestPile
    || latestBlindReveal
  ) return "tonight";
  if (requests.length) return "active";
  return "quiet";
}

function pulseStateFor(state: "quiet" | "needs-you" | "active" | "tonight"): "quiet" | "pending" | "lit" | "hot" {
  if (state === "needs-you") return "pending";
  if (state === "tonight") return "hot";
  if (state === "active") return "lit";
  return "quiet";
}
