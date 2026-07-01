"use client";

import { FormEvent, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import WaitingForPartner from "@/components/WaitingForPartner";
import { combineBuiltInAndSavedActs } from "@/lib/built-in-acts";
import { EmptyState, ErrorState, SkeletonList } from "@/components/States";
import {
  ApiUnauthorizedError,
  declinePile,
  dropPileAct,
  endPile,
  getActs,
  getPile,
  lockPile,
  removePileSession,
  startPile,
  undropPileAct,
  updatePileTime,
} from "@/lib/api";
import { getProfileCached } from "@/lib/profile-cache";
import { confirmAction } from "@/lib/confirm-dialog";
import type {
  Act,
  AuthInfo,
  PileResponse,
  PileSession,
  PileView,
  ProfileResponse,
  Workspace,
} from "@/lib/types";
import { useQueryParam } from "@/lib/use-query-param";
import { useReducedMotion } from "@/lib/use-reduced-motion";
import { useLiveRoomReload } from "@/lib/use-live-room";
import { normalizeEmail, partnerOf } from "@/lib/workspace";
import { splitActLabel } from "@/lib/act-label";
import { useMarkActivityRead } from "@/lib/use-mark-activity-read";

const COLLAPSED_PILE_ACT_COUNT = 8;

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unauthorized" }
  | { kind: "no-workspace"; auth: AuthInfo }
  | {
      kind: "ready";
      auth: AuthInfo;
      workspace: Workspace;
      acts: Act[];
      pile: PileView | null;
      sessions: PileSession[];
    };

export default function PilePage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const highlightedSessionId = useQueryParam("session");

  async function reload(workspaceId?: string) {
    const profile: ProfileResponse = await getProfileCached();
    if (!profile.activeWorkspace) {
      setState({ kind: "no-workspace", auth: profile.auth });
      return;
    }
    const id = workspaceId || profile.activeWorkspace.id;
    const [pileRes, actsRes] = await Promise.all([getPile(id), getActs(id)]);
    setState({
      kind: "ready",
      auth: profile.auth,
        workspace: profile.activeWorkspace,
        acts: combineBuiltInAndSavedActs(actsRes.acts, profile.activeWorkspace.id),
        pile: pileRes.pile,
        sessions: pileRes.sessions || [],
      });
  }

  function applyPileResponse(result: PileResponse) {
    setState((current) => (
      current.kind === "ready"
        ? {
            ...current,
            pile: result.pile ?? null,
            sessions: result.sessions || (result.session ? [result.session, ...current.sessions] : current.sessions),
          }
        : current
    ));
  }

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const profile: ProfileResponse = await getProfileCached({ signal: controller.signal });
        if (cancelled) return;
        if (!profile.activeWorkspace) {
          setState({ kind: "no-workspace", auth: profile.auth });
          return;
        }
        const [pileRes, actsRes] = await Promise.all([
          getPile(profile.activeWorkspace.id),
          getActs(profile.activeWorkspace.id),
        ]);
        if (cancelled) return;
        setState({
          kind: "ready",
          auth: profile.auth,
          workspace: profile.activeWorkspace,
          acts: combineBuiltInAndSavedActs(actsRes.acts, profile.activeWorkspace.id),
          pile: pileRes.pile,
          sessions: pileRes.sessions || [],
        });
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        if (error instanceof ApiUnauthorizedError) {
          setState({ kind: "unauthorized" });
          return;
        }
        setState({ kind: "error", message: error instanceof Error ? error.message : "Couldn't load The Pile." });
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, []);

  useLiveRoomReload({
    workspaceId: state.kind === "ready" ? state.workspace.id : "",
    actorEmail: state.kind === "ready" ? state.auth.email : "",
    resources: ["pile"],
    onReload: () => reload(state.kind === "ready" ? state.workspace.id : undefined),
  });

  useMarkActivityRead({
    workspaceId: state.kind === "ready" ? state.workspace.id : "",
    resource: "pile",
    enabled: state.kind === "ready" && Boolean(state.pile?.isRevealed || highlightedSessionId),
  });

  return (
    <AppShell>
      <header className="sheet-header">
        <Link href="/games" className="fd-back pressable" aria-label="Back">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <span className="sheet-title">The Pile</span>
        <span className="status-pill"><span className="dot" />Private drops</span>
      </header>
      <Body
        state={state}
        onReload={() => reload(state.kind === "ready" ? state.workspace.id : undefined)}
        onPileChange={applyPileResponse}
        highlightedSessionId={highlightedSessionId}
      />
    </AppShell>
  );
}

