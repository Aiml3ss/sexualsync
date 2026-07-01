// In-process realtime room registry for the self-host edition.
//
// Mirrors the semantics of the Cloudflare RoomDurableObject
// (workers/room/src/index.js): per-workspace rooms, a bounded event spine with
// monotonic sequence numbers for reconnect replay, keep-first dedupe, and
// presence broadcasts. It runs inside the single Node process, so the same
// instance both fans out to connected WebSockets AND answers the HTTP-side
// broadcast/events calls the product handlers make via `env.ROOMS`.
//
// This is the Node implementation of the RealtimeStateAdapter broadcast seam.
// Multi-process deployments would replace the in-memory map with a shared
// transport (see docs/self-host/MIGRATION_PLAN.md).

import { randomUUID } from "node:crypto";

const MAX_EVENT_BYTES = 4096;
const EVENT_REPLAY_LIMIT = 80;
const EVENT_RETENTION_LIMIT = 240;
// Mirror the Cloudflare DO's socket-liveness layer (workers/room/src/index.js):
// sweep every 30s and reap a socket we haven't heard from in ~4 heartbeat windows.
// Without this, a socket killed WITHOUT a clean close (iOS background kill, dropped
// network) shows "online" forever on the self-host edition — the parity gap flagged
// in the audit (rule #4: the two impls must stay in sync). The STALE multiplier is
// derived from HEARTBEAT_TTL_MS exactly as the DO derives it, so tuning the window
// in one impl can't silently desync the other; scripts/room-event-spine-check.mjs
// asserts both files keep these constants in agreement.
const HEARTBEAT_TTL_MS = 45 * 1000;
const REAPER_INTERVAL_MS = 30 * 1000;
const STALE_SOCKET_TTL_MS = HEARTBEAT_TTL_MS * 4;

function clean(value, max = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}
function cleanEmail(value) {
  return clean(value, 160).toLowerCase();
}
function nowIso() {
  return new Date().toISOString();
}

function safeEvent(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    type: clean(source.type || "room.event", 48),
    id: clean(source.id, 120) || randomUUID(),
    resource: clean(source.resource, 64),
    action: clean(source.action, 64),
    entityId: clean(source.entityId, 120),
    actorEmail: cleanEmail(source.actorEmail),
    actorName: clean(source.actorName, 80),
    at: clean(source.at || nowIso(), 40),
    passive: Boolean(source.passive),
    dedupe: clean(source.dedupe || source.coalesce, 40)
  };
}

function presencePayload(state, status) {
  return {
    type: "room.presence",
    status,
    actorEmail: state.actorEmail,
    actorName: state.actorName,
    at: nowIso()
  };
}

// Mirror the Cloudflare DO's presence dedup (workers/room/src/index.js:
// hasOtherSocketForActor — online at :294, offline at :391): an actor with more
// than one live socket (two tabs, a PWA reconnect flap) must announce "online"
// only on its FIRST socket and "offline" only when its LAST socket goes. Without
// this the Node room blinks the partner offline/online on every extra socket —
// the rule #4 divergence flagged in the self-host audit. `except` is the socket
// being added or removed, excluded from the scan.
function hasOtherSocketForActor(room, actorEmail, except) {
  const email = cleanEmail(actorEmail);
  if (!email) return false;
  for (const conn of room.conns) {
    if (conn === except) continue;
    if (cleanEmail(conn.state?.actorEmail) === email) return true;
  }
  return false;
}

function eventMessage(event) {
  return { type: "room.event", seq: event.seq, event: { ...event, seq: event.seq } };
}

class Room {
  constructor() {
    this.conns = new Set();
    this.events = [];
    this.seq = 0;
  }

  latestSeq() {
    return this.seq;
  }

  persist(event) {
    if (event.dedupe === "keep-first") {
      const existing = this.events.find((e) => e.id === event.id);
      if (existing) return existing;
    }
    this.seq += 1;
    const persisted = { ...event, seq: this.seq };
    this.events.push(persisted);
    if (this.events.length > EVENT_RETENTION_LIMIT) {
      this.events.splice(0, this.events.length - EVENT_RETENTION_LIMIT);
    }
    return persisted;
  }

  after(seq) {
    const start = Number(seq) || 0;
    return this.events.filter((e) => e.seq > start).slice(0, EVENT_REPLAY_LIMIT);
  }

  send(conn, obj) {
    try { conn.ws.send(JSON.stringify(obj)); } catch { /* dead socket */ }
  }

