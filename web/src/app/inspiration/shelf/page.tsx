"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import { EmptyState, ErrorState, SkeletonList } from "@/components/States";
import {
  ApiUnauthorizedError,
  getShelf,
  recordShelfReveal,
  saveShelfItem,
  setShelfReaction,
  updateShelfTitle,
} from "@/lib/api";
import { getProfileCached } from "@/lib/profile-cache";
import type {
  AuthInfo,
  ProfileResponse,
  ShelfItem,
  ShelfReactionOption,
  ShelfResponse,
  Workspace,
} from "@/lib/types";
import { useFocusActivity } from "@/lib/use-focus-activity";
import { useQueryParam } from "@/lib/use-query-param";
import { useLiveRoomReload } from "@/lib/use-live-room";
import { memberByEmail, normalizeEmail, partnerOf } from "@/lib/workspace";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unauthorized" }
  | { kind: "no-workspace"; auth: AuthInfo }
  | {
      kind: "ready";
      auth: AuthInfo;
      workspace: Workspace;
      shelf: ShelfResponse;
      shareAttentionSignals: boolean;
    };

export default function ShelfPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const highlightedItemId = useQueryParam("item");
  const highlightedAction = useQueryParam("action");
  const highlightedFromActivity = useQueryParam("activity") === "1";

  async function reload() {
    const profile: ProfileResponse = await getProfileCached();
    if (!profile.activeWorkspace) {
      setState({ kind: "no-workspace", auth: profile.auth });
      return;
    }
    const shelf = await getShelf(profile.activeWorkspace.id);
    setState({
      kind: "ready",
      auth: profile.auth,
      workspace: profile.activeWorkspace,
      shelf,
      shareAttentionSignals: profile.profile?.settings?.shareAttentionSignals !== false,
    });
  }

  function applyShelfResponse(shelf: ShelfResponse) {
    setState((current) => (
      current.kind === "ready" ? { ...current, shelf } : current
    ));
  }

  // H6: retry for the error ErrorState. Reset to the skeleton, re-run reload,
  // and map failures back to the same load states as the initial mount.
  async function retry() {
    setState({ kind: "loading" });
    try {
      await reload();
    } catch (error) {
      if (error instanceof ApiUnauthorizedError) {
        setState({ kind: "unauthorized" });
        return;
      }
      setState({ kind: "error", message: error instanceof Error ? error.message : "Something went sideways." });
    }
  }

  useEffect(() => {
    // M1: abort the in-flight profile fetch on unmount. getShelf doesn't take
    // a signal yet, so we still guard its result with `cancelled`.
    const controller = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const profile: ProfileResponse = await getProfileCached({ signal: controller.signal });
        if (cancelled) return;
        if (!profile.activeWorkspace) {
          setState({ kind: "no-workspace", auth: profile.auth });
          return;
        }
        const shelf = await getShelf(profile.activeWorkspace.id);
        if (cancelled) return;
        setState({
          kind: "ready",
          auth: profile.auth,
          workspace: profile.activeWorkspace,
          shelf,
          shareAttentionSignals: profile.profile?.settings?.shareAttentionSignals !== false,
        });
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
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
  }, []);

  return (
    <AppShell hideTabBar>
      <header className="shelf-header">
        <div className="header-left">
          <InfinityMark />
          <span className="header-title">The Shelf</span>
        </div>
        <Link href="/inspiration" className="done-pill pressable">Done</Link>
      </header>
      <Body
        state={state}
        onReload={reload}
        onRetry={retry}
        onShelfChange={applyShelfResponse}
        highlightedItemId={highlightedItemId}
        highlightedAction={highlightedAction}
        highlightedFromActivity={highlightedFromActivity}
      />
    </AppShell>
  );
}

function Body({
  state,
  onReload,
  onRetry,
  onShelfChange,
  highlightedItemId,
  highlightedAction,
  highlightedFromActivity,
}: {
  state: LoadState;
  onReload: () => Promise<void>;
  onRetry: () => void;
  onShelfChange: (shelf: ShelfResponse) => void;
  highlightedItemId: string;
  highlightedAction: string;
  highlightedFromActivity: boolean;
}) {
  if (state.kind === "loading") return <SkeletonList count={3} />;
  if (state.kind === "unauthorized") {
    return (
      <ErrorState
        title="Session expired"
        body="Sign in again to see The Shelf."
        action={<Link href="/" className="btn-ghost">Back to sign-in</Link>}
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
        title="Couldn't load The Shelf"
        body={state.message}
        action={<button type="button" className="btn-ghost" onClick={onRetry}>Try again</button>}
      />
    );
  }
  return (
    <ShelfReady
      state={state}
      onReload={onReload}
      onShelfChange={onShelfChange}
      highlightedItemId={highlightedItemId}
      highlightedAction={highlightedAction}
      highlightedFromActivity={highlightedFromActivity}
    />
  );
}

