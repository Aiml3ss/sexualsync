"use client";

import { useEffect, useRef } from "react";

export const LIVE_ROOM_EVENT = "sexualsync:room-event";
export const LIVE_ROOM_PRESENCE = "sexualsync:room-presence";
const LAST_EVENT_SEQ_KEY = "ss:room:last-seq:";

export type LiveRoomResource =
  | "request-board"
  | "fantasy-backlog"
  | "shelf"
  | "vault"
  | "pile"
  | "blind-reveals"
  | "chat"
  | "presence";

export interface LiveRoomEventDetail {
  seq?: number;
  id?: string;
  resource?: string;
  action?: string;
  entityId?: string;
  actorEmail?: string;
  actorName?: string;
  at?: string;
  passive?: boolean;
}

export interface LiveRoomPresenceDetail {
  actorEmail?: string;
  actorName?: string;
  status?: string;
  at?: string;
}

interface RoomMessage {
  type?: string;
  seq?: number;
  latestSeq?: number;
  event?: LiveRoomEventDetail;
  actorEmail?: string;
  actorName?: string;
  status?: string;
  at?: string;
  // room.hello: the actors already connected when we join (seeds presence).
  online?: string[];
}

function parseMessage(raw: MessageEvent<string>): RoomMessage | null {
  try {
    return JSON.parse(raw.data) as RoomMessage;
  } catch {
    return null;
  }
}

function normalizeSeq(value: unknown) {
  const seq = Number.parseInt(String(value || "0"), 10);
  return Number.isFinite(seq) && seq > 0 ? seq : 0;
}

function storedSeqKey(workspaceId: string) {
  return `${LAST_EVENT_SEQ_KEY}${workspaceId}`;
}

function readStoredSeq(workspaceId: string) {
  try {
    return normalizeSeq(window.localStorage.getItem(storedSeqKey(workspaceId)));
  } catch {
    return 0;
  }
}

function writeStoredSeq(workspaceId: string, seq: number) {
  if (!seq) return;
  try {
    window.localStorage.setItem(storedSeqKey(workspaceId), String(seq));
  } catch {}
}

function socketUrl(workspaceId: string, lastEventSeq: number) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL("/api/room/socket", `${protocol}//${window.location.host}`);
  url.searchParams.set("workspaceId", workspaceId);
  if (lastEventSeq > 0) url.searchParams.set("lastEventSeq", String(lastEventSeq));
  return url.toString();
}

