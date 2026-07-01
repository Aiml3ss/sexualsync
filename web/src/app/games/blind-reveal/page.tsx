"use client";

import { FormEvent, useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import { ErrorState, SkeletonList } from "@/components/States";
import {
  ApiUnauthorizedError,
  archiveBlindReveal,
  cancelBlindReveal,
  createBlindReveal,
  getBlindReveal,
  promoteBlindRevealEntry,
  submitBlindReveal,
} from "@/lib/api";
import { getProfileCached } from "@/lib/profile-cache";
import type {
  AuthInfo,
  BlindReveal,
  BlindRevealResponse,
  ProfileResponse,
  Workspace,
} from "@/lib/types";
import { useQueryParam } from "@/lib/use-query-param";
import { useLiveRoomReload } from "@/lib/use-live-room";
import { normalizeEmail, partnerOf } from "@/lib/workspace";
import { useMarkActivityRead } from "@/lib/use-mark-activity-read";

const DEFAULT_PROMPT = "The filthiest thing you've been quietly turning over but never said out loud.";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unauthorized" }
  | { kind: "no-workspace"; auth: AuthInfo }
  | {
      kind: "ready";
      auth: AuthInfo;
      workspace: Workspace;
      reveal: BlindReveal | null;
      reveals: BlindReveal[];
    };

export default function BlindRevealPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const revealIdParam = useQueryParam("id");
  const highlightedFromActivity = useQueryParam("activity") === "1";
  const highlightedRevealId = highlightedFromActivity ? revealIdParam : "";

  async function reload(workspaceId?: string, preferredRevealId = "") {
    const profile: ProfileResponse = await getProfileCached();
    if (!profile.activeWorkspace) {
      setState({ kind: "no-workspace", auth: profile.auth });
      return;
    }
    const result = await getBlindReveal(workspaceId || profile.activeWorkspace.id);
    const selectedReveal = revealFromResponse(result, preferredRevealId || revealIdParam || currentRevealIdParam());
    setState({
      kind: "ready",
      auth: profile.auth,
      workspace: profile.activeWorkspace,
      reveal: selectedReveal,
      reveals: result.reveals || [],
    });
  }

  function applyRevealResponse(result: BlindRevealResponse) {
    setState((current) => (
      current.kind === "ready"
        ? {
            ...current,
            reveal: result.activeReveal ?? null,
            reveals: result.reveals || (result.reveal || result.activeReveal
              ? [(result.reveal || result.activeReveal)!, ...current.reveals.filter((item) => item.id !== (result.reveal || result.activeReveal)?.id)]
              : current.reveals),
          }
        : current
    ));
  }

  function selectReveal(reveal: BlindReveal) {
    setState((current) => (
      current.kind === "ready"
        ? { ...current, reveal }
        : current
    ));
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const profile: ProfileResponse = await getProfileCached();
        if (cancelled) return;
        if (!profile.activeWorkspace) {
          setState({ kind: "no-workspace", auth: profile.auth });
          return;
        }
        const result = await getBlindReveal(profile.activeWorkspace.id);
        const selectedReveal = revealFromResponse(result, revealIdParam || currentRevealIdParam());
        if (cancelled) return;
        setState({
          kind: "ready",
          auth: profile.auth,
          workspace: profile.activeWorkspace,
          reveal: selectedReveal,
          reveals: result.reveals || [],
        });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiUnauthorizedError) {
          setState({ kind: "unauthorized" });
          return;
        }
        setState({ kind: "error", message: error instanceof Error ? error.message : "Couldn't load Blind Reveal." });
      }
    })();
    return () => { cancelled = true; };
  }, [revealIdParam]);

  useLiveRoomReload({
    workspaceId: state.kind === "ready" ? state.workspace.id : "",
    actorEmail: state.kind === "ready" ? state.auth.email : "",
    resources: ["blind-reveals", "fantasy-backlog"],
    onReload: () => reload(
      state.kind === "ready" ? state.workspace.id : undefined,
      state.kind === "ready" ? state.reveal?.id || revealIdParam : revealIdParam,
    ),
  });

  useMarkActivityRead({
    workspaceId: state.kind === "ready" ? state.workspace.id : "",
    resource: "blind-reveals",
    enabled: state.kind === "ready" && ["revealed", "archived"].includes(state.reveal?.status || ""),
  });

  return (
    <AppShell>
      <header className="sheet-header">
        <Link href="/games" className="fd-back pressable" aria-label="Back">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <span className="sheet-title">Blind Reveal</span>
        <span className="status-pill"><span className="dot" />Lock-in</span>
      </header>
      <Body
        state={state}
        onReload={() => reload(
          state.kind === "ready" ? state.workspace.id : undefined,
          state.kind === "ready" ? state.reveal?.id || revealIdParam : revealIdParam,
        )}
        onRevealChange={applyRevealResponse}
        onRevealSelect={selectReveal}
        highlightedRevealId={highlightedRevealId}
      />
    </AppShell>
  );
}

