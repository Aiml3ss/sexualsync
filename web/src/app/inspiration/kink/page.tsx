"use client";

import { FormEvent, KeyboardEvent, Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import AppShell from "@/components/AppShell";
import { EmptyState, ErrorState, SkeletonList } from "@/components/States";
import {
  ApiUnauthorizedError,
  addKinkComment,
  clearKinkReaction,
  deleteKink,
  getBootstrap,
  getFantasyBacklog,
  updateKinkComment,
  updateKinkText,
  updateKinkReaction,
} from "@/lib/api";
import { getProfileCached } from "@/lib/profile-cache";
import { getCachedResource, setCachedResource, useColdStart } from "@/lib/resource-cache";
import type {
  AuthInfo,
  FantasyBacklogResponse,
  KinkComment,
  KinkIdea,
  KinkReaction,
  KinkReactionOption,
  ProfileResponse,
  Workspace,
} from "@/lib/types";
import { useFocusActivity } from "@/lib/use-focus-activity";
import { useLiveRoomReload } from "@/lib/use-live-room";
import { normalizeEmail, partnerOf } from "@/lib/workspace";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unauthorized" }
  | { kind: "missing" }
  | { kind: "no-workspace"; auth: AuthInfo }
  | {
      kind: "ready";
      auth: AuthInfo;
      workspace: Workspace;
      backlog: FantasyBacklogResponse;
      kink: KinkIdea;
      shareAttentionSignals: boolean;
    };

export default function KinkQueryPage() {
  return (
    <Suspense fallback={<KinkShell><SkeletonList count={3} /></KinkShell>}>
      <KinkByQuery />
    </Suspense>
  );
}

function KinkByQuery() {
  const params = useSearchParams();
  const router = useRouter();
  const id = params.get("id") || "";
  const highlightedFromActivity = params.get("activity") === "1";
  const resourceKey = kinkResourceKey(id);
  const [state, setState] = useState<LoadState>(() => cachedKinkState(resourceKey, id) ?? { kind: "loading" });
  useColdStart(resourceKey, setState);
  useEffect(() => {
    if (state.kind !== "ready") return;
    setCachedResource(resourceKey, state);
    updateCachedInspirationBacklog(state.backlog);
  }, [resourceKey, state]);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => {
    setState({ kind: "loading" });
    setReloadKey((value) => value + 1);
  };

  function applyBacklog(backlog: FantasyBacklogResponse) {
    const kink = backlog.ideas.find((candidate) => candidate.id === id);
    setState((current) => {
      if (current.kind !== "ready") return current;
      const next: LoadState = kink
        ? { ...current, backlog, kink }
        : { kind: "missing" };
      if (next.kind === "ready") {
        setCachedResource(resourceKey, next);
        updateCachedInspirationBacklog(backlog);
      }
      return next;
    });
  }

  useEffect(() => {
    // Keyed on [id]: switching kinks aborts the prior fetch so a slow response
    // for the old id can't land on top of the new one. `cancelled` guards the
    // calls (getFantasyBacklog) that don't accept a signal.
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
        const backlog = await loadKinkBacklog(profile.activeWorkspace.id, controller.signal);
        if (cancelled) return;
        const kink = backlog.ideas.find((candidate) => candidate.id === id);
        const next: LoadState = kink
          ? {
              kind: "ready",
              auth: profile.auth,
              workspace: profile.activeWorkspace,
              backlog,
              kink,
              shareAttentionSignals: profile.profile?.settings?.shareAttentionSignals !== false,
            }
          : { kind: "missing" };
        setState(next);
        if (next.kind === "ready") {
          setCachedResource(resourceKey, next);
          updateCachedInspirationBacklog(backlog);
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiUnauthorizedError) {
          setState({ kind: "unauthorized" });
          return;
        }
        setState({ kind: "error", message: error instanceof Error ? error.message : "Something went sideways." });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [id, reloadKey]);

  return (
    <KinkShell>
      <Body
        state={state}
        onBacklogChange={applyBacklog}
        onArchive={() => router.push("/inspiration")}
        onReload={reload}
        highlightedFromActivity={highlightedFromActivity}
      />
    </KinkShell>
  );
}

function KinkShell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell hideTabBar>
      <header className="sheet-header">
        <Link href="/inspiration" className="fd-back pressable" aria-label="Back">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <span className="sheet-title">Kink</span>
        <span className="sheet-header-spacer" aria-hidden="true" />
      </header>
      {children}
    </AppShell>
  );
}