function ShelfReady({
  state,
  onReload,
  onShelfChange,
  highlightedItemId,
  highlightedAction,
  highlightedFromActivity,
}: {
  state: Extract<LoadState, { kind: "ready" }>;
  onReload: () => Promise<void>;
  onShelfChange: (shelf: ShelfResponse) => void;
  highlightedItemId: string;
  highlightedAction: string;
  highlightedFromActivity: boolean;
}) {
  useLiveRoomReload({
    workspaceId: state.workspace.id,
    actorEmail: state.auth.email,
    resources: ["shelf"],
    onReload,
  });
  const partnerName = firstName(partnerOf(state.workspace, state.auth.email)?.displayName) || "Your partner";

  return (
    <div className="shelf-stage">
      <p className="shelf-hint">
        Tiles open hidden. {partnerName} taps <em>Reveal</em> when they are ready. GIFs stay muted.
      </p>
      <ShelfComposer workspaceId={state.workspace.id} onSaved={onShelfChange} />
      {state.shelf.items.length ? (
        <div className="shelf-list">
          {state.shelf.items.map((item) => (
            <ShelfCard
              key={item.id}
              item={item}
              catalog={state.shelf.reactionCatalog}
              me={state.auth.email}
              workspace={state.workspace}
              workspaceId={state.workspace.id}
              onShelfChange={onShelfChange}
              shareAttentionSignals={state.shareAttentionSignals}
              highlighted={item.id === highlightedItemId}
              highlightedAction={item.id === highlightedItemId ? highlightedAction : ""}
              highlightedFromActivity={highlightedFromActivity && item.id === highlightedItemId}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title="Nothing on the Shelf yet."
          body="Save a link or a passage from Inspiration."
        />
      )}
    </div>
  );
}

function ShelfComposer({
  workspaceId,
  onSaved,
}: {
  workspaceId: string;
  onSaved: (shelf: ShelfResponse) => void;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const clean = content.trim();
    if (!clean || saving) return;
    setSaving(true);
    setError("");
    try {
      const shelf = await saveShelfItem({ workspaceId, content: clean, title: title.trim() });
      setTitle("");
      setContent("");
      if (navigator.vibrate) navigator.vibrate([6, 16, 8]);
      onSaved(shelf);
    } catch (err) {
      // H8: a failed save used to silently no-op. Keep the draft so the user
      // can retry, and surface the reason inline.
      setError(err instanceof Error ? err.message : "Couldn't save that. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="shelf-compose-form shelf-compose-wide" onSubmit={submit}>
      <div className="shelf-compose-fields">
        <input
          className="input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Title"
          aria-label="Title"
          maxLength={120}
          autoCapitalize="sentences"
          autoCorrect="on"
          spellCheck
          inputMode="text"
        />
        <input
          className="input"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="Paste a link or passage"
          aria-label="Link or passage"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
        />
      </div>
      <button type="submit" className="btn-primary shelf-save-btn" disabled={!content.trim() || saving}>
        {saving ? "Saving" : "Save"}
      </button>
      {error && (
        <p className="mt-2 text-sm" role="alert" style={{ color: "rgb(var(--no-rgb))" }}>{error}</p>
      )}
    </form>
  );
}

function ShelfCard({
  item,
  catalog,
  me,
  workspace,
  workspaceId,
  onShelfChange,
  shareAttentionSignals,
  highlighted = false,
  highlightedAction = "",
  highlightedFromActivity = false,
}: {
  item: ShelfItem;
  catalog: ShelfReactionOption[];
  me: string;
  workspace: Workspace;
  workspaceId: string;
  onShelfChange: (shelf: ShelfResponse) => void;
  shareAttentionSignals: boolean;
  highlighted?: boolean;
  highlightedAction?: string;
  highlightedFromActivity?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const [revealBusy, setRevealBusy] = useState(false);
  const [bloomToken, setBloomToken] = useState(0);
  const [saving, setSaving] = useState("");
  const [actionError, setActionError] = useState("");
  const cardRef = useRef<HTMLElement | null>(null);
  const revealActivitySent = useRef(false);
  const myEmail = normalizeEmail(me);
  // M2: optimistic reaction. Render this over the prop until the server
  // response lands so the emoji lights instantly instead of after the
  // round trip. `undefined` means "defer to the prop"; any other value
  // (id or null) overrides until reconciled. Mirrors _VaultCard.
  const [pendingReaction, setPendingReaction] = useState<string | null | undefined>(undefined);
  const propReaction = item.reactions?.[myEmail] || null;
  const myReaction = pendingReaction !== undefined ? pendingReaction : propReaction;
  const myDisplayName = "You";
  const isMine = normalizeEmail(item.addedByEmail) === myEmail;
  const partnerEntry = Object.entries(item.reactions || {}).find(([email]) => normalizeEmail(email) !== myEmail);
  const partnerReaction = partnerEntry ? catalog.find((option) => option.id === partnerEntry[1]) : null;
  const partnerName = firstName(
    memberByEmail(workspace, partnerEntry?.[0] || "")?.displayName
      || partnerOf(workspace, me)?.displayName
  ) || "Your partner";
  const active = myReaction ? catalog.find((option) => option.id === myReaction) : null;
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(item.title || "");
  const [titleBusy, setTitleBusy] = useState(false);

  useEffect(() => {
    // Reconcile: once the server-driven prop matches our optimistic value,
    // drop the override so future re-renders read straight from the prop.
    if (pendingReaction !== undefined && pendingReaction === propReaction) {
      queueMicrotask(() => setPendingReaction(undefined));
    }
  }, [pendingReaction, propReaction]);

  useFocusActivity({
    workspaceId,
    entityId: item.id,
    resource: "shelf",
    enabled: shareAttentionSignals && revealed && !isMine && !myReaction,
    elementRef: cardRef,
    sampleBucket: item.type || "save",
    minMs: item.type === "gif" ? 60_000 : 45_000,
    maxMs: item.type === "gif" ? 150_000 : 120_000,
  });

  useEffect(() => {
    if (!highlighted) return;
    const timer = window.setTimeout(() => {
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 260);
    return () => window.clearTimeout(timer);
  }, [highlighted]);

  async function react(option: ShelfReactionOption) {
    if (saving) return;
    // M2: snapshot for rollback, flip the optimistic state + bloom + haptics
    // up front so the emoji lights this frame.
    const prior = propReaction;
    const next = myReaction === option.id ? null : option.id;
    setActionError("");
    setPendingReaction(next);
    setBloomToken((value) => value + 1);
    setSaving(option.id);
    if (navigator.vibrate) navigator.vibrate(next ? [6, 16, 8] : 4);
    try {
      const shelf = await setShelfReaction({
        workspaceId,
        id: item.id,
        reaction: next,
      });
      // pendingReaction clears via the reconcile effect once the prop catches up.
      onShelfChange(shelf);
    } catch (err) {
      // H8: server rejected the write. Roll back to the pre-flip state and say so.
      setPendingReaction(prior);
      setActionError(err instanceof Error ? err.message : "Couldn't save that reaction. Try again.");
    } finally {
      setSaving("");
    }
  }

  async function saveTitle() {
    if (!isMine || titleBusy) return;
    setTitleBusy(true);
    setActionError("");
    try {
      const shelf = await updateShelfTitle({
        workspaceId,
        id: item.id,
        title: titleDraft.trim(),
      });
      setEditingTitle(false);
      onShelfChange(shelf);
    } catch (err) {
      // H8: a failed title save used to silently no-op. Stay in the editor
      // (don't drop the draft) and surface the reason.
      setActionError(err instanceof Error ? err.message : "Couldn't save that title. Try again.");
    } finally {
      setTitleBusy(false);
    }
  }

  async function revealItem() {
    if (revealBusy) return;
    const canUseRedgifsEmbed = item.type === "gif"
      && item.source === "redgifs"
      && Boolean(redgifsAutoplayEmbedUrl(item));
    const needsRedgifsVideo = item.type === "gif"
      && item.source === "redgifs"
      && !item.videoHdUrl
      && !item.videoSdUrl
      && !canUseRedgifsEmbed;

    if (!needsRedgifsVideo) {
      setRevealed(true);
      if (navigator.vibrate) navigator.vibrate([8, 24, 8]);
      if (revealActivitySent.current) return;
      revealActivitySent.current = true;
      recordShelfReveal({ workspaceId, id: item.id })
        .then(onShelfChange)
        .catch(() => {
          revealActivitySent.current = false;
        });
      return;
    }

    setRevealBusy(true);
    setActionError("");
    try {
      const shelf = await recordShelfReveal({ workspaceId, id: item.id });
      onShelfChange(shelf);
      const updated = shelf.items.find((candidate) => candidate.id === item.id);
      if (updated?.videoHdUrl || updated?.videoSdUrl) {
        revealActivitySent.current = true;
        setRevealed(true);
        if (navigator.vibrate) navigator.vibrate([8, 24, 8]);
      } else {
        revealActivitySent.current = false;
      }
    } catch {
      revealActivitySent.current = false;
      setActionError("Couldn't reveal that. Try again.");
    } finally {
      setRevealBusy(false);
    }
  }

  return (
    <article
      ref={cardRef}
      className={`shelf-card ${highlighted ? "is-activity-highlight" : ""}`}
      data-activity-highlight={highlighted ? "true" : undefined}
    >
      {editingTitle ? (
        <div className="shelf-title-editor">
          <input
            className="input"
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            placeholder="Title"
            aria-label="Edit title"
            maxLength={120}
            autoFocus
            autoCapitalize="sentences"
            autoCorrect="on"
            spellCheck
            inputMode="text"
          />
          <div className="shelf-title-actions">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setTitleDraft(item.title || "");
                setEditingTitle(false);
              }}
              disabled={titleBusy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={saveTitle}
              disabled={titleBusy}
            >
              {titleBusy ? "Saving" : "Save title"}
            </button>
          </div>
        </div>
      ) : (
        <div className="shelf-title-row">
          {isMine ? (
            <button
              type="button"
              className="caption shelf-title-edit-trigger pressable"
              onClick={() => {
                setTitleDraft(item.title || "");
                setEditingTitle(true);
              }}
              aria-label={item.title ? "Edit Shelf item title" : "Add Shelf item title"}
            >
              {item.title || item.passageText || item.sourceUrl || "Saved to the Shelf"}
            </button>
          ) : (
            <p className="caption">{item.title || item.passageText || item.sourceUrl || "Saved to the Shelf"}</p>
          )}
        </div>
      )}
      {highlightedFromActivity && highlightedAction === "revealed" && (
        <span className="activity-arrival-badge">Recently opened</span>
      )}
      <MediaTile
        item={item}
        revealed={revealed}
        revealBusy={revealBusy}
        onReveal={revealItem}
        onHide={() => setRevealed(false)}
      />
      <div className="meta-row">
        <span className="meta-author">{item.addedByName || "Someone"} · {relativeAge(item.addedAt)}</span>
        {item.sourceLabel && <span className="meta-author">{item.sourceLabel}</span>}
      </div>
      {partnerReaction && (
        <div className="partner-strip" role="status">
          <span className="partner-pulse" aria-hidden="true" />
          <span className="partner-text">
            <strong>{partnerName}</strong>
            <span className="partner-react">
              <span className="partner-react-emoji" aria-hidden="true">{partnerReaction.emoji}</span>
              <em>{partnerReaction.label.toLowerCase()}</em>
            </span>
          </span>
        </div>
      )}
      <div className="live-caption" aria-live="polite">
        {active ? reactionCaption(active, myDisplayName) : `Choose how this lands. ${partnerName} sees it the moment you do.`}
      </div>
      <div className="tray-wrap">
        <div className="tray" role="group" aria-label="React to this Shelf item">
          {catalog.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`reaction pressable ${myReaction === option.id ? "is-active" : ""} ${option.tone === "pass" ? "is-pass" : ""}`}
              onClick={() => react(option)}
              aria-pressed={myReaction === option.id}
              aria-label={option.label}
              disabled={Boolean(saving)}
            >
              <span className="reaction-emoji">{option.emoji}</span>
              {myReaction === option.id && <span className="reaction-bloom" key={`b-${bloomToken}`} aria-hidden="true" />}
            </button>
          ))}
        </div>
      </div>
      {actionError && (
        <p className="mt-2 text-sm" role="alert" style={{ color: "rgb(var(--no-rgb))" }}>{actionError}</p>
      )}
    </article>
  );
}

function firstName(value?: string | null) {
  return String(value || "").trim().split(/\s+/)[0] || "";
}

function reactionCaption(option: ShelfReactionOption, name: string) {
  const displayName = String(name || "You").trim().split(/\s+/)[0] || "You";
  if (displayName.toLowerCase() === "you") {
    return option.caption
      .replace(/\{name\} says/g, "You say")
      .replace(/\{name\} is/g, "You are")
      .replace(/\{name\} wants/g, "You want")
      .replace(/Not \{name\}'s vibe/g, "Not your vibe");
  }
  return option.caption.replace(/\{name\}/g, displayName);
}

function redgifsAutoplayEmbedUrl(item: ShelfItem) {
  const source = item.embedUrl || item.sourceUrl;
  if (!source) return "";
  try {
    const url = new URL(source);
    if (!/^(?:www\.)?redgifs\.com$/.test(url.hostname.toLowerCase())) return "";
    url.hostname = "www.redgifs.com";
    if (!url.pathname.startsWith("/ifr/")) {
      const segments = url.pathname.split("/").filter(Boolean);
      const watchIndex = segments.findIndex((segment) => segment.toLowerCase() === "watch");
      const id = watchIndex >= 0 ? segments[watchIndex + 1] : "";
      if (!id) return "";
      url.pathname = `/ifr/${id}`;
    }
    url.searchParams.set("hd", "1");
    url.searchParams.set("muted", "1");
    url.searchParams.set("autoplay", "1");
    return url.toString();
  } catch {
    return "";
  }
}

function isBellesaShelfItem(item: ShelfItem) {
  const source = String(item.source || "").toLowerCase();
  if (source === "bellesa") return true;
  try {
    const host = new URL(item.sourceUrl || "").hostname.replace(/^www\./, "").toLowerCase();
    return /^bellesa\.(?:co|com)$/.test(host);
  } catch {
    return false;
  }
}

function bellesaVideoIdFromUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (!/^bellesa\.(?:co|com)$/.test(host)) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    const videoIndex = parts.findIndex((part) => part.toLowerCase() === "videos");
    const id = videoIndex >= 0 ? parts[videoIndex + 1] : "";
    return /^\d+$/.test(id || "") ? id : "";
  } catch {
    return "";
  }
}

function canonicalBellesaUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (!/^bellesa\.(?:co|com)$/.test(host)) return value;
    url.protocol = "https:";
    url.hostname = "www.bellesa.co";
    return url.toString();
  } catch {
    return value;
  }
}