function revealFromResponse(result: BlindRevealResponse, revealId = "") {
  const id = String(revealId || "").trim();
  if (id) {
    const candidates = [
      result.activeReveal,
      result.reveal,
      ...(result.reveals || []),
    ].filter(Boolean) as BlindReveal[];
    const found = candidates.find((reveal) => reveal.id === id);
    if (found) return found;
  }
  return result.activeReveal ?? null;
}

function currentRevealIdParam() {
  if (typeof window === "undefined") return "";
  const raw = new URLSearchParams(window.location.search).get("id") || "";
  return /^[A-Za-z0-9_-]+$/.test(raw) ? raw.slice(0, 128) : "";
}

function Body({
  state,
  onReload,
  onRevealChange,
  onRevealSelect,
  highlightedRevealId,
}: {
  state: LoadState;
  onReload: () => Promise<void>;
  onRevealChange: (result: BlindRevealResponse) => void;
  onRevealSelect: (reveal: BlindReveal) => void;
  highlightedRevealId: string;
}) {
  if (state.kind === "loading") return <SkeletonList count={3} />;
  if (state.kind === "unauthorized") {
    return (
      <ErrorState
        title="Session expired"
        body="Sign in again to open Blind Reveal."
        action={<Link href="/" className="btn-ghost">Back to sign-in</Link>}
      />
    );
  }
  if (state.kind === "no-workspace") {
    return (
      <ErrorState
        title="No partner space yet"
        body="Blind Reveal needs two active partners."
        action={<Link href="/space" className="btn-ghost">Open Space</Link>}
      />
    );
  }
  if (state.kind === "error") {
    return <ErrorState title="Couldn't load Blind Reveal" body={state.message} />;
  }
  if (!state.reveal) return <StartReveal state={state} onReload={onReload} onRevealChange={onRevealChange} onRevealSelect={onRevealSelect} highlightedRevealId={highlightedRevealId} />;
  if (state.reveal.status === "revealed" || state.reveal.status === "archived") return <OpenedReveal state={state} onReload={onReload} onRevealChange={onRevealChange} onRevealSelect={onRevealSelect} highlightedRevealId={highlightedRevealId} />;
  return <ActiveReveal state={state} onReload={onReload} onRevealChange={onRevealChange} onRevealSelect={onRevealSelect} highlightedRevealId={highlightedRevealId} />;
}

function StartReveal({
  state,
  onReload,
  onRevealChange,
  onRevealSelect,
  highlightedRevealId,
}: {
  state: Extract<LoadState, { kind: "ready" }>;
  onReload: () => Promise<void>;
  onRevealChange: (result: BlindRevealResponse) => void;
  onRevealSelect: (reveal: BlindReveal) => void;
  highlightedRevealId: string;
}) {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createBlindReveal({ workspaceId: state.workspace.id, prompt: prompt.trim() });
      if (navigator.vibrate) navigator.vibrate([6, 16, 8]);
      onRevealChange(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start Blind Reveal.");
      await onReload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="reveal-stage">
      <p className="eyebrow">One question, two answers.</p>
      <h1 className="h-intimate reveal-headline">Both write it. Then it opens.</h1>
      <form className="reveal-prompt" onSubmit={submit}>
        <p className="reveal-prompt-eyebrow">The question</p>
        <p className="reveal-prompt-helper">Don&apos;t like this question? Write your own.</p>
        <textarea
          className="input min-h-[96px] resize-none"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          aria-label="The question"
          autoCapitalize="none"
          autoCorrect="on"
          spellCheck
          inputMode="text"
        />
        {error && <p className="mt-2 text-sm" role="alert" aria-live="assertive" style={{ color: "rgb(var(--no-rgb))" }}>{error}</p>}
        <button type="submit" className="btn-primary mt-3 w-full" disabled={busy || !prompt.trim()}>
          {busy ? "Starting..." : "Start Blind Reveal"}
        </button>
      </form>
      <RevealHistory reveals={state.reveals} onRevealSelect={onRevealSelect} highlightedRevealId={highlightedRevealId} />
    </div>
  );
}