async function loadKinkBacklog(workspaceId: string, signal?: AbortSignal): Promise<FantasyBacklogResponse> {
  try {
    // getFantasyBacklog has no signal hook; the [id]-keyed effect's `cancelled`
    // guard drops any stale result it returns.
    return await getFantasyBacklog(workspaceId);
  } catch {
    try {
      const bootstrap = await getBootstrap(signal);
      if (bootstrap.bootstrap?.workspaceId === workspaceId || bootstrap.activeWorkspaceId === workspaceId) {
        return bootstrap.bootstrap?.fantasy || emptyBacklog(workspaceId);
      }
    } catch {}
    return emptyBacklog(workspaceId);
  }
}

function emptyBacklog(workspaceId: string): FantasyBacklogResponse {
  return { workspaceId, reactionCatalog: [], ideas: [], graveyard: [] };
}

function kinkResourceKey(id: string) {
  return `kink:${id || "unknown"}`;
}

function cachedKinkState(resourceKey: string, id: string): LoadState | undefined {
  const direct = getCachedResource<LoadState>(resourceKey);
  if (direct) return direct;

  const inspiration = getCachedResource<{
    kind: string;
    auth?: AuthInfo;
    workspace?: Workspace;
    backlog?: FantasyBacklogResponse;
  }>("inspiration");
  if (inspiration?.kind !== "ready" || !inspiration.auth || !inspiration.workspace || !inspiration.backlog) {
    return undefined;
  }
  const kink = inspiration.backlog.ideas.find((candidate) => candidate.id === id);
  if (!kink) return undefined;
  return {
    kind: "ready",
    auth: inspiration.auth,
    workspace: inspiration.workspace,
    backlog: inspiration.backlog,
    kink,
    shareAttentionSignals: true,
  };
}

function updateCachedInspirationBacklog(backlog: FantasyBacklogResponse) {
  const inspiration = getCachedResource<{
    kind: string;
    backlog?: FantasyBacklogResponse;
  }>("inspiration");
  if (inspiration?.kind === "ready") {
    setCachedResource("inspiration", { ...inspiration, backlog });
  }
}

function updateKinkInBacklog(
  backlog: FantasyBacklogResponse,
  kinkId: string,
  update: (kink: KinkIdea) => KinkIdea,
): FantasyBacklogResponse {
  return {
    ...backlog,
    ideas: backlog.ideas.map((item) => (item.id === kinkId ? update(item) : item)),
  };
}

function Body({
  state,
  onBacklogChange,
  onArchive,
  onReload,
  highlightedFromActivity,
}: {
  state: LoadState;
  onBacklogChange: (backlog: FantasyBacklogResponse) => void;
  onArchive: () => void;
  onReload: () => void;
  highlightedFromActivity: boolean;
}) {
  if (state.kind === "loading") return <SkeletonList count={3} />;
  if (state.kind === "unauthorized") {
    return (
      <ErrorState
        title="Session expired"
        body="Sign in again to see this Kink."
        action={<Link href="/" className="btn-ghost">Back to sign-in</Link>}
      />
    );
  }
  if (state.kind === "missing") {
    return (
      <EmptyState
        title="Kink not found"
        body="It may have been deleted or moved out of Inspiration."
        action={<Link href="/inspiration" className="btn-ghost">Back to Inspiration</Link>}
      />
    );
  }
  if (state.kind === "no-workspace") {
    return (
      <EmptyState
        title="Set up your space"
        body="You're signed in, but you don't have a partner-paired space yet."
        action={<Link href="/space" className="btn-ghost">Open Space</Link>}
      />
    );
  }
  if (state.kind === "error") {
    return (
      <ErrorState
        title="Couldn't load Kink"
        body={state.message}
        action={<button className="btn-ghost" onClick={onReload}>Try again</button>}
      />
    );
  }
  return (
    <KinkDetail
      state={state}
      onBacklogChange={onBacklogChange}
      onArchive={onArchive}
      highlightedFromActivity={highlightedFromActivity}
    />
  );
}

