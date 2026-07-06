"use client";

/**
 * Sext — the in-app direct-message surface between the two partners (the route
 * and API stay /chat internally). Loads the thread for the active workspace,
 * paints instantly from the
 * resource cache, and stays live over the room socket. Messages are E2EE in a
 * Room-Encryption workspace (encrypt/decrypt happens in lib/api).
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import ImageLightbox from "./_ImageLightbox";
import ScreenHeader from "@/components/ScreenHeader";
import PartnerTurnOns from "@/components/PartnerTurnOns";
import { ErrorState, SkeletonList } from "@/components/States";
import WaitingForPartner from "@/components/WaitingForPartner";
import {
  ApiUnauthorizedError,
  editChatMessage,
  generateIdempotencyKey,
  getChat,
  getChatImageBlobCached,
  getConfig,
  markChatRead,
  predictChatMessageId,
  reactToChatMessage,
  resolveRedgifs,
  searchRedgifs,
  type RedgifsSearchResult,
  sendChatMessage,
  sendChatTyping,
  unsendChatMessage,
  uploadChatImage,
} from "@/lib/api";
import { getProfileCached } from "@/lib/profile-cache";
import { getCachedResource, setCachedResource, useColdStart } from "@/lib/resource-cache";
import { normalizeImageForUpload } from "@/lib/image-normalize";
import { useInView } from "@/lib/use-in-view";
import { LIVE_ROOM_EVENT, LIVE_ROOM_PRESENCE, useLiveRoomReload, type LiveRoomEventDetail, type LiveRoomPresenceDetail } from "@/lib/use-live-room";
import { partnerOf } from "@/lib/workspace";
import { redgifsIdFromUrl } from "@/lib/shelf-source";
import type { AuthInfo, ChatMedia, ChatMessage, ChatReaction, ProfileResponse, Workspace } from "@/lib/types";

// Same vocabulary as Kink reactions (functions/api/fantasy-backlog.js
// KINK_REACTIONS) so a reaction means the same thing across the app. Shown in
// an iOS-style picker on a long-press of a message.
const REACTION_CHOICES: ReadonlyArray<{ glyph: string; label: string }> = [
  { glyph: "🤔", label: "Curious" },
  { glyph: "🔥", label: "Hell yeah" },
  { glyph: "👀", label: "Tell me more" },
  { glyph: "🤤", label: "Me too" },
  { glyph: "💭", label: "Give me a minute" },
  { glyph: "🌷", label: "Not for me" },
];
// Tap-to-insert palette for the composer — the filthier end of the keyboard,
// one tap away instead of buried in the system picker.
const XXX_EMOJIS = ["🍆", "🍑", "💦", "👅", "🫦", "🔥", "😈", "🤤", "💋", "👀", "🥵", "🍒", "💧", "⛓️", "😏", "🌶️", "🍌", "🙈", "🥴", "🍯", "💕", "🤭"];
// Sort options for the GIF picker — applied to whatever the user searches.
// Only these three are valid RedGifs orders that respect the query.
const GIF_ORDERS: { key: string; label: string }[] = [
  { key: "trending", label: "Trending" },
  { key: "top", label: "Top" },
  { key: "latest", label: "Latest" },
];

// Persist the composer draft per workspace so a half-typed message survives a
// reload / navigating away (e.g. to check a notification) instead of vanishing.
const sextDraftKey = (workspaceId: string) => `ss:sext:draft:${workspaceId}`;
function readPersistedDraft(workspaceId: string): string {
  if (typeof window === "undefined" || !workspaceId) return "";
  try { return window.localStorage.getItem(sextDraftKey(workspaceId)) || ""; } catch { return ""; }
}
function writePersistedDraft(workspaceId: string, value: string): void {
  if (typeof window === "undefined" || !workspaceId) return;
  try {
    if (value.trim()) window.localStorage.setItem(sextDraftKey(workspaceId), value);
    else window.localStorage.removeItem(sextDraftKey(workspaceId));
  } catch { /* storage blocked — the draft just won't persist, no harm */ }
}
const TYPING_THROTTLE_MS = 3000;
const TYPING_CLEAR_MS = 5000;
// Render window: a years-long thread can hold up to the server's 2000-message
// ring buffer; mounting all of it is 16k-30k DOM nodes. Render the recent
// slice and reveal history on demand. State keeps the full list (read cursors,
// reply lookups, and seq math all use it) — only the render is windowed.
const CHAT_WINDOW_INITIAL = 150;
const CHAT_WINDOW_STEP = 200;
const CHAT_LONG_PRESS_MS = 420;
const CHAT_LONG_PRESS_MOVE_TOLERANCE_PX = 12;