function bestBellesaResolution(value: unknown) {
  const resolutions = String(value || "")
    .split(/[,\s]+/)
    .map((entry) => Number.parseInt(entry, 10))
    .filter((entry) => Number.isFinite(entry) && entry > 0)
    .sort((a, b) => b - a);
  return resolutions[0] || 720;
}

async function resolveBellesaVideo(item: ShelfItem) {
  const sourceUrl = canonicalBellesaUrl(item.sourceUrl || "");
  const videoId = bellesaVideoIdFromUrl(sourceUrl);
  if (!videoId) return null;
  const response = await fetch(`https://www.bellesa.co/api/rest/v1/videos/${videoId}`, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "force-cache",
  });
  if (!response.ok) return null;
  const data = await response.json() as {
    source?: unknown;
    resolutions?: unknown;
    image?: unknown;
    access?: { public?: unknown };
  };
  if (data.access && data.access.public !== 1 && data.access.public !== true) return null;
  const source = String(data.source || "").trim();
  if (!/^[a-z0-9]+$/i.test(source)) return null;
  const best = bestBellesaResolution(data.resolutions);
  const fallback = best >= 720 ? 480 : best === 480 ? 360 : best;
  return {
    videoHdUrl: `https://s.bellesa.co/v/${source}/${best}.mp4`,
    videoSdUrl: `https://s.bellesa.co/v/${source}/${fallback}.mp4`,
    posterUrl: typeof data.image === "string" ? data.image : "",
    sourceUrl,
  };
}