function KinkDetail({
  state,
  onBacklogChange,
  onArchive,
  highlightedFromActivity,
}: {
  state: Extract<LoadState, { kind: "ready" }>;
  onBacklogChange: (backlog: FantasyBacklogResponse) => void;
  onArchive: () => void;
  highlightedFromActivity: boolean;
}) {
  const [comment, setComment] = useState("");
  const [savingReaction, setSavingReaction] = useState("");
  const [savingComment, setSavingComment] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(state.kink.text);
  const [busyIdea, setBusyIdea] = useState("");
  const [reactionError, setReactionError] = useState("");
  const [commentError, setCommentError] = useState("");
  const [editError, setEditError] = useState("");
  const [archiveError, setArchiveError] = useState("");
  const me = normalizeEmail(state.auth.email);
  const partner = partnerOf(state.workspace, state.auth.email);
  const partnerName = partner?.displayName?.split(" ")[0] || "your partner";
  const partnerPossessive = possessiveName(partnerName);
  const activeReaction = state.kink.reactions.find((reaction) => normalizeEmail(reaction.by) === me) || null;
  const active = responseForEmail(state.kink, me);
  // Optimistic reaction state, ported from _VaultCard. We render this over the
  // prop-derived id until the server response lands so the emoji lights
  // instantly instead of after a 0.5-1.5s round trip. `undefined` means "defer
  // to the prop"; any other value (option id or null) overrides until reconciled.
  const [pendingReaction, setPendingReaction] = useState<string | null | undefined>(undefined);
  const propReactionId = active?.id ?? null;
  const myReactionId = pendingReaction !== undefined ? pendingReaction : propReactionId;
  const optimisticOption = myReactionId
    ? state.backlog.reactionCatalog.find((option) => option.id === myReactionId) || null
    : null;
  const partnerResponses = Array.from(allKinkResponses(state.kink).values())
    .filter((reaction) => normalizeEmail(reaction.email) !== me);
  const primaryPartnerResponse = partnerResponses[0] || null;
  const partnerComment = partner ? latestCommentFrom(state.kink, partner.email) : null;
  const partnerRepliedInComments = Boolean(partnerComment);
  const mine = normalizeEmail(state.kink.addedByEmail) === me;
  // "From → to" identity line: kink author, then who it's aimed at (their
  // partner). When the partner authored it, it's aimed at the viewer ("you").
  const authorFirst = (state.kink.addedByName || "Someone").trim().split(/\s+/)[0] || "Someone";
  const recipientFirst = mine ? partnerName : "you";
  const liveCaption = mine
    ? primaryPartnerResponse?.caption
      || (partnerRepliedInComments
        ? `${partnerName} replied in comments.`
        : `${partnerPossessive} reaction will show here once she reacts.`)
    : (myReactionId ? active?.caption || optimisticOption?.label : null)
      || "Choose how it lands. Your partner sees the label, not just the emoji.";

  useEffect(() => {
    // Reconcile: once the server-driven prop matches our optimistic value,
    // drop the override so future re-renders pick up directly from the prop.
    if (pendingReaction !== undefined && pendingReaction === propReactionId) {
      queueMicrotask(() => setPendingReaction(undefined));
    }
  }, [pendingReaction, propReactionId]);

  useFocusActivity({
    workspaceId: state.workspace.id,
    entityId: state.kink.id,
    resource: "fantasy-backlog",
    enabled: state.shareAttentionSignals && !mine && !activeReaction,
    sampleBucket: "kink-detail",
    minMs: 45_000,
    maxMs: 150_000,
  });

  // Re-fetch the backlog and re-derive this single record. Feeding the fresh
  // backlog through onBacklogChange reuses applyBacklog, so partner reactions
  // and comments land in this view without a manual refresh.
  const workspaceId = state.workspace.id;
  const reloadBacklog = useCallback(async () => {
    const backlog = await loadKinkBacklog(workspaceId);
    onBacklogChange(backlog);
  }, [workspaceId, onBacklogChange]);

  // Live subscription: partner reactions/comments push a reload while this
  // detail view is open (mirrors the Shelf page's fantasy-backlog wiring).
  useLiveRoomReload({
    workspaceId: state.workspace.id,
    actorEmail: state.auth.email,
    resources: ["fantasy-backlog"],
    onReload: reloadBacklog,
  });

  // visibilitychange floor: catch anything missed while the tab was hidden
  // (socket dropped, phone asleep) the moment the user returns.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") void reloadBacklog();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reloadBacklog]);

  async function react(option: KinkReactionOption) {
    if (savingReaction) return;
    // Snapshot the prior prop-derived id so we can roll back on server error.
    const prior = propReactionId;
    // Toggle off the effective (optimistic) selection, matching _VaultCard, so
    // rapid taps before the round-trip resolves still flip the right way.
    const clearing = myReactionId === option.id;
    const next = clearing ? null : option.id;
    setReactionError("");
    setPendingReaction(next);
    setSavingReaction(option.id);
    if (navigator.vibrate) navigator.vibrate(clearing ? 4 : [6, 16, 8]);
    try {
      const backlog = clearing
        ? await clearKinkReaction({ workspaceId: state.workspace.id, id: state.kink.id })
        : await updateKinkReaction({
            workspaceId: state.workspace.id,
            id: state.kink.id,
            by: state.auth.email,
            label: option.label,
          });
      onBacklogChange(backlog);
      // pendingReaction clears automatically once the new prop arrives — see
      // the reconcile effect above.
    } catch {
      // Server rejected the write — roll back to whatever the prop said before
      // the optimistic flip and surface a visible error.
      setPendingReaction(prior);
      setReactionError("Couldn't save that reaction. Try again.");
    } finally {
      setSavingReaction("");
    }
  }

  async function submitComment(event: FormEvent) {
    event.preventDefault();
    const clean = comment.trim();
    if (!clean || savingComment) return;
    const previousBacklog = state.backlog;
    const optimisticComment: KinkComment = {
      id: `optimistic-${Date.now()}`,
      email: state.auth.email,
      name: state.auth.person || "You",
      text: clean,
      at: new Date().toISOString(),
    };
    const optimisticBacklog = updateKinkInBacklog(state.backlog, state.kink.id, (kink) => ({
      ...kink,
      comments: [...(kink.comments || []), optimisticComment],
      updatedAt: optimisticComment.at,
    }));
    setCommentError("");
    setComment("");
    onBacklogChange(optimisticBacklog);
    setSavingComment(true);
    try {
      const backlog = await addKinkComment({ workspaceId: state.workspace.id, id: state.kink.id, comment: clean });
      if (navigator.vibrate) navigator.vibrate(4);
      onBacklogChange(backlog);
    } catch {
      // Keep the draft so the typed comment isn't lost on a flaky connection.
      onBacklogChange(previousBacklog);
      setComment(clean);
      setCommentError("Couldn't add that comment. Try again.");
    } finally {
      setSavingComment(false);
    }
  }

  async function saveCommentEdit(commentId: string, nextText: string) {
    const clean = nextText.trim();
    if (!clean) throw new Error("Comment text is required");
    const backlog = await updateKinkComment({
      workspaceId: state.workspace.id,
      id: state.kink.id,
      commentId,
      comment: clean,
    });
    if (navigator.vibrate) navigator.vibrate(4);
    onBacklogChange(backlog);
  }

  async function saveEdit(event: FormEvent) {
    event.preventDefault();
    const clean = editText.trim();
    if (!mine || !clean || busyIdea) return;
    setEditError("");
    setBusyIdea("edit");
    try {
      const backlog = await updateKinkText({ workspaceId: state.workspace.id, id: state.kink.id, text: clean });
      setEditing(false);
      onBacklogChange(backlog);
    } catch {
      // Stay in edit mode with the draft intact so the rewrite isn't lost.
      setEditError("Couldn't save that edit. Try again.");
    } finally {
      setBusyIdea("");
    }
  }

  async function buryIdea() {
    if (!mine || busyIdea) return;
    setArchiveError("");
    setBusyIdea("delete");
    try {
      const backlog = await deleteKink({ workspaceId: state.workspace.id, id: state.kink.id });
      onBacklogChange(backlog);
      if (navigator.vibrate) navigator.vibrate(4);
      onArchive();
    } catch {
      setArchiveError("Couldn't archive this. Try again.");
    } finally {
      setBusyIdea("");
    }
  }

  return (
    <div
      className={`kd-stage kd-premium ${highlightedFromActivity ? "is-activity-highlight" : ""}`}
      data-activity-highlight={highlightedFromActivity ? "true" : undefined}
    >
      <div className="kd-atmo" aria-hidden="true">
        <span className="kd-atmo-bloom" />
        <span className="kd-atmo-grain" />
      </div>

      <div className="kd-meta-row">
        <span className="kd-author-chip" aria-hidden="true">{authorFirst.charAt(0)}</span>
        <span className="kd-author">
          <span className="kd-author-names">
            {authorFirst}
            <span className="kd-arrow" aria-hidden="true">→</span>
            {recipientFirst}
          </span>
          <span className="kd-author-age">{relativeAge(state.kink.createdAt)}</span>
        </span>
      </div>

      {editing ? (
        <form className="kd-editor" onSubmit={saveEdit}>
          <textarea
            className="input min-h-[132px] resize-none"
            value={editText}
            onChange={(event) => setEditText(event.target.value)}
            aria-label="Edit kink"
            autoCapitalize="none"
            autoCorrect="on"
            spellCheck
            inputMode="text"
          />
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn-ghost flex-1" onClick={() => { setEditing(false); setEditText(state.kink.text); }} disabled={Boolean(busyIdea)}>
              Cancel
            </button>
            <button type="submit" className="btn-primary flex-1" disabled={!editText.trim() || Boolean(busyIdea)}>
              {busyIdea === "edit" ? "Saving..." : "Save"}
            </button>
          </div>
          {editError && (
            <p className="text-sm mt-2" role="alert" aria-live="assertive" style={{ color: "rgb(var(--no-rgb))" }}>
              {editError}
            </p>
          )}
        </form>
      ) : (
        <p className="kd-body-lead">{state.kink.text}</p>
      )}

      <p className="eyebrow kd-eyebrow">How this lands</p>
      <p className="kd-live-caption" aria-live="polite">
        {liveCaption}
      </p>

      <div className="kd-tray-wrap">
        {mine ? (
          <div className={`kd-tray kd-tray-readonly ${primaryPartnerResponse ? responseTrayClass(primaryPartnerResponse) : partnerRepliedInComments ? "is-commented" : "is-waiting"}`} role="status" aria-label="Partner response to this Kink">
            {partnerResponses.length ? partnerResponses.map((reaction) => (
              <span
                key={`${reaction.email}-${reaction.id}`}
                className={`reaction is-active is-readonly ${reaction.tone === "no" ? "is-pass" : ""}`}
                aria-label={reaction.label}
              >
                <span className="reaction-emoji">{reaction.glyph}</span>
              </span>
            )) : partnerRepliedInComments ? (
              <span className="kd-tray-empty is-commented">
                <span className="kd-comment-dot" aria-hidden="true" />
                <span>Replied in comments</span>
              </span>
            ) : (
              <span className="kd-tray-empty is-waiting">
                <span className="kd-waiting-dot" aria-hidden="true" />
                <span>Waiting on {partnerName}</span>
              </span>
            )}
          </div>
        ) : (
          <div className="kd-tray" role="group" aria-label="React to this Kink">
            {state.backlog.reactionCatalog.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`reaction pressable ${myReactionId === option.id ? "is-active" : ""} ${option.tone === "no" ? "is-pass" : ""}`}
                onClick={() => react(option)}
                aria-pressed={myReactionId === option.id}
                aria-label={option.label}
                disabled={Boolean(savingReaction)}
              >
                <span className="reaction-emoji">{option.glyph}</span>
              </button>
            ))}
          </div>
        )}
        {mine
          ? primaryPartnerResponse && <p className="kd-tray-label">{primaryPartnerResponse.label}</p>
          : (active?.label || optimisticOption?.label) && (
              <p className="kd-tray-label">{active?.label || optimisticOption?.label}</p>
            )}
        {reactionError && (
          <p className="text-sm mt-2" role="alert" aria-live="assertive" style={{ color: "rgb(var(--no-rgb))" }}>
            {reactionError}
          </p>
        )}
      </div>

      <section className="kd-section">
        <p className="eyebrow">Comments · <em>{state.kink.comments.length}</em></p>
        <div className="kd-thread">
          {state.kink.comments.map((entry) => (
            <CommentBubble key={entry.id} entry={entry} me={me} onEdit={saveCommentEdit} />
          ))}
          <form className="kd-reply-form" onSubmit={submitComment}>
            <textarea
              className="input min-h-[92px] resize-none"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Leave a note…"
              aria-label="Leave a comment"
              autoCapitalize="none"
              autoCorrect="on"
              spellCheck
              inputMode="text"
            />
            <div className="kd-reply-actions">
              <button type="submit" className="kd-comment-submit" disabled={!comment.trim() || savingComment}>
                {savingComment ? "Adding…" : "Add comment"}
              </button>
            </div>
            {mine && !editing && (
              <div className="kd-owner-row">
                <button type="button" className="kd-owner-button" onClick={() => setEditing(true)} disabled={Boolean(busyIdea)}>
                  Edit
                </button>
                <span className="kd-owner-sep" aria-hidden="true" />
                <button type="button" className="kd-owner-button kd-archive-button" onClick={buryIdea} disabled={Boolean(busyIdea)}>
                  {busyIdea === "delete" ? "Moving…" : "Move to archive"}
                </button>
              </div>
            )}
            {commentError && (
              <p className="text-sm mt-2" role="alert" aria-live="assertive" style={{ color: "rgb(var(--no-rgb))" }}>
                {commentError}
              </p>
            )}
            {archiveError && (
              <p className="text-sm mt-2" role="alert" aria-live="assertive" style={{ color: "rgb(var(--no-rgb))" }}>
                {archiveError}
              </p>
            )}
          </form>
        </div>
      </section>

    </div>
  );
}