function Body({
  state,
  onReload,
  onPileChange,
  highlightedSessionId,
}: {
  state: LoadState;
  onReload: () => Promise<void>;
  onPileChange: (result: PileResponse) => void;
  highlightedSessionId: string;
}) {
  if (state.kind === "loading") return <SkeletonList count={4} />;
  if (state.kind === "unauthorized") {
    return (
      <ErrorState
        title="Session expired"
        body="Sign in again to play The Pile."
        action={<Link href="/" className="btn-ghost">Back to sign-in</Link>}
      />
    );
  }
  if (state.kind === "no-workspace") {
    return (
      <ErrorState
        title="No partner space yet"
        body="The Pile needs two active partners."
        action={<Link href="/space" className="btn-ghost">Open Space</Link>}
      />
    );
  }
  if (state.kind === "error") {
    return (
      <ErrorState
        title="Couldn't load The Pile"
        body={state.message}
        action={<button type="button" className="btn-ghost" onClick={() => { void onReload(); }}>Try again</button>}
      />
    );
  }
  // Pile is a two-player game by definition. Until partner joins, render the
  // shared waiting state so the user isn't staring at a broken "Start" button.
  if (!hasJoinedPartner(state.workspace, state.auth.email)) {
    return <WaitingForPartner workspace={state.workspace} intent="Pile" />;
  }
  if (!state.pile) return <StartPile state={state} onReload={onReload} onPileChange={onPileChange} highlightedSessionId={highlightedSessionId} />;
  if (state.pile.isRevealed) return <RevealedPile state={state} onReload={onReload} onPileChange={onPileChange} />;
  return <ActivePile state={state} onReload={onReload} onPileChange={onPileChange} />;
}

function hasJoinedPartner(workspace: Workspace, myEmail: string): boolean {
  const me = (myEmail || "").toLowerCase();
  return (workspace.members || []).some((member) => {
    return member.status === "active" && (member.email || "").toLowerCase() !== me;
  });
}