function externalShelfHref(item: ShelfItem) {
  if (isBellesaShelfItem(item) && item.sourceUrl) return canonicalBellesaUrl(item.sourceUrl);
  return item.sourceUrl || "";
}

function externalShelfLinkLabel(item: ShelfItem) {
  const source = String(item.source || "").toLowerCase();
  const host = (() => {
    try {
      return new URL(item.sourceUrl || "").hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "";
    }
  })();
  if (source === "bellesa" || /^bellesa\.(?:co|com)$/.test(host)) return "Open Bellesa";
  if (source === "literotica" || host === "literotica.com") return "Open Literotica";
  if (source === "ao3" || host === "archiveofourown.org") return "Open AO3";
  return "Open link";
}

function MediaTile({
  item,
  revealed,
  revealBusy,
  onReveal,
  onHide,
}: {
  item: ShelfItem;
  revealed: boolean;
  revealBusy: boolean;
  onReveal: () => void;
  onHide: () => void;
}) {
  const isBellesaVideo = isBellesaShelfItem(item);
  const [bellesaVideo, setBellesaVideo] = useState<{
    videoHdUrl: string;
    videoSdUrl: string;
    posterUrl: string;
    sourceUrl: string;
  } | null>(null);
  const [bellesaBusy, setBellesaBusy] = useState(false);
  const [revealError, setRevealError] = useState("");
  const videoUrl = bellesaVideo?.videoHdUrl || bellesaVideo?.videoSdUrl || item.videoHdUrl || item.videoSdUrl;
  const externalHref = bellesaVideo?.sourceUrl || externalShelfHref(item);
  const isRedgifsGif = item.type === "gif" && item.source === "redgifs";
  const redgifsEmbedUrl = isRedgifsGif && !videoUrl ? redgifsAutoplayEmbedUrl(item) : "";
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!revealed || !videoRef.current) return;
    const video = videoRef.current;
    video.muted = true;
    video.defaultMuted = true;
    video.play().catch(() => {});
    return () => {
      video.pause();
      video.currentTime = 0;
    };
  }, [revealed, videoUrl]);

  async function reveal() {
    if (bellesaBusy) return;
    if (isBellesaVideo && !videoUrl) {
      setBellesaBusy(true);
      setRevealError("");
      try {
        const resolved = await resolveBellesaVideo(item);
        if (resolved?.videoHdUrl || resolved?.videoSdUrl) setBellesaVideo(resolved);
      } catch {
        // Best effort: Reveal still exposes the external Bellesa link.
        setRevealError("Couldn't load the video here. Use the source link instead.");
      } finally {
        setBellesaBusy(false);
      }
    }
    onReveal();
  }

  function hide() {
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
    onHide();
  }

  return (
    <div className={`media ${revealed ? "is-revealed" : ""} ${isBellesaVideo && videoUrl ? "is-longform" : ""}`}>
      <div className="media-art" aria-hidden={!revealed}>
        {revealed && videoUrl ? (
          <>
            <video
              ref={videoRef}
              src={videoUrl}
              muted
              autoPlay
              loop={!isBellesaVideo}
              playsInline
              preload="auto"
              poster={bellesaVideo?.posterUrl || item.posterUrl || undefined}
              controls={isBellesaVideo}
              controlsList={isBellesaVideo ? "nodownload noplaybackrate" : "nodownload noplaybackrate nofullscreen"}
              disablePictureInPicture={!isBellesaVideo}
              onCanPlay={(event) => event.currentTarget.play().catch(() => {})}
            />
            {isBellesaVideo && externalHref && (
              <a
                href={externalHref}
                className="media-source-link"
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                {externalShelfLinkLabel(item)}
              </a>
            )}
          </>
        ) : revealed && redgifsEmbedUrl ? (
          <iframe
            src={redgifsEmbedUrl}
            title={item.title || "RedGifs preview"}
            allow="autoplay; fullscreen; picture-in-picture"
            allowFullScreen
            referrerPolicy="no-referrer"
          />
        ) : revealed && externalHref && !isRedgifsGif ? (
          <a
            href={externalHref}
            className="media-open-link"
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            {externalShelfLinkLabel(item)}
          </a>
        ) : (
          <>
            <div className="art-base" />
            <div className="art-bloom-a" />
            <div className="art-bloom-b" />
            <div className="art-vignette" />
          </>
        )}
      </div>
      {!revealed && (
        <button type="button" className="reveal-btn pressable" onClick={reveal} aria-label="Reveal" disabled={revealBusy || bellesaBusy}>
          {revealBusy || bellesaBusy ? "Loading" : "Reveal"}
        </button>
      )}
      {revealed && (
        <button type="button" className="hide-btn pressable" onClick={hide} aria-label="Hide">
          Hide
        </button>
      )}
      {revealError && (
        <p className="mt-2 text-sm" role="alert" style={{ color: "rgb(var(--no-rgb))" }}>{revealError}</p>
      )}
    </div>
  );
}

function InfinityMark() {
  return (
    <svg width="18" height="9" viewBox="0 0 100 50" fill="none" aria-hidden="true" className="infinity is-breathing">
      <path
        d="M12 25 C 12 10, 38 10, 50 25 C 62 40, 88 40, 88 25 C 88 10, 62 10, 50 25 C 38 40, 12 40, 12 25 Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
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