function possessiveName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return "Your partner's";
  return trimmed.endsWith("s") || trimmed.endsWith("S") ? `${trimmed}'` : `${trimmed}'s`;
}

function CommentBubble({
  entry,
  me,
  onEdit,
}: {
  entry: KinkComment;
  me: string;
  onEdit: (commentId: string, text: string) => Promise<void>;
}) {
  const own = normalizeEmail(entry.email) === me;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!editing) setDraft(entry.text);
  }, [editing, entry.text]);

  function startEditing() {
    if (!own || editing || busy) return;
    setDraft(entry.text);
    setError("");
    setEditing(true);
  }

  function handleBubbleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!own || editing) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      startEditing();
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const clean = draft.trim();
    if (!own || !clean || busy) return;
    setBusy(true);
    setError("");
    try {
      await onEdit(entry.id, clean);
      setEditing(false);
    } catch {
      setError("Couldn't save that edit. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`kd-msg ${own ? "kd-msg-you kd-msg-editable" : "kd-msg-her"}`}
      role={own && !editing ? "button" : undefined}
      tabIndex={own && !editing ? 0 : undefined}
      aria-label={own && !editing ? "Edit comment" : undefined}
      onClick={own && !editing ? startEditing : undefined}
      onKeyDown={handleBubbleKeyDown}
    >
      <p className="kd-msg-author">
        {entry.name || (own ? "You" : "Partner")} · {relativeAge(entry.at)}
        {entry.editedAt ? " · edited" : ""}
      </p>
      {editing ? (
        <form className="kd-comment-edit-form" onSubmit={save}>
          <textarea
            className="input min-h-[84px] resize-none"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="Edit comment"
            autoCapitalize="none"
            autoCorrect="on"
            spellCheck
            inputMode="text"
            maxLength={700}
            autoFocus
          />
          <div className="kd-comment-edit-actions">
            <button
              type="button"
              className="kd-msg-action"
              onClick={() => { setEditing(false); setDraft(entry.text); setError(""); }}
              disabled={busy}
            >
              Cancel
            </button>
            <button type="submit" className="kd-msg-action" disabled={busy || !draft.trim()}>
              {busy ? "Saving..." : "Save"}
            </button>
          </div>
          {error && (
            <p className="text-sm mt-2" role="alert" aria-live="assertive" style={{ color: "rgb(var(--no-rgb))" }}>
              {error}
            </p>
          )}
        </form>
      ) : (
        <p className="kd-msg-body">{entry.text}</p>
      )}
    </div>
  );
}