  broadcast(obj, except = null) {
    for (const conn of this.conns) {
      if (conn === except) continue;
      this.send(conn, obj);
    }
  }

  disconnect(actorEmail = "", reason = "access_revoked") {
    const target = cleanEmail(actorEmail);
    const closed = [];
    for (const conn of [...this.conns]) {
      if (target && cleanEmail(conn.state?.actorEmail) !== target) continue;
      this.conns.delete(conn);
      closed.push(conn.state || {});
      try { (conn.ws.terminate || conn.ws.close)?.call(conn.ws, 1008, reason); } catch { /* already gone */ }
    }
    const announced = new Set();
    for (const state of closed) {
      const email = cleanEmail(state.actorEmail);
      if (!email || announced.has(email)) continue;
      announced.add(email);
      this.broadcast(presencePayload(state, "offline"));
    }
    return closed.length;
  }
}

export class RoomRegistry {
  constructor() {
    this.rooms = new Map();
    // Periodic sweep for sockets that died without a clean close. unref() so the
    // timer never keeps the Node process (or a test runner) alive on its own —
    // the HTTP server holds the real lifetime ref.
    this._reaper = setInterval(() => this._reap(), REAPER_INTERVAL_MS);
    if (this._reaper && typeof this._reaper.unref === "function") this._reaper.unref();
  }

  // Close sockets we haven't heard from within STALE_SOCKET_TTL_MS and correct
  // presence, so a background-killed client doesn't linger as "online".
  _reap() {
    const now = Date.now();
    for (const [workspaceId, room] of [...this.rooms]) {
      for (const conn of [...room.conns]) {
        const lastSeen = Date.parse(conn.state?.lastSeenAt || "") || 0;
        if (now - lastSeen <= STALE_SOCKET_TTL_MS) continue;
        const wasPresent = room.conns.delete(conn);
        try { (conn.ws.terminate || conn.ws.close)?.call(conn.ws); } catch { /* already gone */ }
        // Dedup: only announce "offline" if this actor has no surviving socket.
        if (wasPresent && !hasOtherSocketForActor(room, conn.state?.actorEmail, conn)) {
          room.broadcast(presencePayload(conn.state, "offline"), conn);
        }
      }
      if (room.conns.size === 0 && room.events.length === 0) this.rooms.delete(workspaceId);
    }
  }

  // Stop the reaper (for clean shutdown / tests). Optional — the timer is unref'd.
  stop() {
    if (this._reaper) { clearInterval(this._reaper); this._reaper = null; }
  }

  room(id) {
    if (!this.rooms.has(id)) this.rooms.set(id, new Room());
    return this.rooms.get(id);
  }

  connect(workspaceId, ws, state) {
    const room = this.room(workspaceId);
    // Baseline freshness so the reaper can tell a never-heard-from socket from a
    // live one; heartbeats / presence messages refresh it.
    state.lastSeenAt = nowIso();
    const conn = { ws, state };
    room.conns.add(conn);

    // Actors already present (excluding this just-added conn), so the connecting
    // client learns who's online up front — mirrors the Durable Object's hello.
    const online = [...new Set(
      [...room.conns].filter((c) => c !== conn).map((c) => c.state?.actorEmail).filter(Boolean),
    )];
    room.send(conn, { type: "room.hello", workspaceId, latestSeq: room.latestSeq(), online, at: nowIso() });
    for (const event of room.after(state.lastEventSeq)) room.send(conn, eventMessage(event));
    // Dedup: announce "online" only when this is the actor's first live socket.
    if (!hasOtherSocketForActor(room, state.actorEmail, conn)) {
      room.broadcast(presencePayload(state, "online"), conn);
    }

    ws.on("message", (msg) => this._onMessage(conn, room, msg));
    ws.on("close", () => {
      // `wasPresent` guards against a double "offline" when the reaper already
      // removed this conn between the socket dying and `close` firing.
      const wasPresent = room.conns.delete(conn);
      // Dedup: announce "offline" only when the actor has no surviving socket.
      if (wasPresent && !hasOtherSocketForActor(room, state.actorEmail, conn)) {
        room.broadcast(presencePayload(state, "offline"), conn);
      }
      if (room.conns.size === 0 && room.events.length === 0) this.rooms.delete(workspaceId);
    });
    return conn;
  }