function dispatchLiveRoomEvent(name: string, detail: unknown) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function useLiveRoomReload({
  workspaceId,
  actorEmail,
  resources,
  onReload,
}: {
  workspaceId?: string;
  actorEmail?: string;
  resources: LiveRoomResource[];
  onReload: () => Promise<void> | void;
}) {
  const reloadRef = useRef(onReload);
  const resourceRef = useRef(new Set(resources));
  const actorRef = useRef((actorEmail || "").toLowerCase());

  useEffect(() => { reloadRef.current = onReload; }, [onReload]);
  useEffect(() => { resourceRef.current = new Set(resources); }, [resources]);
  useEffect(() => { actorRef.current = (actorEmail || "").toLowerCase(); }, [actorEmail]);

  useEffect(() => {
    if (!workspaceId || typeof window === "undefined" || !("WebSocket" in window)) return;
    const liveWorkspaceId = workspaceId;

    let closed = false;
    let retry = 0;
    let socket: WebSocket | null = null;
    let heartbeat: number | null = null;
    let reconnectTimer: number | null = null;
    let retryResetTimer: number | null = null;
    let reloadTimer: number | null = null;
    let reloadInFlight = false;
    let reloadQueued = false;
    let lastReloadAt = 0;
    let lastEventSeq = readStoredSeq(liveWorkspaceId);
    // Liveness: any inbound frame proves the socket is real. Mobile networks
    // produce half-open sockets (readyState OPEN, peer long gone) that never
    // fire `close` — without a receive-side deadline we'd keep "sending"
    // heartbeats into the void until the OS notices. 90s ≈ two heartbeat
    // rounds plus slack for background-tab timer throttling (~1/min), so a
    // healthy-but-throttled tab never trips it.
    const LIVENESS_TIMEOUT_MS = 90_000;
    let lastInboundAt = 0;

    function rememberSeq(value: unknown) {
      const seq = normalizeSeq(value);
      if (!seq || seq <= lastEventSeq) return;
      lastEventSeq = seq;
      writeStoredSeq(liveWorkspaceId, seq);
    }

    function clearHeartbeat() {
      if (heartbeat !== null) window.clearInterval(heartbeat);
      heartbeat = null;
    }

    function clearRetryReset() {
      if (retryResetTimer !== null) window.clearTimeout(retryResetTimer);
      retryResetTimer = null;
    }

    let pendingWhileHidden = false;

    function scheduleReload() {
      lastReloadAt = Date.now();
      if (reloadTimer !== null) window.clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(() => {
        // Don't refetch + re-decrypt the whole resource for a screen the user
        // isn't looking at — on mobile the tab is backgrounded constantly. While
        // hidden, coalesce every missed event into a single reload that fires
        // when the tab becomes visible again (see onVisibility).
        if (typeof document !== "undefined" && document.visibilityState === "hidden") {
          pendingWhileHidden = true;
          return;
        }
        if (reloadInFlight) {
          reloadQueued = true;
          return;
        }
        reloadInFlight = true;
        Promise.resolve(reloadRef.current())
          .catch(() => {})
          .finally(() => {
            reloadInFlight = false;
            if (reloadQueued && !closed) {
              reloadQueued = false;
              scheduleReload();
            }
          });
      }, 350);
    }

    function onVisibility() {
      if (typeof document === "undefined") return;
      if (document.visibilityState === "visible" && pendingWhileHidden) {
        pendingWhileHidden = false;
        scheduleReload();
      }
    }

    function connect() {
      if (closed) return;
      try {
        socket = new WebSocket(socketUrl(liveWorkspaceId, lastEventSeq));
      } catch {
        scheduleReconnect();
        return;
      }

      socket.addEventListener("open", () => {
        // Don't reset `retry` immediately: a link that connects then drops
        // within a second would otherwise tight-loop at the backoff floor.
        // Only reset once the socket has stayed open long enough to be real.
        clearRetryReset();
        retryResetTimer = window.setTimeout(() => {
          retry = 0;
          retryResetTimer = null;
        }, 10_000);
        clearHeartbeat();
        lastInboundAt = Date.now();
        heartbeat = window.setInterval(() => {
          if (socket?.readyState !== WebSocket.OPEN) return;
          if (Date.now() - lastInboundAt > LIVENESS_TIMEOUT_MS) {
            // Dead peer: force the close path so the jittered reconnect (and
            // its resync-on-open) takes over instead of a zombie connection.
            try { socket.close(); } catch { /* already gone */ }
            return;
          }
          socket.send(JSON.stringify({ type: "heartbeat" }));
        }, 25_000);
        // The WS replay buffer is capped server-side, so a client that was
        // offline past the cap would silently miss events. Treat every
        // (re)connect as an invalidation signal and reconcile every subscribed
        // resource from the source of truth. Debounced so rapid reconnects
        // don't cause a reload storm, but a genuinely-behind client always
        // catches up because the steady-state path keeps lastReloadAt fresh.
        if (resourceRef.current.size > 0 && Date.now() - lastReloadAt > 5_000) {
          scheduleReload();
        }
      });

      socket.addEventListener("message", (event) => {
        // Any frame (hello/event/presence/pong) counts as proof of life.
        lastInboundAt = Date.now();
        const message = parseMessage(event);
        if (!message) return;
        if (message.type === "room.hello") {
          if (lastEventSeq <= 0) rememberSeq(message.latestSeq);
          // Surface who is ALREADY present as presence events — plain presence
          // only covers online/offline changes after we connect, so without this
          // a freshly-opened screen can't tell a partner who's already online.
          if (Array.isArray(message.online)) {
            for (const email of message.online) {
              if ((email || "").toLowerCase() === actorRef.current) continue;
              dispatchLiveRoomEvent(LIVE_ROOM_PRESENCE, { actorEmail: email, status: "online", at: message.at });
            }
          }
          return;
        }
        if (message.type === "room.event") {
          const roomEvent = message.event || {};
          rememberSeq(message.seq || roomEvent.seq);
          const fromMe = (roomEvent.actorEmail || "").toLowerCase() === actorRef.current;
          if (!fromMe && roomEvent.resource) {
            dispatchLiveRoomEvent(LIVE_ROOM_EVENT, roomEvent);
            if (resourceRef.current.has(roomEvent.resource as LiveRoomResource)) {
              scheduleReload();
            }
          }
          return;
        }
        if (message.type === "room.presence") {
          const fromMe = (message.actorEmail || "").toLowerCase() === actorRef.current;
          if (!fromMe) {
            dispatchLiveRoomEvent(LIVE_ROOM_PRESENCE, {
              actorEmail: message.actorEmail,
              actorName: message.actorName,
              status: message.status,
              at: message.at,
            });
            if (resourceRef.current.has("presence")) scheduleReload();
          }
        }
      });

      socket.addEventListener("close", () => {
        clearHeartbeat();
        clearRetryReset();
        scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        try { socket?.close(); } catch {}
      });
    }

    function scheduleReconnect() {
      if (closed) return;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      // Full jitter: pick a delay uniformly in [0, cap] so devices reconnecting
      // after a redeploy spread out instead of forming a thundering herd, and a
      // flaky link that drops fast doesn't tight-loop at a fixed floor.
      const ceiling = Math.min(20_000, 1_000 * Math.pow(1.7, retry++));
      const delay = Math.random() * ceiling;
      reconnectTimer = window.setTimeout(connect, delay);
    }

    connect();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      closed = true;
      clearHeartbeat();
      clearRetryReset();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (reloadTimer !== null) window.clearTimeout(reloadTimer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      try { socket?.close(); } catch {}
    };
  }, [workspaceId]);
}