type KinkResponse = {
  email: string;
  name: string;
  id: string;
  glyph: string;
  label: string;
  caption: string;
  tone: "positive" | "pause" | "no";
};

function responseTrayClass(response: KinkResponse) {
  if (response.label === "Tell me more" || response.label === "Curious") return "is-curious";
  if (response.label === "Hell yeah" || response.label === "Me too") return "is-hell-yeah";
  if (response.tone === "pause") return "is-later";
  if (response.tone === "no") return "is-pass";
  return "";
}

function responseForEmail(kink: KinkIdea, email: string) {
  return allKinkResponses(kink).get(normalizeEmail(email)) || null;
}

function latestCommentFrom(kink: KinkIdea, email: string) {
  const actor = normalizeEmail(email);
  if (!actor) return null;
  return [...(kink.comments || [])].reverse().find((entry) => normalizeEmail(entry.email) === actor) || null;
}

function allKinkResponses(kink: KinkIdea) {
  const responses = new Map<string, KinkResponse>();
  const author = normalizeEmail(kink.addedByEmail);
  for (const entry of kink.statusHistory || []) {
    const email = normalizeEmail(entry.email);
    if (!email) continue;
    if (author && email === author) continue;
    responses.set(email, statusToResponse(entry.status, email, entry.name, entry.glyph, entry.caption));
  }
  if (kink.status && kink.statusByEmail) {
    const email = normalizeEmail(kink.statusByEmail);
    if (!author || email !== author) {
      responses.set(email, statusToResponse(kink.status, email, kink.statusByName || ""));
    }
  }
  for (const reaction of kink.reactions || []) {
    const email = normalizeEmail(reaction.by);
    if (!email) continue;
    if (author && email === author) continue;
    responses.set(email, reactionToResponse(reaction, email));
  }
  return responses;
}