function RevealHistory({
  reveals,
  onRevealSelect,
  highlightedRevealId,
  currentRevealId = "",
}: {
  reveals: BlindReveal[];
  onRevealSelect: (reveal: BlindReveal) => void;
  highlightedRevealId: string;
  currentRevealId?: string;
}) {
  const archived = reveals.filter((reveal) => reveal.status !== "open" && reveal.id !== currentRevealId).slice(0, 6);
  if (!archived.length) return null;
  return (
    <section className="blind-history-section" aria-label="Blind Reveal history">
      <p className="eyebrow">Recent reveals</p>
      <div className="blind-history-list">
        {archived.map((reveal) => (
          <RevealHistoryCard
            key={reveal.id}
            reveal={reveal}
            onRevealSelect={onRevealSelect}
            highlighted={reveal.id === highlightedRevealId}
          />
        ))}
      </div>
    </section>
  );
}

function RevealHistoryCard({
  reveal,
  onRevealSelect,
  highlighted,
}: {
  reveal: BlindReveal;
  onRevealSelect: (reveal: BlindReveal) => void;
  highlighted: boolean;
}) {
  const cardRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!highlighted) return;
    const timer = window.setTimeout(() => {
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 260);
    return () => window.clearTimeout(timer);
  }, [highlighted]);

  return (
    <button
      type="button"
      ref={cardRef}
      className={`blind-history-card pressable ${highlighted ? "is-activity-highlight" : ""}`}
      data-activity-highlight={highlighted ? "true" : undefined}
      onClick={() => onRevealSelect(reveal)}
      aria-label={`Open ${reveal.status === "archived" ? "closed" : "opened"} Blind Reveal: ${reveal.prompt}`}
    >
      <div className="blind-history-card-head">
        <span>{reveal.status === "archived" ? "Closed" : "Opened"}</span>
        <span>{formatWhen(reveal.updatedAt || reveal.revealedAt || reveal.createdAt)}</span>
      </div>
      <p className="blind-history-prompt">{reveal.prompt}</p>
      <p className="blind-history-meta">
        {reveal.submittedCount}/{reveal.requiredCount} locked
      </p>
    </button>
  );
}