function StartPile({
  state,
  onReload,
  onPileChange,
  highlightedSessionId,
}: {
  state: Extract<LoadState, { kind: "ready" }>;
  onReload: () => Promise<void>;
  onPileChange: (result: PileResponse) => void;
  highlightedSessionId: string;
}) {
  const [revealAt, setRevealAt] = useState(defaultRevealInput());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dropCap = pileDropCapForActCount(state.acts.length);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const date = new Date(revealAt);
    if (Number.isNaN(date.getTime()) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await startPile({ workspaceId: state.workspace.id, revealAt: date.toISOString() });
      if (navigator.vibrate) navigator.vibrate([6, 16, 8]);
      onPileChange(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start The Pile.");
      await onReload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pile-stage">
      <div className="pile-hero">
        <h1 className="h-intimate pile-headline">
          Drop what you&apos;re craving. The overlap is tonight.
        </h1>
        <p className="pile-sub">
          Be shameless — drop everything you want. Only what you both drop survives the reveal; the rest disappears for good.
        </p>
      </div>
      <form className="pile-time-card" onSubmit={submit}>
        <div className="pile-time-body">
          <p className="pile-time-eyebrow">Reveal at</p>
          <input
            value={revealAt}
            onChange={(event) => setRevealAt(event.target.value)}
            type="datetime-local"
            className="input pile-time-input"
          />
          <p className="pile-time-meta">
            With {state.acts.length} Acts, this game can allow up to {dropCap} each.
          </p>
        </div>
        <button type="submit" className="btn-primary shrink-0" disabled={busy}>
          {busy ? "Starting" : "Start"}
        </button>
      </form>
      {error && <p className="text-sm" role="alert" aria-live="assertive" style={{ color: "rgb(var(--no-rgb))" }}>{error}</p>}
      <PileHistory
        sessions={state.sessions}
        highlightedSessionId={highlightedSessionId}
        workspaceId={state.workspace.id}
        actorEmail={state.auth.email}
        onPileChange={onPileChange}
      />
    </div>
  );
}

function PileHistory({
  sessions,
  highlightedSessionId,
  workspaceId,
  actorEmail,
  onPileChange,
}: {
  sessions: PileSession[];
  highlightedSessionId: string;
  workspaceId: string;
  actorEmail: string;
  onPileChange: (result: PileResponse) => void;
}) {
  const [removingId, setRemovingId] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function removeSession(sessionId: string) {
    if (!sessionId || removingId) return;
    const confirmed = await confirmAction({
      title: "Remove this locked Pile?",
      body: "It leaves tonight and Health for both of you.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!confirmed) return;
    setRemovingId(sessionId);
    setError(null);
    try {
      const result = await removePileSession({ workspaceId, sessionId });
      onPileChange(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove that Pile.");
    } finally {
      setRemovingId("");
    }
  }

  if (!sessions.length) return null;
  return (
    <section className="pile-history-section" aria-label="Pile history">
      <p className="eyebrow">Recent piles</p>
      {error && <p className="text-sm" role="alert" aria-live="assertive" style={{ color: "rgb(var(--no-rgb))" }}>{error}</p>}
      <div className="pile-history-list">
        {sessions.slice(0, 6).map((session) => (
          <PileHistoryCard
            key={session.id}
            session={session}
            highlighted={session.id === highlightedSessionId}
            removing={removingId === session.id}
            actorEmail={actorEmail}
            onRemove={removeSession}
          />
        ))}
      </div>
    </section>
  );
}

function PileHistoryCard({
  session,
  highlighted,
  removing,
  actorEmail,
  onRemove,
}: {
  session: PileSession;
  highlighted: boolean;
  removing: boolean;
  actorEmail: string;
  onRemove: (sessionId: string) => void;
}) {
  const cardRef = useRef<HTMLElement | null>(null);
  const acts = session.acts || session.overlap || [];
  const canRemove = !session.lockedByEmail || normalizeEmail(session.lockedByEmail) === normalizeEmail(actorEmail);

  useEffect(() => {
    if (!highlighted) return;
    const timer = window.setTimeout(() => {
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 260);
    return () => window.clearTimeout(timer);
  }, [highlighted]);

  return (
    <article
      ref={cardRef}
      className={`pile-history-card ${highlighted ? "is-activity-highlight" : ""}`}
      data-activity-highlight={highlighted ? "true" : undefined}
    >
      <div className="pile-history-card-head">
        <span>{formatWhen(session.lockedAt || session.revealAt)}</span>
        <span>{acts.length} match{acts.length === 1 ? "" : "es"}</span>
      </div>
      {session.revealNarration && <p className="pile-history-line">{session.revealNarration}</p>}
      {acts.length ? (
        <div className="pile-history-acts">
          {acts.slice(0, 5).map((act) => (
            <span key={act} className="chip">{act}</span>
          ))}
          {acts.length > 5 && <span className="chip">+{acts.length - 5}</span>}
        </div>
      ) : (
        <p className="pile-history-empty">No overlap. {session.quietDropCount || "No"} quiet drops disappeared.</p>
      )}
      {canRemove && (
        <button
          type="button"
          className="pile-history-remove pressable"
          onClick={() => onRemove(session.id)}
          disabled={removing}
        >
          {removing ? "Removing" : "Remove from Health"}
        </button>
      )}
    </article>
  );
}

function ActivePile({
  state,
  onReload,
  onPileChange,
}: {
  state: Extract<LoadState, { kind: "ready" }>;
  onReload: () => Promise<void>;
  onPileChange: (result: PileResponse) => void;
}) {
  const pile = state.pile!;
  const partner = partnerOf(state.workspace, state.auth.email);
  const isRequester = normalizeEmail(pile.startedByEmail) === normalizeEmail(state.auth.email);
  const [busyLabel, setBusyLabel] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [actsExpanded, setActsExpanded] = useState(false);
  const maxDropCount = pile.maxDropCount || pile.targetDropCount || 0;
  const usesDropLimit = maxDropCount > 0;
  const myDropCount = pile.mine.length;
  const remainingDrops = usesDropLimit ? Math.max(0, maxDropCount - myDropCount) : 0;
  const isAtDropLimit = usesDropLimit && remainingDrops === 0;
  const dropped = useMemo(() => new Set(pile.mine.map(cleanKey)), [pile.mine]);
  const availableActs = state.acts.filter((act) => !dropped.has(cleanKey(act.label)));
  const visibleActs = actsExpanded ? availableActs : availableActs.slice(0, COLLAPSED_PILE_ACT_COUNT);
  const hiddenActCount = Math.max(0, availableActs.length - visibleActs.length);
  const waitingOnPartner = myDropCount > 0 && !pile.partnerHasDropped;

  useEffect(() => {
    const revealAt = new Date(pile.revealAt).getTime();
    if (!Number.isFinite(revealAt)) return;
    // Foreground path: fire once the reveal time arrives while the tab is open.
    const delay = Math.max(0, revealAt - Date.now() + 250);
    const timer = window.setTimeout(() => { onReload(); }, Math.min(delay, 2_147_000_000));
    // Backgrounded path: a setTimeout scheduled while the device is asleep or
    // the tab is hidden won't fire on time, so the board can sit stale past
    // reveal. Re-check whenever the tab becomes visible / focused and reload
    // if the reveal moment has already passed.
    const onWake = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() >= revealAt) onReload();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [onReload, pile.revealAt]);

  async function drop(label: string) {
    const clean = label.trim();
    if (!clean || busyLabel) return;
    if (isAtDropLimit && !dropped.has(cleanKey(clean))) return;
    setBusyLabel(clean);
    setActionError(null);
    try {
      const result = await dropPileAct({ workspaceId: state.workspace.id, label: clean });
      setCustom("");
      if (navigator.vibrate) navigator.vibrate(8);
      onPileChange(result);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't drop that Act.");
    } finally {
      setBusyLabel("");
    }
  }

  async function undrop(label: string) {
    if (busyLabel) return;
    setBusyLabel(label);
    setActionError(null);
    try {
      const result = await undropPileAct({ workspaceId: state.workspace.id, label });
      if (navigator.vibrate) navigator.vibrate(4);
      onPileChange(result);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't remove that drop.");
    } finally {
      setBusyLabel("");
    }
  }

  async function moveTime(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return;
    if (!isRequester) return;
    setActionError(null);
    try {
      const result = await updatePileTime({ workspaceId: state.workspace.id, revealAt: date.toISOString() });
      onPileChange(result);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't move the reveal time.");
    }
  }

  async function cancelPile() {
    if (busyLabel || !isRequester) return;
    setBusyLabel("ending");
    setActionError(null);
    try {
      const result = await endPile({ workspaceId: state.workspace.id });
      onPileChange(result);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't end this pile.");
    } finally {
      setBusyLabel("");
    }
  }

  async function declineCurrentPile() {
    if (busyLabel || isRequester) return;
    setBusyLabel("declining");
    setActionError(null);
    try {
      const result = await declinePile({ workspaceId: state.workspace.id });
      if (navigator.vibrate) navigator.vibrate([5, 18, 5]);
      onPileChange(result);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't decline this pile.");
    } finally {
      setBusyLabel("");
    }
  }

  return (
    <div className="pile-stage">
      <div className="pile-hero">
        <h1 className="h-intimate pile-headline">
          {usesDropLimit ? `Drop up to ${maxDropCount} Acts.` : "Add as many as you want."}
        </h1>
        <p className="pile-sub">
          {usesDropLimit
            ? `Reveal opens when the timer is ready and both sides have at least one drop. Any overlap is the match; misses disappear.`
            : `${partner?.displayName || "Your partner"} can't see your side. You can't see theirs. Misses disappear at reveal.`}
        </p>
      </div>

      {actionError && (
        <p className="text-sm" role="alert" style={{ color: "rgb(var(--no-rgb))" }}>{actionError}</p>
      )}

      <label className="pile-time-card pressable">
        <div className="pile-time-body">
          <p className="pile-time-eyebrow">Reveal at</p>
          <input
            type="datetime-local"
            defaultValue={toDatetimeLocal(pile.revealAt)}
            onBlur={(event) => moveTime(event.target.value)}
            disabled={!isRequester}
            className="input pile-time-input"
          />
          <p className="pile-time-meta">{activePileTimeMeta(pile, partner?.displayName)}</p>
        </div>
      </label>

      {waitingOnPartner && (
        <p className="pile-waiting-pill">
          Waiting on {partner?.displayName?.split(" ")[0] || "your partner"}
        </p>
      )}

      <div className="pile-counts">
        <div className="pile-count pile-count-you">
          <p className="pile-count-eyebrow">You</p>
          <p className="pile-count-num">{usesDropLimit ? `${myDropCount}/${maxDropCount}` : myDropCount}</p>
          <p className="pile-count-meta">
            {usesDropLimit ? (isAtDropLimit ? "at the cap" : `${remainingDrops} open`) : "visible only to you"}
          </p>
        </div>
        <div className="pile-count pile-count-them">
          <p className="pile-count-eyebrow">{partner?.displayName || "Partner"}</p>
          <p className="pile-count-num">{pile.partnerHasDropped ? "in" : "?"}</p>
          <p className="pile-count-meta">hidden until reveal</p>
        </div>
      </div>

      <section className="pile-section">
        <p className="eyebrow">Your drops · <em>private until reveal</em></p>
        {pile.mine.length ? (
          <ul className="pile-drops">
            {pile.mine.map((label) => (
              <li key={label} className="pile-drop">
                <span className="pile-drop-emoji">{leadingEmoji(label)}</span>
                <span className="pile-drop-text">{stripLeadingEmoji(label)}</span>
                <button
                  type="button"
                  className="pile-drop-remove pressable"
                  aria-label={`Remove ${label}`}
                  onClick={() => undrop(label)}
                  disabled={Boolean(busyLabel)}
                >
                  x
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="card p-4 text-sm leading-relaxed text-ink-2">
            {usesDropLimit ? `Drop 1 to ${maxDropCount} Acts to get your side ready.` : "Drop one Act to get your side started."}
          </div>
        )}
        {isAtDropLimit && (
          <p className="pile-hidden-count">
            You&apos;re at the cap. Remove one Act if you want to swap before reveal.
          </p>
        )}
      </section>

      <section className="pile-section">
        <p className="eyebrow">Drop from Acts</p>
        <div className="ask-act-grid">
          {visibleActs.map((act) => (
            <button
              key={act.id}
              type="button"
              className="act-chip pressable"
              onClick={() => drop(act.label)}
              disabled={Boolean(busyLabel) || isAtDropLimit}
            >
              <span className="act-chip-dot" aria-hidden="true" />
              <span className="act-chip-name">{act.label}</span>
            </button>
          ))}
        </div>
        {availableActs.length > COLLAPSED_PILE_ACT_COUNT && (
          <div className="pile-act-actions">
            <button
              type="button"
              className="btn-ghost pile-act-action"
              onClick={() => setActsExpanded((value) => !value)}
            >
              {actsExpanded ? "Collapse Acts" : `Show all ${availableActs.length} Acts`}
            </button>
          </div>
        )}
        {!actsExpanded && hiddenActCount > 0 && (
          <p className="pile-hidden-count">
            {hiddenActCount} more Acts are tucked away until you expand.
          </p>
        )}
      </section>

      <form
        className="pile-add-form"
        onSubmit={(event) => {
          event.preventDefault();
          drop(custom);
        }}
      >
        <input
          className="input"
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          placeholder="Drop another Act"
          aria-label="Drop another Act"
          autoCapitalize="none"
          autoCorrect="on"
          spellCheck
          inputMode="text"
        />
        <button className="btn-ghost" disabled={!custom.trim() || Boolean(busyLabel) || isAtDropLimit} type="submit">
          Drop
        </button>
      </form>

      {isRequester ? (
        <button type="button" className="btn-ghost w-full" onClick={cancelPile} disabled={Boolean(busyLabel)}>
          End this pile
        </button>
      ) : (
        <section className="pile-decline-card">
          <div>
            <p className="pile-decline-kicker">Not tonight?</p>
            <p className="pile-decline-copy">Decline and close this Pile for both of you.</p>
          </div>
          <button type="button" className="btn-ghost pile-decline-action" onClick={declineCurrentPile} disabled={Boolean(busyLabel)}>
            Decline The Pile
          </button>
        </section>
      )}
    </div>
  );
}

/* Drop-in replacement for `RevealedPile` + `RevealStack` + `phaseLabel`
   in `web/src/app/games/pile/page.tsx`.

   Replaces lines 597 → ~760 of the existing file. Same external API as
   before (state + onReload + onPileChange props). Three changes vs.
   what's there today:

     1. Adds a new "drift" phase between match and settle, where matched
        cards drift toward each other in the centerline before the board
        fades out. The whole sequence is slowed ~30% (intro→final goes
        from ~3s to ~5.2s) for a more "velvet room" feel.
     2. Replaces the .pile-drops list inside .pile-final with a vertical
        EKG-style pulse band: a heartbeat trace on the left, one row per
        agreed act, each row marked by a breathing rose node where it
        meets the spine. Pairs with the .pile-pulse-* selectors in
        reveals.css.
     3. Tightened headline copy: "In sync." instead of "You're doing
        this." for the final state (overlap case). The empty case is
        unchanged.

   Paste this between the existing `function RevealedPile` line and the
   `function formatWhen` line. Keep the existing helpers (`cleanKey`,
   `leadingEmoji`, `stripLeadingEmoji`) at the bottom of the file. */

function RevealedPile({
  state,
  onReload,
  onPileChange,
}: {
  state: Extract<LoadState, { kind: "ready" }>;
  onReload: () => Promise<void>;
  onPileChange: (result: PileResponse) => void;
}) {
  const pile = state.pile!;
  const overlaps = pile.overlap || [];
  const mine = pile.mine || [];
  const theirs = Object.values(pile.partnerLabels || {})[0] || [];
  const quietCount = (pile.onlyMine?.length || 0) + (pile.onlyTheirs?.length || 0);
  const isRequester = normalizeEmail(pile.startedByEmail) === normalizeEmail(state.auth.email);
  const [phase, setPhase] =
    useState<"intro" | "flip" | "match" | "drift" | "settle" | "final">("intro");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const router = useRouter();
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (navigator.vibrate) navigator.vibrate([8, 24, 8]);
    // Slowed ~30% from the previous 400 / 1400 / 2400 / 3000 schedule.
    // New "drift" phase sits between match and settle and lets matched
    // cards visually pull together at the centerline before everything
    // dissolves into the pulse-band record. Reduced motion collapses the
    // choreography so the results show immediately.
    const delay = (ms: number) => (reducedMotion ? 0 : ms);
    const timers = [
      window.setTimeout(() => setPhase("flip"),   delay(520)),
      window.setTimeout(() => setPhase("match"),  delay(1820)),
      window.setTimeout(() => setPhase("drift"),  delay(3120)),
      window.setTimeout(() => setPhase("settle"), delay(4060)),
      window.setTimeout(() => setPhase("final"),  delay(5200)),
    ];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [reducedMotion]);

  async function lockItIn() {
    setBusy(true);
    setActionError(null);
    try {
      const result = await lockPile({ workspaceId: state.workspace.id });
      const params = new URLSearchParams({
        source: "pile",
        count: String(overlaps.length),
      });
      if (result.session?.encryptedActs?.length) {
        try {
          sessionStorage.setItem("ss:mutual-celebration", JSON.stringify({
            source: "pile",
            acts: overlaps,
            count: overlaps.length,
            narration: result.session.revealNarration || "",
          }));
        } catch {}
        params.set("private", "1");
      } else {
        params.set("acts", overlaps.join("|"));
      }
      if (result.session?.revealNarration) {
        params.set("narration", result.session.revealNarration);
      }
      router.push(`/mutual?${params.toString()}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't lock it in.");
      setBusy(false);
    }
  }

  async function clearPile() {
    setBusy(true);
    setActionError(null);
    try {
      const result = await endPile({ workspaceId: state.workspace.id });
      onPileChange(result);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Couldn't clear this pile.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`pile-stage pile-revealed-stage pile-reveal-machine is-${phase}`}>
      <p className={`eyebrow pile-reveal-eyebrow ${phase === "final" ? "is-final" : ""}`}>
        {phaseLabel(phase, overlaps.length)}
      </p>

      <section className="pile-reveal-board" aria-label="The Pile reveal">
        <RevealStack title="You" labels={mine} overlaps={overlaps} side="mine" phase={phase} />
        <RevealStack title="Partner" labels={theirs} overlaps={overlaps} side="theirs" phase={phase} />
        <span className="pile-reveal-centerglow" aria-hidden="true" />
      </section>

      <section className="pile-final">
        {overlaps.length ? (
          <>
            <p className="eyebrow pile-pulse-eyebrow">
              the room found · <em>{overlaps.length}</em>
            </p>
            <h1 className="h-intimate pile-headline pile-pulse-headline">
              In <em>sync.</em>
            </h1>
            {pile.revealNarration && <p className="pile-sub">{pile.revealNarration}</p>}

            <div className="pile-pulse-band" data-count={overlaps.length}>
              <div className="pile-pulse-spine" aria-hidden="true">
                <svg viewBox="0 0 36 460" preserveAspectRatio="none">
                  <path
                    className="pile-pulse-wave"
                    pathLength={1}
                    d="M 18 0 L 18 65 L 22 69 L 18 73 L 14 75 L 32 80 L 4 85 L 18 90 L 22 93 L 18 96 L 18 220 L 22 224 L 18 228 L 14 230 L 32 235 L 4 240 L 18 245 L 22 248 L 18 252 L 18 373 L 22 377 L 18 381 L 14 383 L 32 388 L 4 393 L 18 398 L 22 401 L 18 405 L 18 460"
                  />
                  <path
                    className="pile-pulse-heart"
                    pathLength={1}
                    d="M 18 0 L 18 65 L 22 69 L 18 73 L 14 75 L 32 80 L 4 85 L 18 90 L 22 93 L 18 96 L 18 220 L 22 224 L 18 228 L 14 230 L 32 235 L 4 240 L 18 245 L 22 248 L 18 252 L 18 373 L 22 377 L 18 381 L 14 383 L 32 388 L 4 393 L 18 398 L 22 401 L 18 405 L 18 460"
                  />
                </svg>
              </div>
              <ul className="pile-pulse-rows">
                {overlaps.map((label, index) => (
                  <li
                    key={label}
                    className="pile-pulse-row"
                    style={{ animationDelay: `${index * 180}ms` } as CSSProperties}
                  >
                    <span className="pile-pulse-pip">{leadingEmoji(label)}</span>
                    <span className="pile-pulse-text">{stripLeadingEmoji(label)}</span>
                    <span className="pile-pulse-tag">tonight</span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : (
          <EmptyState
            title="Misses disappear."
            body="Nothing becomes an Ask. Nothing gets saved as a no."
          />
        )}

        <p className="pile-miss-line">
          {quietCount || "No"} drop{quietCount === 1 ? "" : "s"} disappeared. No record kept.
        </p>

        <div className="pile-final-actions">
          <button type="button" className="btn-primary w-full" onClick={lockItIn} disabled={busy}>
            {busy ? "Locking in" : "Lock it in"}
          </button>
          {isRequester && (
            <button type="button" className="btn-ghost w-full" onClick={clearPile} disabled={busy}>
              Clear this pile
            </button>
          )}
        </div>
        {actionError && (
          <p className="text-sm" role="alert" style={{ color: "rgb(var(--no-rgb))" }}>{actionError}</p>
        )}
      </section>
    </div>
  );
}

function RevealStack({
  title,
  labels,
  overlaps,
  side,
  phase,
}: {
  title: string;
  labels: string[];
  overlaps: string[];
  side: "mine" | "theirs";
  phase: "intro" | "flip" | "match" | "drift" | "settle" | "final";
}) {
  const overlapKeys = new Set(overlaps.map(cleanKey));
  return (
    <div className={`pile-reveal-stack pile-reveal-${side}`}>
      <p className="pile-stack-label">{title}</p>
      <div className="pile-stack-cards">
        {labels.slice(0, 8).map((label, index) => {
          const matched = overlapKeys.has(cleanKey(label));
          return (
            <div
              key={`${side}-${label}`}
              className={[
                "pile-reveal-card",
                matched ? "is-match" : "is-miss",
                side === "theirs" && (phase === "intro" || phase === "flip") ? "is-covered" : "",
              ].join(" ")}
              style={{ "--i": index } as CSSProperties}
            >
              <div className="pile-reveal-face pile-reveal-back" />
              <div className="pile-reveal-face pile-reveal-front">
                <span>{leadingEmoji(label)}</span>
                <em>{stripLeadingEmoji(label)}</em>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function phaseLabel(phase: "intro" | "flip" | "match" | "drift" | "settle" | "final", count: number) {
  if (phase === "intro")  return "Reveal time.";
  if (phase === "flip")   return "Opening the pile...";
  if (phase === "match")  return "Looking for overlaps...";
  if (phase === "drift")  return "Finding the centerline.";
  if (phase === "settle") return `${count} overlap${count === 1 ? "" : "s"}`;
  return "In sync.";
}

function formatWhen(value: string) {
  const time = new Date(value || "").getTime();
  if (!Number.isFinite(time)) return "recent";
  const diff = Math.max(0, Date.now() - time);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(time);
}

function defaultRevealInput() {
  const date = new Date();
  date.setHours(21, 30, 0, 0);
  if (date.getTime() < Date.now() + 15 * 60 * 1000) date.setDate(date.getDate() + 1);
  return toDatetimeLocal(date.toISOString());
}

function toDatetimeLocal(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function timeUntil(value: string) {
  const ms = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "Reveal time set";
  if (ms <= 0) return "Reveal is open";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `Reveal in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return `Reveal in ${hours}h ${rest}m`;
}

function activePileTimeMeta(pile: PileView, partnerName?: string) {
  const ms = new Date(pile.revealAt).getTime() - Date.now();
  if (Number.isFinite(ms) && ms <= 0 && !pile.isRevealed) {
    if (!pile.mine.length) return "Reveal waits for your first drop";
    if (!pile.partnerHasDropped) return `Reveal waits for ${partnerName?.split(" ")[0] || "your partner"}`;
    return "Reveal is opening";
  }
  return timeUntil(pile.revealAt);
}

function pileDropCapForActCount(actCount: number) {
  return Math.max(1, Math.floor(Math.max(1, actCount) / 3));
}

function cleanKey(value: string) {
  return stripLeadingEmoji(value).toLowerCase();
}

function leadingEmoji(value: string) {
  return splitActLabel(value).emoji || "+";
}

function stripLeadingEmoji(value: string) {
  return splitActLabel(value).text;
}