function reactionToResponse(reaction: KinkReaction, email: string): KinkResponse {
  const label = normalizeReactionLabel(reaction.label || reaction.id);
  const name = "";
  return {
    email,
    name,
    id: reaction.id || idForLabel(label),
    glyph: reaction.glyph || glyphForLabel(label),
    label,
    caption: reaction.caption || captionForLabel(label, name),
    tone: reaction.tone || toneForLabel(label),
  };
}

function statusToResponse(status: string, email: string, name = "", glyph = "", caption = ""): KinkResponse {
  const label = normalizeReactionLabel(status);
  return {
    email,
    name,
    id: idForLabel(label),
    glyph: glyph || glyphForLabel(label),
    label,
    caption: caption || captionForLabel(label, name),
    tone: toneForLabel(label),
  };
}

function normalizeReactionLabel(value: string) {
  const raw = String(value || "").trim();
  const byId: Record<string, string> = {
    curious: "Curious",
    hell_yeah: "Hell yeah",
    tell_me_more: "Tell me more",
    me_too: "Me too",
    give_me_a_minute: "Give me a minute",
    not_for_me: "Not for me — thank you for telling me",
  };
  const aliases: Record<string, string> = {
    "Let's chat": "Tell me more",
    Maybe: "Curious",
    "Talk first": "Give me a minute",
    Approved: "Hell yeah",
    "I'm in": "Hell yeah",
    No: "Not for me — thank you for telling me",
    "Not for me": "Not for me — thank you for telling me",
  };
  return aliases[raw] || byId[raw] || raw || "Curious";
}