function ActiveReveal({
  state,
  onReload,
  onRevealChange,
  onRevealSelect,
  highlightedRevealId,
}: {
  state: Extract<LoadState, { kind: "ready" }>;
  onReload: () => Promise<void>;
  onRevealChange: (result: BlindRevealResponse) => void;
  onRevealSelect: (reveal: BlindReveal) => void;
  highlightedRevealId: string;
}) {
  const reveal = state.reveal!;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const isHighlighted = reveal.id === highlightedRevealId;
  const partner = partnerOf(state.workspace, state.auth.email);
  const partnerName = partner?.displayName?.split(" ")[0] || "your partner";
  const partnerLockedLabel = partnerName === "your partner" ? "Partner locked" : `${partnerName} locked`;
  const partnerStatusLabel = reveal.partnerSubmitted ? partnerLockedLabel : `Waiting on ${partnerName}`;
  const [answer, setAnswer] = useState(reveal.myEntry?.text || "");
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!answer.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await submitBlindReveal({ workspaceId: state.workspace.id, id: reveal.id, text: answer.trim() });
      if (navigator.vibrate) navigator.vibrate([6, 16, 8]);
      onRevealChange(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't lock this in.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (busy || cancelling) return;
    const message = reveal.partnerSubmitted
      ? `${partnerName} already locked in an answer. Take this Blind Reveal back anyway? Their answer is discarded.`
      : "Take back this Blind Reveal? It's removed for both of you.";
    if (!window.confirm(message)) return;
    setCancelling(true);
    setError(null);
    try {
      const result = await cancelBlindReveal({ workspaceId: state.workspace.id, id: reveal.id });
      if (navigator.vibrate) navigator.vibrate(8);
      onRevealChange(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't take it back.");
    } finally {
      setCancelling(false);
    }
  }

  useEffect(() => {
    if (!isHighlighted) return;
    const timer = window.setTimeout(() => {
      stageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 260);
    return () => window.clearTimeout(timer);
  }, [isHighlighted]);

  return (
    <div ref={stageRef} className={`reveal-stage reveal-active-stage ${isHighlighted ? "is-activity-highlight" : ""}`} data-activity-highlight={isHighlighted ? "true" : undefined}>
      <p className="eyebrow">Reveal time · <em>{reveal.submittedCount}/{reveal.requiredCount} locked</em></p>
      <h1 className="h-intimate reveal-headline">Both write it. Then it opens.</h1>
      <div className="reveal-prompt">
        <p className="reveal-prompt-eyebrow">The question</p>
        <p className="reveal-prompt-text">{reveal.prompt}</p>
      </div>

      <div className="reveal-pair">
        <div className="reveal-side reveal-mine">
          <p className="reveal-side-label">You wrote</p>
          {reveal.mySubmitted ? (
            <div className="reveal-textbox locked">
              <div className="reveal-cover" />
              <p className="reveal-text">{reveal.myEntry?.text}</p>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-3">
              <textarea
                className="input min-h-[132px] resize-none"
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder="Write your answer. It locks until both sides are in."
                aria-label="Your answer"
                autoCapitalize="none"
                autoCorrect="on"
                spellCheck
                inputMode="text"
              />
              {error && <p className="text-sm" role="alert" aria-live="assertive" style={{ color: "rgb(var(--no-rgb))" }}>{error}</p>}
              <button type="submit" className="btn-primary w-full" disabled={!answer.trim() || busy}>
                {busy ? "Locking..." : "Lock in"}
              </button>
            </form>
          )}
        </div>

        <div className="reveal-side reveal-theirs">
          <p className="reveal-side-label">Partner</p>
          <div
            className={`reveal-textbox reveal-partner-box ${reveal.partnerSubmitted ? "locked" : "is-waiting"}`}
            aria-label={partnerStatusLabel}
          >
            <div className="reveal-cover" aria-hidden="true" />
            <div className="reveal-redacted" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div className="reveal-waiting-overlay" role="status" aria-live="polite">
              <span className="status-pill reveal-status-pill"><span className="dot" />{partnerStatusLabel}</span>
            </div>
          </div>
        </div>
      </div>
      {reveal.startedByMe && reveal.status === "open" && (
        <button
          type="button"
          className="btn-ghost w-full"
          style={{ marginTop: 14 }}
          onClick={cancel}
          disabled={busy || cancelling}
          data-testid="blind-reveal-cancel"
        >
          {cancelling ? "Taking it back…" : "Take back this reveal"}
        </button>
      )}
      <RevealHistory
        reveals={state.reveals}
        onRevealSelect={onRevealSelect}
        highlightedRevealId={highlightedRevealId}
        currentRevealId={reveal.id}
      />
    </div>
  );
}

/* Drop-in replacement for `OpenedReveal` in
   `web/src/app/games/blind-reveal/page.tsx`.

   Replaces lines 384 → ~475 of the existing file. Same external API as
   before (state + onReload + onRevealChange + highlightedRevealId props).

   Visual direction is "by candle":
     – The stage darkens (radial plum vignette).
     – Two flames flicker above each answer.
     – A warm pool of light breathes over both answers.
     – Italic answers rise from blur into focus on mount.
     – When the user hits "Close this reveal", the room dims first
       (text fades to ~0.3 opacity + 4px blur, flames lower, status
       swaps from "open" to "sealed") before the actual archive request
       runs. The dim beat is what gives "read once · then sealed" weight.

   Pairs with the .reveal-candle / .candle-* selectors in reveals.css.
   Keep the rest of blind-reveal/page.tsx untouched. */

function OpenedReveal({
  state,
  onReload,
  onRevealChange,
  onRevealSelect,
  highlightedRevealId,
}: {
  state: Extract<LoadState, { kind: "ready" }>;
  onReload: () => Promise<void>;
  onRevealChange: (result: BlindRevealResponse) => void;
  onRevealSelect: (reveal: BlindReveal) => void;
  highlightedRevealId: string;
}) {
  const reveal = state.reveal!;
  const [busy, setBusy] = useState("");
  const [closing, setClosing] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const stageRef = useRef<HTMLDivElement | null>(null);
  const isHighlighted = reveal.id === highlightedRevealId;
  const isArchived = reveal.status === "archived";
  const myEmail = normalizeEmail(state.auth.email);
  const myEntry = reveal.entries.find((entry) => normalizeEmail(entry.email) === myEmail);

  useEffect(() => {
    if (navigator.vibrate) navigator.vibrate([8, 24, 8]);
  }, []);

  useEffect(() => {
    if (!isHighlighted) return;
    const timer = window.setTimeout(() => {
      stageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 260);
    return () => window.clearTimeout(timer);
  }, [isHighlighted]);

  async function promote() {
    if (!myEntry || busy) return;
    setArchiveError("");
    setBusy("promote");
    try {
      const result = await promoteBlindRevealEntry({ workspaceId: state.workspace.id, id: reveal.id });
      if (navigator.vibrate) navigator.vibrate([6, 16, 8]);
      onRevealChange(result);
    } finally {
      setBusy("");
    }
  }

  async function archive() {
    if (busy || closing) return;
    setClosing(true);
    setArchiveError("");
    setBusy("archive");
    // Let the dim/seal beat play before the request resolves so the user
    // sees the room "go quiet" instead of a jarring route change.
    await new Promise((resolve) => window.setTimeout(resolve, 720));
    try {
      const result = await archiveBlindReveal({ workspaceId: state.workspace.id, id: reveal.id });
      onRevealChange(result);
    } catch {
      setClosing(false);
      setArchiveError("Couldn't close this reveal. Try again.");
    } finally {
      setBusy("");
    }
  }

  return (
    <div
      ref={stageRef}
      className={[
        "reveal-stage",
        "state-opened",
        "reveal-candle",
        closing ? "is-closing" : "",
        isHighlighted ? "is-activity-highlight" : "",
      ].filter(Boolean).join(" ")}
      data-activity-highlight={isHighlighted ? "true" : undefined}
    >
      <p className="eyebrow candle-eyebrow">
        {isArchived ? "closed reveal" : "two answers"} · <em>by candle</em>
      </p>

      <p className="reveal-prompt-text candle-prompt">{reveal.prompt}</p>

      <div className="candle-pool" aria-hidden="true" />

      <div className="reveal-pair candle-pair">
        {reveal.entries.map((entry, index) => {
          const isMine = normalizeEmail(entry.email) === myEmail;
          return (
            <article
              key={entry.email}
              className={`candle-answer ${isMine ? "is-mine" : "is-theirs"}`}
              style={{ "--i": index } as CSSProperties}
            >
              <span className="candle-flame" aria-hidden="true" />
              <p className="candle-side">{isMine ? "you" : entry.name || "partner"}</p>
              <p className="candle-text">{entry.text}</p>
            </article>
          );
        })}
      </div>

      <div className="candle-status" aria-live="polite">
        <span className="candle-status-open">
          {isArchived ? <>closed · <em>reopened from history</em></> : <>two · <em>locked in</em> · open</>}
        </span>
        {!isArchived && <span className="candle-status-close">read once · <em>then sealed</em></span>}
      </div>

      {!isArchived && (
        <div className="reveal-cta candle-cta">
          {myEntry && (
            <button
              type="button"
              className="btn-primary w-full"
              onClick={promote}
              disabled={Boolean(busy) || Boolean(myEntry.promotedIdeaId)}
            >
              {myEntry.promotedIdeaId
                ? "Saved to Inspiration"
                : busy === "promote"
                ? "Saving..."
                : "Save mine to Inspiration"}
            </button>
          )}
          <button
            type="button"
            className="btn-ghost mt-2 w-full"
            onClick={archive}
            disabled={Boolean(busy)}
          >
            {busy === "archive" ? "Closing..." : "Close this reveal"}
          </button>
          {archiveError && (
            <p className="text-sm mt-2" role="alert" aria-live="assertive" style={{ color: "rgb(var(--no-rgb))" }}>
              {archiveError}
            </p>
          )}
        </div>
      )}
      <RevealHistory
        reveals={state.reveals}
        onRevealSelect={onRevealSelect}
        highlightedRevealId={highlightedRevealId}
        currentRevealId={reveal.id}
      />
    </div>
  );
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