// One-line preview of a message for the reply banner + the quoted-reply chip.
function messagePreview(m: ChatMessage): string {
  if (m.deletedAt) return "Unsent message";
  if (m.e2eeLocked) return "Locked message";
  if (m.media) return "📷 Photo";
  const text = (m.text || "").trim();
  if (!text) return "Message";
  if (redgifsIdFromUrl(text)) return "🎞️ GIF";
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

function relativeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
const MAX_INPUT = 4000;

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unauthorized" }
  | { kind: "no-workspace" }
  | {
      kind: "ready";
      auth: AuthInfo;
      workspace: Workspace;
      messages: ChatMessage[];
      readCursors: Record<string, number>;
      readAt: Record<string, string>;
    };

export default function ChatPage() {
  const [state, setState] = useState<LoadState>(() => getCachedResource<LoadState>("chat") ?? { kind: "loading" });
  useColdStart("chat", setState);
  useEffect(() => { if (state.kind === "ready") setCachedResource("chat", state); }, [state]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const profile: ProfileResponse = await getProfileCached();
        if (cancelled) return;
        if (!profile.activeWorkspace) {
          setState({ kind: "no-workspace" });
          return;
        }
        const thread = await getChat(profile.activeWorkspace.id);
        if (cancelled) return;
        setState({
          kind: "ready",
          auth: profile.auth,
          workspace: profile.activeWorkspace,
          messages: thread.messages,
          readCursors: thread.readCursors,
          readAt: thread.readAt || {},
        });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiUnauthorizedError) {
          setState({ kind: "unauthorized" });
          return;
        }
        setState({ kind: "error", message: error instanceof Error ? error.message : "Couldn't load sexts." });
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  if (state.kind === "loading") {
    return (
      <AppShell>
        <ScreenHeader eyebrow="Sext" showBrand={false} backHref="/sexboard" title="Just between you two." subtitle="Loading your thread." />
        <SkeletonList count={4} />
      </AppShell>
    );
  }
  if (state.kind === "unauthorized") {
    return (
      <AppShell>
        <ScreenHeader eyebrow="Sext" showBrand={false} backHref="/sexboard" title="Just between you two." subtitle="Sign in again to open your thread." />
        <ErrorState title="Session expired" body="Sign in again to open your sexts." action={<Link href="/" className="btn-ghost">Back to sign-in</Link>} />
      </AppShell>
    );
  }
  if (state.kind === "no-workspace") {
    return (
      <AppShell>
        <ScreenHeader eyebrow="Sext" showBrand={false} backHref="/sexboard" title="Just between you two." subtitle="You need a paired room before you can sext." />
        <ErrorState title="No partner space yet" body="You need a paired room before you can sext." action={<Link href="/space" className="btn-ghost">Open Space</Link>} />
      </AppShell>
    );
  }
  if (state.kind === "error") {
    return (
      <AppShell>
        <ScreenHeader eyebrow="Sext" showBrand={false} backHref="/sexboard" title="Just between you two." subtitle="What do you want to say?" />
        <ErrorState title="Couldn't load sexts" body={state.message} action={<button className="btn-ghost" onClick={() => setReloadKey((v) => v + 1)}>Try again</button>} />
      </AppShell>
    );
  }
  if (!hasJoinedPartner(state.workspace, state.auth.email)) {
    return (
      <AppShell>
        <ScreenHeader eyebrow="Sext" showBrand={false} backHref="/sexboard" title="Just between you two." subtitle="Once your partner joins, this is where you talk." />
        <WaitingForPartner workspace={state.workspace} intent="Sexting" />
      </AppShell>
    );
  }
  return <ChatRoom state={state} setState={setState} />;
}

function hasJoinedPartner(workspace: Workspace, myEmail: string): boolean {
  const me = (myEmail || "").toLowerCase();
  return (workspace.members || []).some((member) => member.status === "active" && (member.email || "").toLowerCase() !== me);
}

function ChatRoom({
  state,
  setState,
}: {
  state: Extract<LoadState, { kind: "ready" }>;
  setState: React.Dispatch<React.SetStateAction<LoadState>>;
}) {
  const { workspace, auth } = state;
  const myEmail = auth.email.toLowerCase();
  const e2ee = Boolean(workspace.settings?.roomE2eeEnabled);
  const partner = partnerOf(workspace, auth.email);
  const partnerEmail = (partner?.email || "").toLowerCase();
  const partnerName = partner?.displayName?.split(" ")[0] || "your partner";

  const [draft, setDraft] = useState(() => readPersistedDraft(workspace.id));
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [activeId, setActiveId] = useState("");
  const [reactingId, setReactingId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showGifSearch, setShowGifSearch] = useState(false);
  const [gifSearchEnabled, setGifSearchEnabled] = useState(false);
  const [gifQuery, setGifQuery] = useState("");
  const [gifResults, setGifResults] = useState<RedgifsSearchResult[]>([]);
  const [gifLoading, setGifLoading] = useState(false);
  const [gifOrder, setGifOrder] = useState("trending");
  const [gifPage, setGifPage] = useState(1);
  const [gifPages, setGifPages] = useState(1);
  const [gifLoadingMore, setGifLoadingMore] = useState(false);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [partnerPresence, setPartnerPresence] = useState<{ online: boolean; at: string } | null>(null);
  const [lightboxMedia, setLightboxMedia] = useState<ChatMedia | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const gifGridRef = useRef<HTMLDivElement | null>(null);
  const lastTypingSentRef = useRef(0);
  const typingClearRef = useRef<number | null>(null);

  // Grow the composer to fit what you're typing (iMessage-style), capped so it
  // never eats the thread; past the cap it scrolls. Runs on every draft change
  // — typing, clearing after send, and populating it to edit a message.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    // Defer the scrollHeight read/write off the keystroke's critical path so a
    // forced reflow doesn't land on every character (rAF coalesces it).
    const raf = requestAnimationFrame(() => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    });
    return () => cancelAnimationFrame(raf);
  }, [draft]);

  const messages = state.messages;
  const readCursors = state.readCursors;
  const readAt = state.readAt || {};
  // Order-independent so an optimistic (pending) message — appended out of band —
  // doesn't depend on array position. The server clamps the read cursor anyway.
  const latestSeq = messages.reduce((max, m) => Math.max(max, m.seq), 0);
  const partnerReadSeq = Number(readCursors[partnerEmail]) || 0;
  const partnerReadAt = readAt[partnerEmail] || "";

  // The server supports `after` (seq-filtered incremental fetch), but only new
  // messages get fresh seqs — reactions/edits/unsends mutate a message IN
  // PLACE with its seq unchanged, so an incremental fetch would miss them.
  // Track what kind of chat events arrived since the last reload:
  //  - "message" / "read"  → incremental is safe (read cursors ride along on
  //    every response, even an empty one);
  //  - anything else (reaction/update/delete) → full fetch required;
  //  - NO tracked events (reconnect resync, visibility flush after the socket
  //    died) → full fetch, because we can't know what was missed.
  const incrementalSafeRef = useRef(false);
  const needsFullFetchRef = useRef(false);
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => {
    function onChatEvent(event: Event) {
      const detail = (event as CustomEvent<LiveRoomEventDetail>).detail;
      if (detail?.resource !== "chat") return;
      const action = detail.action || "";
      if (action === "typing") return; // transient UI only, never refetched
      if (action === "message" || action === "read") incrementalSafeRef.current = true;
      else needsFullFetchRef.current = true;
    }
    window.addEventListener(LIVE_ROOM_EVENT, onChatEvent);
    return () => window.removeEventListener(LIVE_ROOM_EVENT, onChatEvent);
  }, []);

  const reloadThread = useCallback(async () => {
    const incremental = incrementalSafeRef.current && !needsFullFetchRef.current;
    incrementalSafeRef.current = false;
    needsFullFetchRef.current = false;
    const prev = messagesRef.current;
    const after = incremental && prev.length > 0
      ? prev.reduce((max, m) => Math.max(max, m.seq), 0)
      : undefined;
    try {
      const thread = await getChat(workspace.id, after);
      setState((current) => (current.kind === "ready"
        ? {
            ...current,
            messages: mergeThreadMessages(current.messages, thread.messages, after !== undefined),
            readCursors: thread.readCursors,
            readAt: thread.readAt || {},
          }
        : current));
    } catch {
      // Transient — the next live event or visibility change retries. Require
      // a full fetch then so a failed incremental can't drop events.
      needsFullFetchRef.current = true;
    }
  }, [workspace.id, setState]);

  useLiveRoomReload({ workspaceId: workspace.id, actorEmail: auth.email, resources: ["chat"], onReload: reloadThread });

  // Typing is delivered as a passive room event; surface it transiently.
  useEffect(() => {
    function onRoomEvent(event: Event) {
      const detail = (event as CustomEvent<LiveRoomEventDetail>).detail;
      if (detail?.resource !== "chat" || detail.action !== "typing") return;
      if ((detail.actorEmail || "").toLowerCase() === myEmail) return;
      setPartnerTyping(true);
      if (typingClearRef.current !== null) window.clearTimeout(typingClearRef.current);
      typingClearRef.current = window.setTimeout(() => setPartnerTyping(false), TYPING_CLEAR_MS);
    }
    window.addEventListener(LIVE_ROOM_EVENT, onRoomEvent);
    return () => {
      window.removeEventListener(LIVE_ROOM_EVENT, onRoomEvent);
      if (typingClearRef.current !== null) window.clearTimeout(typingClearRef.current);
    };
  }, [myEmail]);

  // Partner presence — "Active now" while their socket is live, otherwise when
  // they were last here. online/offline arrive as presence events; the room's
  // hello also seeds whoever is already online when we open the screen.
  useEffect(() => {
    function onPresence(event: Event) {
      const detail = (event as CustomEvent<LiveRoomPresenceDetail>).detail;
      if ((detail?.actorEmail || "").toLowerCase() !== partnerEmail) return;
      const online = detail.status === "online" || detail.status === "active";
      setPartnerPresence({ online, at: detail.at || new Date().toISOString() });
    }
    window.addEventListener(LIVE_ROOM_PRESENCE, onPresence);
    return () => window.removeEventListener(LIVE_ROOM_PRESENCE, onPresence);
  }, [partnerEmail]);

  // GIF picker search — debounced so each keystroke doesn't hammer RedGifs.
  // Opening the picker (or an empty box) loads the default seed; an in-flight
  // request is aborted when the query changes or the picker closes.
  useEffect(() => {
    if (!showGifSearch) return;
    const query = gifQuery.trim();
    // Nothing until the user actually searches — no default feed on open.
    if (!query) { setGifResults([]); setGifLoading(false); return; }
    let cancelled = false;
    setGifLoading(true);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchRedgifs(query, gifOrder, 1, controller.signal).then(({ results, pages }) => {
        if (cancelled) return;
        setGifResults(results);
        setGifPages(pages);
        setGifPage(1);
        setGifLoading(false);
      });
    }, 280);
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [showGifSearch, gifQuery, gifOrder]);

  // Only offer the GIF button where RedGifs is actually reachable: self-host (a
  // normal IP) or a Cloudflare deploy with REDGIFS_PROXY set. /api/config carries
  // the flag; without it the picker would just come back empty.
  useEffect(() => {
    let cancelled = false;
    getConfig().then((config) => { if (!cancelled) setGifSearchEnabled(Boolean(config.gifSearch)); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Persist the draft as it changes so a reload / tab-away doesn't lose it. Skip
  // while editing an existing message (that text isn't a new-message draft).
  useEffect(() => {
    if (editingId) return;
    writePersistedDraft(workspace.id, draft);
  }, [draft, editingId, workspace.id]);

  // Pin the chat surface to the *visual* viewport so the composer always sits at
  // the bottom of what's actually visible — above the tab bar when idle, above the
  // keyboard when it's up. visualViewport is the only signal that's reliable in
  // both Safari tabs and standalone PWAs: in a home-screen install neither svh nor
  // window.innerHeight shrinks for the keyboard, so a padding-only fix leaves the
  // field hidden behind it. We publish the visible height/offset as CSS vars and
  // flag the keyboard so globals.css can size the surface and hide the tab bar.
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const root = document.documentElement;
    let maxHeight = vv.height;
    const apply = () => {
      if (vv.height > maxHeight) maxHeight = vv.height;
      // Keyboard is up when the visible height drops well below the tallest seen.
      // Works in both modes (visualViewport.height shrinks for the keyboard in both).
      const keyboardOpen = vv.height < maxHeight - 80;
      root.style.setProperty("--chat-vh", `${Math.round(vv.height)}px`);
      root.style.setProperty("--chat-top", `${Math.round(vv.offsetTop)}px`);
      if (keyboardOpen) {
        root.style.setProperty("--chat-pad", "10px");
        root.dataset.chatKb = "1";
      } else {
        root.style.removeProperty("--chat-pad");
        delete root.dataset.chatKb;
      }
    };
    // Re-baseline on rotation so landscape's shorter height isn't read as a keyboard.
    const reset = () => { maxHeight = vv.height; apply(); };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    window.addEventListener("orientationchange", reset);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      window.removeEventListener("orientationchange", reset);
      root.style.removeProperty("--chat-vh");
      root.style.removeProperty("--chat-top");
      root.style.removeProperty("--chat-pad");
      delete root.dataset.chatKb;
    };
  }, []);

  // Sext is bottom-anchored at the BROWSER level: .chat-thread is
  // flex-direction:column-reverse and the message groups are emitted newest-first
  // (see the render), so the newest message stays glued to the visual bottom
  // natively — through media decrypt, the partner-turn-ons strip, and the
  // visualViewport --chat-vh, none of which can pull the view off the bottom the
  // way the old JS pinning did. Scrolling up to read history just works and is
  // never yanked back. This only guarantees we START at the bottom (scrollTop 0
  // is the bottom in a column-reverse scroller).
  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = 0;
  }, [latestSeq]);

  // Advance our read cursor when new messages from the partner arrive.
  useEffect(() => {
    if (latestSeq <= 0) return;
    const mine = Number(readCursors[myEmail]) || 0;
    if (latestSeq <= mine) return;
    markChatRead({ workspaceId: workspace.id, seq: latestSeq })
      .then((res) => setState((current) => (current.kind === "ready" ? { ...current, readCursors: res.readCursors, readAt: res.readAt || current.readAt } : current)))
      .catch(() => {});
  }, [latestSeq, readCursors, myEmail, workspace.id, setState]);

  function emitTyping() {
    const now = Date.now();
    if (now - lastTypingSentRef.current < TYPING_THROTTLE_MS) return;
    lastTypingSentRef.current = now;
    void sendChatTyping(workspace.id);
  }

  async function handleSend() {
    const text = draft.trim();
    if (!text) return;

    // Editing is infrequent and the message is already on screen, so it stays a
    // simple awaited update.
    if (editingId) {
      if (sending) return;
      setSending(true);
      setSendError("");
      try {
        const { message } = await editChatMessage({ workspaceId: workspace.id, id: editingId, text, e2ee });
        setState((current) => (current.kind === "ready"
          ? { ...current, messages: current.messages.map((m) => (m.id === message.id ? message : m)) }
          : current));
        setEditingId("");
        setDraft("");
      } catch (error) {
        setSendError(error instanceof Error ? error.message : "Couldn't send.");
      } finally {
        setSending(false);
      }
      return;
    }

    await sendText(text);
  }

  // Core optimistic send, shared by the composer and the GIF picker. The bubble
  // appears instantly, then the POST reconciles it: the id is pre-computed from
  // the idempotency key so the real message (same id) replaces the optimistic
  // one in place. Self-originated realtime events are skipped, so only this
  // response touches the bubble — no flicker, no duplicate. The composer is
  // cleared up front so a repeated Enter can't double-send while the id derives.
  async function sendText(text: string) {
    const replyToMsg = replyingTo;
    const baseSeq = messages.reduce((max, m) => Math.max(max, m.seq), 0) + 1;
    setSendError("");
    setDraft("");
    setReplyingTo(null);

    const key = generateIdempotencyKey();
    const id = await predictChatMessageId(workspace.id, myEmail, key);
    const optimisticId = id || `pending-${key}`;
    const optimistic: ChatMessage = {
      id: optimisticId,
      seq: baseSeq,
      email: myEmail,
      name: "",
      text,
      at: new Date().toISOString(),
      reactions: [],
      pending: true,
      ...(replyToMsg?.id ? { replyToId: replyToMsg.id } : {}),
    };
    setState((current) => (current.kind === "ready"
      ? { ...current, messages: mergeMessage(current.messages, optimistic) }
      : current));
    try {
      const { message } = await sendChatMessage({
        workspaceId: workspace.id, text, e2ee, replyToId: replyToMsg?.id, idempotencyKey: key,
      });
      setState((current) => (current.kind === "ready"
        ? { ...current, messages: mergeMessage(current.messages.filter((m) => m.id !== optimisticId), message) }
        : current));
    } catch (error) {
      // Roll back so nothing is silently lost: drop the bubble, restore the draft
      // and any reply target.
      setState((current) => (current.kind === "ready"
        ? { ...current, messages: current.messages.filter((m) => m.id !== optimisticId) }
        : current));
      setDraft(text);
      if (replyToMsg) setReplyingTo(replyToMsg);
      setSendError(error instanceof Error ? error.message : "Couldn't send.");
    }
  }

  // Send a RedGifs clip chosen from the picker as a normal message — its text is
  // the watch link, so resolveRedgifs + the muted-<video> bubble render it just
  // like a pasted GIF (chrome-free, no creator-handle leak).
  async function sendGif(gifId: string) {
    setShowGifSearch(false);
    setShowEmoji(false);
    await sendText(`https://www.redgifs.com/watch/${gifId}`);
  }

  // Infinite scroll: pull the next page and append (deduped) when the grid nears
  // the bottom, up to RedGifs' total page count.
  async function loadMoreGifs() {
    if (gifLoading || gifLoadingMore) return;
    const query = gifQuery.trim();
    if (!query || gifPage >= gifPages) return;
    setGifLoadingMore(true);
    const next = gifPage + 1;
    try {
      const { results } = await searchRedgifs(query, gifOrder, next);
      setGifResults((prev) => {
        const seen = new Set(prev.map((g) => g.id));
        return [...prev, ...results.filter((g) => !seen.has(g.id))];
      });
      setGifPage(next);
    } finally {
      setGifLoadingMore(false);
    }
  }

  async function handleSendImage(file: File) {
    if (sending) return;
    if (!file.type.startsWith("image/")) { setSendError("Only images can be sent right now."); return; }
    setSending(true);
    setSendError("");
    try {
      // Downscale + strip EXIF (incl. GPS) before encrypting; size-check the
      // bytes we actually upload, so a 40 MP original that normalizes to
      // ~300 KB is no longer rejected for its pre-shrink size.
      const normalized = await normalizeImageForUpload(file);
      if (normalized.size > 12 * 1024 * 1024) { setSendError("Image is too large (max 12 MB)."); setSending(false); return; }
      const uploaded = await uploadChatImage({ workspaceId: workspace.id, file: normalized });
      const { message } = await sendChatMessage({ workspaceId: workspace.id, text: "", e2ee, media: uploaded });
      setState((current) => (current.kind === "ready"
        ? { ...current, messages: mergeMessage(current.messages, message) }
        : current));
      if (navigator.vibrate) navigator.vibrate([6, 16, 8]);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Couldn't send that image.");
    } finally {
      setSending(false);
    }
  }

  async function handleReact(id: string, emoji: string) {
    setActiveId("");
    // Optimistic toggle — apply my reaction immediately (same per-(person,emoji)
    // toggle the server does), then reconcile with the server's copy. On failure,
    // reload to revert.
    setState((current) => (current.kind === "ready"
      ? { ...current, messages: current.messages.map((m) => (m.id === id ? { ...m, reactions: toggleReaction(m.reactions, myEmail, emoji) } : m)) }
      : current));
    try {
      const { message } = await reactToChatMessage({ workspaceId: workspace.id, id, emoji });
      setState((current) => (current.kind === "ready"
        ? { ...current, messages: current.messages.map((m) => (m.id === message.id ? message : m)) }
        : current));
    } catch {
      void reloadThread();
    }
  }

  async function handleUnsend(id: string) {
    setActiveId("");
    try {
      const { message } = await unsendChatMessage({ workspaceId: workspace.id, id });
      setState((current) => (current.kind === "ready"
        ? { ...current, messages: current.messages.map((m) => (m.id === message.id ? message : m)) }
        : current));
    } catch {
      void reloadThread();
    }
  }

  function startEdit(message: ChatMessage) {
    setActiveId("");
    setEditingId(message.id);
    setDraft(message.text);
  }

  // Render in canonical seq order so an optimistic message that reconciles after
  // a mid-flight reload still lands in the right place (the array itself is kept
  // in arrival order; sorting a copy keeps seq-derived state untouched).
  const sortedMessages = useMemo(
    () => messages.slice().sort((a, b) => a.seq - b.seq),
    [messages],
  );
  // Window the RENDER only (state/lookups keep the full list). New messages
  // land inside the window because the slice anchors to the end.
  const [visibleCount, setVisibleCount] = useState(CHAT_WINDOW_INITIAL);
  const hiddenCount = Math.max(0, sortedMessages.length - visibleCount);
  const grouped = useMemo(
    () => groupByDay(hiddenCount > 0 ? sortedMessages.slice(-visibleCount) : sortedMessages),
    [sortedMessages, visibleCount, hiddenCount],
  );
  const messagesById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const lastMineSeq = useMemo(() => messages.filter((m) => m.email.toLowerCase() === myEmail && !m.deletedAt).reduce((max, m) => Math.max(max, m.seq), 0), [messages, myEmail]);

  return (
    <AppShell>
      {/* Slim header — back + "Sext" only, so the messages own the screen. No
          name title, no static E2EE tagline; just a quiet live-presence line
          when the partner is actually around. */}
      <ScreenHeader
        eyebrow="Sext"
        showBrand={false}
        backHref="/sexboard"
        subtitle={partnerPresence
          ? (partnerPresence.online ? "Active now" : `Active ${relativeAgo(partnerPresence.at)}`)
          : undefined}
      />
      <PartnerTurnOns workspaceId={workspace.id} variant="strip" />
      <div className="chat-stage">
        <div className="chat-thread" role="log" aria-label="Messages" aria-live="polite" ref={threadRef}>
          {/* column-reverse: the DOM-first child renders at the visual BOTTOM, so
              the typing row sits just under the newest message, and the groups are
              emitted newest-first below so they land chronological top-to-bottom. */}
          {partnerTyping && (
            <div className="chat-row is-theirs chat-typing-row" aria-live="polite">
              <div className="chat-typing-bubble" role="status" aria-label={`${partnerName} is typing`}>
                <span className="chat-typing-dot" /><span className="chat-typing-dot" /><span className="chat-typing-dot" />
              </div>
            </div>
          )}
          {messages.length === 0 ? (
            <div className="chat-empty-state">
              <span className="chat-empty-mark" aria-hidden="true">
                <svg width="50" height="28" viewBox="6 14 88 32" fill="none">
                  <path d="M14 30 C 14 14, 40 14, 50 30 C 60 46, 86 46, 86 30 C 86 14, 60 14, 50 30 C 40 46, 14 46, 14 30 Z" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
                </svg>
              </span>
              <p className="chat-empty">Just the two of you here. Say something only {partnerName} gets to read.</p>
            </div>
          ) : (
            grouped.slice().reverse().map((group) => (
              <div key={group.day} className="chat-day-group">
                <div className="chat-day-divider"><span>{group.day}</span></div>
                {group.items.map((message, i) => {
                  const sender = message.email.toLowerCase();
                  const mine = sender === myEmail;
                  const prev = group.items[i - 1];
                  const next = group.items[i + 1];
                  // Consecutive messages from the same sender form a "run" — only
                  // the run's edges get round outer corners (iMessage grouping),
                  // and only the last shows the timestamp.
                  const firstInRun = !prev || prev.email.toLowerCase() !== sender;
                  const lastInRun = !next || next.email.toLowerCase() !== sender;
                  const seen = mine && message.seq === lastMineSeq && partnerReadSeq >= message.seq;
                  const original = message.replyToId ? messagesById.get(message.replyToId) : undefined;
                  const quote = message.replyToId
                    ? {
                        targetId: message.replyToId,
                        author: original ? (original.email.toLowerCase() === myEmail ? "You" : partnerName) : "",
                        preview: original ? messagePreview(original) : "Original message",
                      }
                    : null;
                  return (
                    <ChatBubbleMemo
                      key={message.id}
                      workspaceId={workspace.id}
                      message={message}
                      mine={mine}
                      firstInRun={firstInRun}
                      lastInRun={lastInRun}
                      seen={seen}
                      seenAt={seen ? partnerReadAt : ""}
                      active={activeId === message.id}
                      reacting={reactingId === message.id}
                      quote={quote}
                      onToggle={() => setActiveId((id) => (id === message.id ? "" : message.id))}
                      onLongPress={() => {
                        setActiveId("");
                        setReactingId(message.id);
                        // Center the held message so the emoji bar (above) and the
                        // action menu (below) both have room — iMessage does this.
                        if (typeof document !== "undefined") {
                          document.getElementById(`msg-${message.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
                        }
                      }}
                      onCloseReact={() => setReactingId("")}
                      onReact={(emoji) => { setReactingId(""); handleReact(message.id, emoji); }}
                      onReply={() => { setActiveId(""); setReactingId(""); setReplyingTo(message); }}
                      onCopy={() => {
                        const txt = (message.text || "").trim();
                        if (txt && typeof navigator !== "undefined" && navigator.clipboard) {
                          void navigator.clipboard.writeText(txt).catch(() => {});
                        }
                      }}
                      onEdit={() => startEdit(message)}
                      onUnsend={() => handleUnsend(message.id)}
                      onOpenImage={setLightboxMedia}
                    />
                  );
                })}
              </div>
            ))
          )}
          {/* DOM-last inside column-reverse = visual top, exactly where the
              older history "continues". */}
          {hiddenCount > 0 && (
            <div className="chat-load-earlier-row">
              <button
                type="button"
                className="chat-load-earlier pressable"
                onClick={() => setVisibleCount((count) => count + CHAT_WINDOW_STEP)}
              >
                Show earlier messages ({hiddenCount})
              </button>
            </div>
          )}
        </div>

        {sendError && <p className="chat-error" role="alert">{sendError}</p>}

        {showEmoji && (
          <div className="chat-emoji-palette" role="group" aria-label="Quick emojis">
            {XXX_EMOJIS.map((emoji) => (
              <button key={emoji} type="button" className="chat-emoji pressable" onClick={() => setDraft((d) => (d + emoji).slice(0, MAX_INPUT))}>
                {emoji}
              </button>
            ))}
          </div>
        )}
        {showGifSearch && (
          <div className="chat-gif-panel" role="group" aria-label="Search GIFs">
            <input
              className="chat-gif-input"
              type="text"
              value={gifQuery}
              onChange={(e) => setGifQuery(e.target.value)}
              placeholder="Search GIFs…"
              aria-label="Search GIFs"
              autoFocus
            />
            <div className="chat-gif-chips">
              {GIF_ORDERS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  className={`chat-gif-chip pressable ${gifOrder === opt.key ? "is-on" : ""}`}
                  onClick={() => setGifOrder(opt.key)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div
              className="chat-gif-grid"
              ref={gifGridRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) void loadMoreGifs();
              }}
            >
              {!gifQuery.trim() ? (
                <p className="chat-gif-hint">Search for a GIF.</p>
              ) : gifLoading && gifResults.length === 0 ? (
                <p className="chat-gif-hint">Searching…</p>
              ) : gifResults.length === 0 ? (
                <p className="chat-gif-hint">No GIFs — try another word.</p>
              ) : (
                [0, 1].map((col) => (
                  <div key={col} className="chat-gif-col">
                    {gifResults.filter((_, i) => i % 2 === col).map((gif) => (
                      <PickerGifTile
                        key={gif.id}
                        gif={gif}
                        gridRef={gifGridRef}
                        onSend={() => void sendGif(gif.id)}
                      />
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
        <form
          className="chat-composer"
          onSubmit={(e) => { e.preventDefault(); void handleSend(); }}
        >
          {editingId && (
            <div className="chat-editing-banner">
              Editing message
              <button type="button" className="chat-editing-cancel" onClick={() => { setEditingId(""); setDraft(""); }}>Cancel</button>
            </div>
          )}
          {replyingTo && !editingId && (
            <div className="chat-reply-banner">
              <span className="chat-reply-banner-bar" aria-hidden="true" />
              <div className="chat-reply-banner-body">
                <span className="chat-reply-banner-label">Replying to {replyingTo.email.toLowerCase() === myEmail ? "yourself" : partnerName}</span>
                <span className="chat-reply-banner-snippet">{messagePreview(replyingTo)}</span>
              </div>
              <button type="button" className="chat-editing-cancel" onClick={() => setReplyingTo(null)} aria-label="Cancel reply">×</button>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleSendImage(f); e.target.value = ""; }}
          />
          {!editingId && (
            <>
              <button
                type="button"
                className="chat-attach pressable"
                aria-label="Send a photo"
                disabled={sending}
                onClick={() => { setShowEmoji(false); setShowGifSearch(false); fileInputRef.current?.click(); }}
              >
                <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <rect x="3.5" y="5" width="17" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
                  <circle cx="8.5" cy="10" r="1.6" fill="currentColor" />
                  <path d="M5 17l4.5-4 3 2.5L16 11l3 3.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                className={`chat-attach pressable ${showEmoji ? "is-on" : ""}`}
                aria-label="Emojis"
                aria-pressed={showEmoji}
                onClick={() => { setShowEmoji((v) => !v); setShowGifSearch(false); }}
              >
                😈
              </button>
              {gifSearchEnabled && (
                <button
                  type="button"
                  className={`chat-attach chat-gif-toggle pressable ${showGifSearch ? "is-on" : ""}`}
                  aria-label="Search GIFs"
                  aria-pressed={showGifSearch}
                  onClick={() => { setShowGifSearch((v) => !v); setShowEmoji(false); }}
                >
                  GIF
                </button>
              )}
            </>
          )}
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); emitTyping(); }}
            onPaste={(e) => {
              const item = Array.from(e.clipboardData?.items || []).find((it) => it.type.startsWith("image/"));
              if (item) { const file = item.getAsFile(); if (file) { e.preventDefault(); void handleSendImage(file); } }
            }}
            onKeyDown={(e) => {
              // Enter sends only with a real keyboard (desktop / non-touch). On a
              // phone the Return key must insert a newline so you can write more
              // than one sentence — sending is the dedicated send button. (A
              // hardware Shift+Enter always inserts a newline regardless.)
              const coarsePointer = typeof window !== "undefined"
                && typeof window.matchMedia === "function"
                && window.matchMedia("(pointer: coarse)").matches;
              if (e.key === "Enter" && !e.shiftKey && !coarsePointer) { e.preventDefault(); void handleSend(); }
            }}
            onFocus={() => {
              // Once the keyboard finishes animating in (it lifts the composer via
              // :root[data-kb]), re-pin to the newest message so it stays in view.
              // In the column-reverse thread the bottom (newest) is scrollTop 0.
              window.setTimeout(() => { if (threadRef.current) threadRef.current.scrollTop = 0; }, 300);
            }}
            placeholder={`Message ${partnerName}…`}
            rows={1}
            className="chat-input"
            maxLength={MAX_INPUT}
            autoCapitalize="sentences"
            autoCorrect="on"
            spellCheck
            inputMode="text"
          />
          <button
            type="submit"
            className="chat-send pressable"
            disabled={!draft.trim() || sending}
            aria-label={editingId ? "Save edit" : "Send message"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 19.5V5M12 5l-6.5 6.5M12 5l6.5 6.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </form>
      </div>
      {lightboxMedia && (
        <ImageLightbox
          workspaceId={workspace.id}
          media={lightboxMedia}
          onClose={() => setLightboxMedia(null)}
        />
      )}
    </AppShell>
  );
}

function ChatBubble({
  workspaceId,
  message,
  mine,
  firstInRun,
  lastInRun,
  seen,
  seenAt,
  active,
  reacting,
  quote,
  onToggle,
  onLongPress,
  onCloseReact,
  onReact,
  onReply,
  onCopy,
  onEdit,
  onUnsend,
  onOpenImage,
}: {
  workspaceId: string;
  message: ChatMessage;
  mine: boolean;
  firstInRun: boolean;
  lastInRun: boolean;
  seen: boolean;
  seenAt: string;
  active: boolean;
  reacting: boolean;
  quote: { targetId: string; author: string; preview: string } | null;
  onToggle: () => void;
  onLongPress: () => void;
  onCloseReact: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onUnsend: () => void;
  onOpenImage: (media: ChatMedia) => void;
}) {
  const reactionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const reaction of message.reactions || []) counts.set(reaction.emoji, (counts.get(reaction.emoji) || 0) + 1);
    return [...counts.entries()];
  }, [message.reactions]);

  const body = message.deletedAt
    ? "Unsent."
    : message.e2eeLocked
    ? "Locked — unlock Room Encryption to read."
    : message.text;

  // A message whose text is a RedGifs link renders as an embedded GIF. CSP
  // already allows redgifs.com frames; the link rode in the (encrypted) text.
  const gifId = !message.deletedAt && !message.e2eeLocked && !message.media
    ? redgifsIdFromUrl((message.text || "").trim())
    : "";

  // iOS Messages-style hold-to-react/reply. A quick tap toggles the timestamp;
  // a held press opens the action menu. Track pointer movement with tolerance:
  // phones emit tiny move events during a stationary hold, while real vertical
  // scroll should still cancel the pending action.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStart = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const longPressed = useRef(false);
  const beginLongPress = useCallback((pointerId: number, x: number, y: number) => {
    // No actions on a deleted bubble, or one still sending (the server doesn't
    // have it yet, so react/edit/unsend would race a 404).
    if (message.deletedAt || message.pending) return;
    longPressed.current = false;
    longPressStart.current = { pointerId, x, y };
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => {
      longPressed.current = true;
      longPressStart.current = null;
      longPressTimer.current = null;
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
        try { navigator.vibrate(8); } catch { /* haptics optional */ }
      }
      onLongPress();
    }, CHAT_LONG_PRESS_MS);
  }, [message.deletedAt, message.pending, onLongPress]);
  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
    longPressStart.current = null;
  }, []);
  const moveLongPress = useCallback((pointerId: number, x: number, y: number) => {
    const start = longPressStart.current;
    if (!start || start.pointerId !== pointerId) return;
    if (Math.hypot(x - start.x, y - start.y) > CHAT_LONG_PRESS_MOVE_TOLERANCE_PX) cancelLongPress();
  }, [cancelLongPress]);
  useEffect(() => cancelLongPress, [cancelLongPress]);
  const handleTap = useCallback(() => {
    if (longPressed.current) { longPressed.current = false; return; }
    onToggle();
  }, [onToggle]);
  const pressHandlers = {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      beginLongPress(e.pointerId, e.clientX, e.clientY);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => moveLongPress(e.pointerId, e.clientX, e.clientY),
    onPointerUp: cancelLongPress,
    onPointerCancel: cancelLongPress,
    onLostPointerCapture: cancelLongPress,
    onContextMenu: (e: React.MouseEvent) => {
      if (message.deletedAt || message.pending) return;
      e.preventDefault();
      cancelLongPress();
      onLongPress();
    },
  };
  // Suppress the iOS long-press text/image selection callout on the bubble.
  const noCallout = { WebkitTouchCallout: "none" as const };

  return (
    <div id={`msg-${message.id}`} className={`chat-row ${mine ? "is-mine" : "is-theirs"}${firstInRun ? " run-start" : ""}${lastInRun ? " run-end" : ""}${message.pending ? " is-pending" : ""}`}>
      <div className={`chat-bubble-wrap ${reacting ? "is-reacting" : ""}`}>
        {quote && (
          <button
            type="button"
            className="chat-quote"
            onClick={() => {
              const el = typeof document !== "undefined" ? document.getElementById(`msg-${quote.targetId}`) : null;
              if (el) {
                el.scrollIntoView({ behavior: "smooth", block: "center" });
                el.classList.add("chat-row-flash");
                window.setTimeout(() => el.classList.remove("chat-row-flash"), 1200);
              }
            }}
          >
            <span className="chat-quote-author">{quote.author}</span>
            <span className="chat-quote-text">{quote.preview}</span>
          </button>
        )}
        {gifId ? (
          <div
            className="chat-bubble has-gif pressable"
            role="button"
            tabIndex={0}
            style={noCallout}
            onClick={handleTap}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
            {...pressHandlers}
          >
            <ChatGif gifId={gifId} sourceUrl={(message.text || "").trim()} />
          </div>
        ) : (
          <button
            type="button"
            className={`chat-bubble ${message.deletedAt ? "is-unsent" : ""} ${message.e2eeLocked ? "is-locked" : ""} ${message.media && !message.deletedAt && !message.e2eeLocked ? "has-media" : ""} pressable`}
            style={noCallout}
            onClick={handleTap}
            disabled={Boolean(message.deletedAt)}
            {...pressHandlers}
          >
            {message.media && !message.deletedAt && !message.e2eeLocked && (
              <ChatImage
                workspaceId={workspaceId}
                media={message.media}
                onOpen={() => { if (!longPressed.current && message.media) onOpenImage(message.media); }}
              />
            )}
            {body ? <span className="chat-bubble-text">{body}</span> : null}
          </button>
        )}
        {reacting && !message.deletedAt && (
          <>
            <button
              type="button"
              className="chat-react-backdrop"
              aria-label="Dismiss reactions"
              onClick={onCloseReact}
            />
            <div className={`chat-react-picker ${mine ? "is-mine" : "is-theirs"}`} role="menu" aria-label="React to message">
              {REACTION_CHOICES.map(({ glyph, label }) => (
                <button
                  key={glyph}
                  type="button"
                  className="chat-react-btn pressable"
                  aria-label={label}
                  title={label}
                  onClick={() => onReact(glyph)}
                >
                  {glyph}
                </button>
              ))}
            </div>
            <div className={`chat-context-menu ${mine ? "is-mine" : "is-theirs"}`} role="menu" aria-label="Message actions">
              <button type="button" className="chat-context-item" onClick={() => { onCloseReact(); onReply(); }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M10 8V5l-7 7 7 7v-3.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /></svg>
                Reply
              </button>
              {!message.media && !message.e2eeLocked && (message.text || "").trim() ? (
                <button type="button" className="chat-context-item" onClick={() => { onCloseReact(); onCopy(); }}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.7" /><path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" strokeWidth="1.7" /></svg>
                  Copy
                </button>
              ) : null}
              {mine && (
                <button type="button" className="chat-context-item" onClick={() => { onCloseReact(); onEdit(); }}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 20h4L18 10l-4-4L4 16v4z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /></svg>
                  Edit
                </button>
              )}
              {mine && (
                <button type="button" className="chat-context-item is-danger" onClick={() => { onCloseReact(); onUnsend(); }}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2m-7 0 1 13h8l1-13" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /></svg>
                  Unsend
                </button>
              )}
            </div>
          </>
        )}
        {reactionCounts.length > 0 && (
          <div className="chat-reactions">
            {reactionCounts.map(([emoji, count]) => (
              <span key={emoji} className="chat-reaction-chip">{emoji}{count > 1 ? ` ${count}` : ""}</span>
            ))}
          </div>
        )}
        {message.pending ? (
          <span className="chat-bubble-meta">Sending…</span>
        ) : !message.deletedAt && (lastInRun || active) ? (
          <span className="chat-bubble-meta">
            {timeLabel(message.at)}{message.editedAt ? " · edited" : ""}
          </span>
        ) : null}
        {seen && (
          <span className="chat-seen">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12.5l5 5 11-12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
            Seen{seenAt ? ` ${timeLabel(seenAt)}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}

// Memoized so a keystroke in the composer (which lives in the parent and
// re-renders it on every character) doesn't re-render every message bubble.
// The inline on* handlers are recreated each parent render but stay behaviorally
// stable for a given message, so the comparator only weighs the data props.
// (message keeps a stable ref across renders unless that message changed — see
// mergeMessage — so an unrelated parent re-render skips every bubble.)
const ChatBubbleMemo = memo(ChatBubble, (prev, next) => {
  const q1 = prev.quote;
  const q2 = next.quote;
  const sameQuote = q1 === q2
    || (!!q1 && !!q2 && q1.targetId === q2.targetId && q1.author === q2.author && q1.preview === q2.preview);
  return sameQuote
    && prev.message === next.message
    && prev.workspaceId === next.workspaceId
    && prev.mine === next.mine
    && prev.firstInRun === next.firstInRun
    && prev.lastInRun === next.lastInRun
    && prev.seen === next.seen
    && prev.seenAt === next.seenAt
    && prev.active === next.active
    && prev.reacting === next.reacting;
});

// A RedGifs link renders as a muted, looping clip in our own <video> — the
// same anonymized treatment the shelf uses. We resolve the direct URL through
// /api/redgifs (token + cache live server-side) instead of RedGifs' /ifr/
// iframe, which leaked the creator handle and now just shows "error loading
// this gif". pointer-events stay off the video so a long-press still reaches
// the bubble for react/reply. If resolution fails, we offer the source link.
type GifState =
  | { kind: "loading" }
  | { kind: "ready"; src: string; poster: string }
  | { kind: "failed" };

function ChatGif({ gifId, sourceUrl }: { gifId: string; sourceUrl: string }) {
  // Reveal-gated like Off the Shelf: a thread GIF opens HIDDEN behind a gradient
  // placeholder and only plays after a Reveal tap — nothing is fetched or
  // decoded until then, and it can be hidden again. Reveal state is local (each
  // viewer/device reveals on its own) and resets to hidden on reload.
  const [revealed, setRevealed] = useState(false);
  const [state, setState] = useState<GifState>({ kind: "loading" });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Every historical GIF in the thread used to keep a looping <video> decoding
  // forever. iOS caps concurrent video decoders, so a GIF-heavy thread froze
  // later clips and burned battery. Play only near the viewport; fully detach
  // (src removed) when scrolled away so the decoder + network are released.
  const [viewRef, inView] = useInView<HTMLDivElement>({ once: false, rootMargin: "300px 0px 300px 0px", threshold: 0 });

  // Resolve ONLY after reveal — an unrevealed GIF costs zero network/decode.
  useEffect(() => {
    if (!revealed) return;
    let cancelled = false;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ kind: "loading" });
    // Resolve from the full pasted URL so the server tries every candidate id
    // (Share-button links included); fall back to the bare id if there's no URL.
    resolveRedgifs(sourceUrl || gifId, controller.signal)
      .then((direct) => {
        if (cancelled) return;
        setState(
          direct && (direct.hd || direct.sd)
            ? { kind: "ready", src: direct.hd || direct.sd, poster: direct.poster }
            : { kind: "failed" },
        );
      })
      .catch(() => { if (!cancelled) setState({ kind: "failed" }); });
    return () => { cancelled = true; controller.abort(); };
  }, [revealed, gifId, sourceUrl]);

  useEffect(() => {
    if (!revealed || state.kind !== "ready" || !videoRef.current) return;
    const video = videoRef.current;
    if (inView) {
      if (!video.getAttribute("src")) {
        video.src = state.src;
        video.load();
      }
      // iOS only autoplays when muted is set as a DOM property, not just the
      // attribute — React doesn't always reflect it, so force it here.
      video.muted = true;
      video.defaultMuted = true;
      video.play().catch(() => {});
    } else {
      video.pause();
      // Detaching src (not just pausing) is what actually frees the iOS
      // decoder slot and stops the stream; the poster keeps the visual.
      video.removeAttribute("src");
      video.load();
    }
  }, [revealed, state, inView]);

  // ONE wrapper carries the IntersectionObserver ref across ALL states.
  // useInView attaches its observer in a mount effect — when the ref'd
  // element only existed in the "ready" branch, the observer bound to null
  // during the resolve and never re-attached, so inView stayed false and no
  // GIF ever got a src (v1.2.145 regression: "GIFs aren't playing").
  return (
    <div ref={viewRef} className={`chat-gif-inview ${revealed ? "is-revealed" : ""}`}>
      {!revealed ? (
        // Hidden by default. The button is interactive (the video states keep
        // pointer-events:none so a long-press still reaches the bubble for
        // react/reply); stopPropagation so revealing doesn't also toggle the
        // bubble's action row.
        <button
          type="button"
          className="chat-gif-hidden pressable"
          onClick={(e) => { e.stopPropagation(); setRevealed(true); }}
          aria-label="Reveal GIF"
        >
          <span className="chat-gif-art" aria-hidden="true">
            <span className="art-base" />
            <span className="art-bloom-a" />
            <span className="art-bloom-b" />
            <span className="art-vignette" />
          </span>
          <span className="chat-gif-reveal-label">🎞️ Reveal</span>
        </button>
      ) : (
        <>
          {state.kind === "failed" ? (
            // Server-side resolution didn't return a direct URL (RedGifs
            // rate-limits Cloudflare's egress, so /api/redgifs often can't reach
            // it). The browser can still load RedGifs' own embed directly, so
            // fall back to the iframe — it plays inline rather than bouncing the
            // user out to Safari.
            <iframe
              src={`https://www.redgifs.com/ifr/${gifId}?hd=1&autoplay=1&muted=1`}
              title="GIF"
              className="chat-gif-frame"
              allow="autoplay; encrypted-media"
              loading="lazy"
            />
          ) : state.kind === "loading" ? (
            <span className="chat-gif-frame chat-gif-loading" aria-label="Loading GIF" />
          ) : (
            // No src attribute — playback is attach/detach-managed by the
            // in-view effect above; the video keeps its class and sizing.
            <video
              ref={videoRef}
              className="chat-gif-video"
              poster={state.poster || undefined}
              muted
              loop
              playsInline
              preload="none"
              disablePictureInPicture
              onCanPlay={(e) => { e.currentTarget.muted = true; e.currentTarget.play().catch(() => {}); }}
            />
          )}
          <button
            type="button"
            className="chat-gif-hide pressable"
            onClick={(e) => { e.stopPropagation(); setRevealed(false); setState({ kind: "loading" }); }}
            aria-label="Hide GIF"
          >
            Hide
          </button>
        </>
      )}
    </div>
  );
}

// Picker tile — autoplays like Giphy, but only while near the picker's visible
// area. The observer's root is the grid's own scroll container, so off-screen
// tiles pause + DETACH their src; infinite scroll then can't pile up 40-80
// concurrent decoders / ~100 MB of streaming (the reason the tiles were static
// posters in v1.2.145). Poster shows before play / if autoplay is blocked.
function PickerGifTile({ gif, gridRef, onSend }: {
  gif: RedgifsSearchResult;
  gridRef: RefObject<HTMLDivElement | null>;
  onSend: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [tileRef, inView] = useInView<HTMLButtonElement>({
    once: false,
    root: gridRef,
    rootMargin: "200px 0px 200px 0px",
    threshold: 0,
  });
  const src = gif.sd || gif.hd;

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (inView) {
      if (!el.getAttribute("src")) {
        el.src = src;
        el.load();
      }
      el.muted = true;
      el.play().catch(() => {});
    } else {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
  }, [inView, src]);

  return (
    <button
      ref={tileRef}
      type="button"
      className="chat-gif-tile pressable"
      onClick={onSend}
      aria-label="Send this GIF"
    >
      <video
        ref={videoRef}
        poster={gif.poster}
        muted
        loop
        playsInline
        preload="none"
        disablePictureInPicture
      />
    </button>
  );
}

function ChatImage({ workspaceId, media, onOpen }: { workspaceId: string; media: ChatMedia; onOpen?: () => void }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  // Fetch + decrypt only when the bubble approaches the viewport. Every image
  // in the thread used to do this eagerly on mount — opening a thread with 30
  // photos meant ~30 full downloads + AES decrypts before you scrolled at all.
  // once:true — after decode we keep the object URL; re-gating on scroll-out
  // would just churn createObjectURL against the (still-cached) blob.
  const [viewRef, inView] = useInView<HTMLSpanElement>({ once: true, rootMargin: "600px 0px 600px 0px", threshold: 0 });

  useEffect(() => {
    if (!inView) return;
    let cancelled = false;
    let objectUrl = "";
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl("");
    setFailed(false);
    getChatImageBlobCached({ workspaceId, media })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [inView, workspaceId, media.mediaId, media.key, media.iv]);

  if (failed) return <span className="chat-image-status">Image unavailable</span>;
  // The ref span doubles as the not-yet-visible placeholder (same reserved
  // min-height as the loading state, so no scroll jump when it fills in).
  if (!url) return <span ref={viewRef} className="chat-image-status" aria-label="Loading image">Loading…</span>;
  // Decrypted blob object URL — next/image can't take these, so a plain img.
  // Tap opens the fullscreen, pinch-zoomable lightbox; stopPropagation keeps the
  // tap from also toggling the bubble's action row. The lightbox reads the same
  // blob through the LRU, so revoking this URL on unmount stays safe.
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt="Shared image"
      className="chat-image"
      decoding="async"
      onClick={(e) => { if (onOpen) { e.stopPropagation(); onOpen(); } }}
    />
  );
}

function mergeMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  if (messages.some((m) => m.id === message.id)) {
    return messages.map((m) => (m.id === message.id ? message : m));
  }
  return [...messages, message];
}

function sameReactions(a: ChatReaction[] | undefined, b: ChatReaction[] | undefined): boolean {
  const x = a || [];
  const y = b || [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i += 1) {
    if (x[i].by !== y[i].by || x[i].emoji !== y[i].emoji) return false;
  }
  return true;
}

// Everything a bubble renders from its message prop. media key/iv never change
// for a given mediaId, so the id stands in for the whole object.
function sameRenderedMessage(a: ChatMessage, b: ChatMessage): boolean {
  return a.id === b.id
    && a.seq === b.seq
    && a.text === b.text
    && (a.editedAt || "") === (b.editedAt || "")
    && (a.deletedAt || "") === (b.deletedAt || "")
    && Boolean(a.e2eeLocked) === Boolean(b.e2eeLocked)
    && Boolean(a.pending) === Boolean(b.pending)
    && (a.replyToId || "") === (b.replyToId || "")
    && (a.media?.mediaId || "") === (b.media?.mediaId || "")
    && sameReactions(a.reactions, b.reactions);
}

// Reconcile a reload with current state WITHOUT breaking object identity:
// ChatBubbleMemo skips a bubble only while `prev.message === next.message`, so
// a wholesale replace used to re-render all ~N bubbles on every partner event.
//  - incremental (`after` fetch): fetched holds only NEW messages — merge them
//    into the existing list, which keeps every old reference by construction.
//  - full fetch: adopt the server's list but reuse the previous object for any
//    message whose rendered content is unchanged; if nothing changed at all,
//    return the previous array so React skips the state update entirely.
function mergeThreadMessages(prev: ChatMessage[], fetched: ChatMessage[], incremental: boolean): ChatMessage[] {
  if (incremental) {
    if (fetched.length === 0) return prev;
    let next = prev;
    for (const message of fetched) next = mergeMessage(next, message);
    return next;
  }
  const prevById = new Map(prev.map((m) => [m.id, m]));
  const merged = fetched.map((message) => {
    const old = prevById.get(message.id);
    return old && sameRenderedMessage(old, message) ? old : message;
  });
  const identical = merged.length === prev.length && merged.every((m, i) => m === prev[i]);
  return identical ? prev : merged;
}

// Mirrors the server's per-(person, emoji) toggle (functions/api/chat.js react
// action) so an optimistic reaction matches what the server will store.
function toggleReaction(reactions: ChatReaction[], myEmail: string, emoji: string): ChatReaction[] {
  const list = reactions || [];
  const mineIndex = list.findIndex((r) => r.by === myEmail && r.emoji === emoji);
  return mineIndex === -1 ? [...list, { by: myEmail, emoji }] : list.filter((_, i) => i !== mineIndex);
}

function timeLabel(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function dayLabel(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, today)) return "Today";
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function groupByDay(messages: ChatMessage[]): { day: string; items: ChatMessage[] }[] {
  const groups: { day: string; items: ChatMessage[] }[] = [];
  for (const message of messages) {
    const day = dayLabel(message.at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(message);
    else groups.push({ day, items: [message] });
  }
  return groups;
}