function idForLabel(label: string) {
  if (label === "Hell yeah") return "hell_yeah";
  if (label === "Tell me more") return "tell_me_more";
  if (label === "Me too") return "me_too";
  if (label === "Give me a minute") return "give_me_a_minute";
  if (label === "Not for me — thank you for telling me") return "not_for_me";
  return "curious";
}

function glyphForLabel(label: string) {
  if (label === "Hell yeah") return "🔥";
  if (label === "Tell me more") return "👀";
  if (label === "Me too") return "🤤";
  if (label === "Give me a minute") return "💭";
  if (label === "Not for me — thank you for telling me") return "🌷";
  return "🤔";
}

function toneForLabel(label: string): "positive" | "pause" | "no" {
  if (label === "Give me a minute") return "pause";
  if (label === "Not for me — thank you for telling me") return "no";
  return "positive";
}

function captionForLabel(label: string, name = "") {
  const display = String(name || "Partner").trim().split(/\s+/)[0] || "Partner";
  if (label === "Hell yeah") return `${display} said hell yeah.`;
  if (label === "Tell me more") return `${display} wants more detail.`;
  if (label === "Me too") return `${display} is into this too.`;
  if (label === "Give me a minute") return `${display} needs a minute.`;
  if (label === "Not for me — thank you for telling me") return `${display} passed gently.`;
  return `${display} is curious.`;
}

function relativeAge(value: string) {
  const timestamp = new Date(value || "").getTime();
  if (!Number.isFinite(timestamp)) return "recently";
  const diff = Date.now() - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < hour) return "today";
  if (diff < day) return `${Math.max(1, Math.round(diff / hour))}h ago`;
  if (diff < 7 * day) return `${Math.max(1, Math.round(diff / day))}d ago`;
  return "last week";
}