  _onMessage(conn, room, msg) {
    let payload;
    try { payload = JSON.parse(msg); } catch { return; }
    if (payload?.type === "heartbeat") {
      conn.state.lastSeenAt = nowIso();
      room.send(conn, { type: "room.pong", at: conn.state.lastSeenAt });
      return;
    }
    if (payload?.type === "presence") {
      conn.state.lastSeenAt = nowIso();
      room.broadcast(presencePayload(conn.state, "active"), conn);
    }
  }

  broadcastEvent(workspaceId, rawEvent) {
    const event = safeEvent(rawEvent);
    if (!event.resource || !event.action) return { ok: false, error: "resource and action required" };
    const room = this.room(workspaceId);
    const persisted = room.persist(event);
    room.broadcast(eventMessage(persisted));
    return { ok: true, seq: persisted.seq || 0, delivered: room.conns.size };
  }

  disconnect(workspaceId, { actorEmail = "", reason = "access_revoked" } = {}) {
    const room = this.room(workspaceId);
    const closed = room.disconnect(actorEmail, reason);
    if (room.conns.size === 0 && room.events.length === 0) this.rooms.delete(workspaceId);
    return { ok: true, closed };
  }

  eventsAfter(workspaceId, after) {
    const room = this.room(workspaceId);
    return { ok: true, latestSeq: room.latestSeq(), events: room.after(after) };
  }
}

function workspaceFromDoId(id) {
  const value = String(id || "");
  return value.startsWith("workspace:") ? value.slice("workspace:".length) : value;
}

function jsonRes(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

// The `env.ROOMS` Durable-Object-namespace shim the product handlers use:
// liveRoomStub(env, ws).fetch("/broadcast"|"/events"). Sockets themselves are
// accepted at the Node server's `upgrade` event, not here, so /connect is a
// no-op (426).
export function createRoomsNamespace(registry) {
  return {
    idFromName: (name) => String(name),
    get: (id) => ({
      // Accept BOTH calling conventions: fetch(Request) — how the product
      // handlers (broadcastRoomEvent / broadcastFocusRoomEvent / disconnect) and
      // the Cloudflare Durable Object call it — and fetch(urlString, init), used
      // by the unit tests. Without the Request branch, `new URL(request)` throws
      // and broadcastRoomEvent's `.catch(() => null)` swallows it, silently
      // dropping every HTTP-triggered room event on the self-host edition
      // (presence still works because it is broadcast in-registry on connect,
      // not through this fetch seam). That gap is invisible to the string-only
      // unit test, so a Request-based test guards it now.
      async fetch(url, init = {}) {
        const isRequest = url && typeof url === "object" && typeof url.url === "string";
        const u = new URL(isRequest ? url.url : url);
        const method = String((isRequest ? url.method : init.method) || "GET").toUpperCase();
        const readBody = async () => {
          if (isRequest) { try { return await url.text(); } catch { return ""; } }
          return typeof init.body === "string" ? init.body : "";
        };
        const workspaceId = workspaceFromDoId(id);
        if (u.pathname === "/broadcast" && method === "POST") {
          const text = await readBody();
          if (text.length > MAX_EVENT_BYTES) return jsonRes(413, { error: "Live-room event too large." });
          let body = {};
          try { body = text ? JSON.parse(text) : {}; } catch { return jsonRes(400, { error: "Invalid live-room event JSON." }); }
          const result = registry.broadcastEvent(workspaceId, body);
          return jsonRes(result.ok ? 202 : 400, result);
        }
        if (u.pathname === "/events" && method === "GET") {
          const after = Number(u.searchParams.get("after")) || 0;
          return jsonRes(200, registry.eventsAfter(workspaceId, after));
        }
        if (u.pathname === "/disconnect" && method === "POST") {
          const text = await readBody();
          if (text.length > MAX_EVENT_BYTES) return jsonRes(413, { error: "Live-room disconnect payload too large." });
          let body = {};
          try { body = text ? JSON.parse(text) : {}; } catch { return jsonRes(400, { error: "Invalid live-room disconnect JSON." }); }
          return jsonRes(202, registry.disconnect(workspaceId, {
            actorEmail: body.actorEmail,
            reason: clean(body.reason || "access_revoked", 80) || "access_revoked"
          }));
        }
        if (u.pathname === "/connect") {
          return jsonRes(426, { error: "WebSocket upgrades are handled by the Node server, not the ROOMS shim." });
        }
        return jsonRes(404, { error: "Not found." });
      }
    })
  };
}
