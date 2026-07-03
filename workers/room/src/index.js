const MAX_EVENT_BYTES = 4096;
const HEARTBEAT_TTL_MS = 45 * 1000;
const EVENT_REPLAY_LIMIT = 80;
const EVENT_RETENTION_LIMIT = 240;
// How long a socket may go silent before the reaper closes it. The client
// pings every 25s and the runtime auto-answers without waking us, so any gap
// beyond a few missed pings means the socket is dead (e.g. an iOS background
// kill that never delivered a clean webSocketClose).
const STALE_SOCKET_TTL_MS = HEARTBEAT_TTL_MS * 4;
const REAPER_INTERVAL_MS = 30 * 1000;
// Must serialize byte-for-byte identically to what the client sends. The client
// (web/src/lib/use-live-room.ts) sends JSON.stringify({ type: "heartbeat" }).
const HEARTBEAT_REQUEST = JSON.stringify({ type: "heartbeat" });
const HEARTBEAT_RESPONSE = JSON.stringify({ type: "room.pong" });

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function clean(value, max = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanEmail(value) {
  return clean(value, 160).toLowerCase();
}

function safeEvent(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    type: clean(source.type || "room.event", 48),
    id: clean(source.id, 120) || crypto.randomUUID(),
    resource: clean(source.resource, 64),
    action: clean(source.action, 64),
    entityId: clean(source.entityId, 120),
    actorEmail: cleanEmail(source.actorEmail),
    actorName: clean(source.actorName, 80),
    at: clean(source.at || new Date().toISOString(), 40),
    passive: Boolean(source.passive),
    dedupe: clean(source.dedupe || source.coalesce, 40)
  };
}

function connectionStateFromRequest(request) {
  const url = new URL(request.url);
  return {
    workspaceId: clean(request.headers.get("x-sexualsync-workspace-id"), 120),
    actorEmail: cleanEmail(request.headers.get("x-sexualsync-actor-email")),
    actorName: clean(request.headers.get("x-sexualsync-actor-name"), 80),
    lastEventSeq: normalizeSeq(request.headers.get("x-sexualsync-last-event-seq") || url.searchParams.get("lastEventSeq")),
    joinedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
}

function presencePayload(state, status) {
  return {
    type: "room.presence",
    status,
    actorEmail: state.actorEmail,
    actorName: state.actorName,
    at: new Date().toISOString()
  };
}

function normalizeSeq(value) {
  const seq = Number.parseInt(String(value || "0"), 10);
  return Number.isFinite(seq) && seq > 0 ? seq : 0;
}

function cursorRows(cursor) {
  if (!cursor) return [];
  if (typeof cursor.toArray === "function") return cursor.toArray();
  return Array.from(cursor);
}

function rowEvent(row) {
  if (!row) return null;
  let payload = {};
  try { payload = JSON.parse(row.payload || "{}"); }
  catch { payload = {}; }
  const seq = normalizeSeq(row.seq);
  return {
    ...payload,
    seq,
    id: clean(payload.id || row.id, 120),
    resource: clean(payload.resource || row.resource, 64),
    action: clean(payload.action || row.action, 64),
    entityId: clean(payload.entityId || row.entity_id, 120),
    actorEmail: cleanEmail(payload.actorEmail || row.actor_email),
    actorName: clean(payload.actorName || row.actor_name, 80),
    at: clean(payload.at || row.at, 40),
    passive: Boolean(payload.passive)
  };
}

function eventMessage(event) {
  return {
    type: "room.event",
    seq: event.seq,
    event: {
      ...event,
      seq: event.seq
    }
  };
}

export class RoomDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.roomEventsReady = false;
  }

  ensureRoomEventStore() {
    if (this.roomEventsReady) return true;
    const sql = this.state?.storage?.sql;
    if (!sql || typeof sql.exec !== "function") return false;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS room_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        resource TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_id TEXT NOT NULL DEFAULT '',
        actor_email TEXT NOT NULL DEFAULT '',
        actor_name TEXT NOT NULL DEFAULT '',
        at TEXT NOT NULL,
        passive INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    sql.exec("CREATE INDEX IF NOT EXISTS room_events_seq_idx ON room_events (seq DESC);");
    sql.exec("CREATE INDEX IF NOT EXISTS room_events_id_idx ON room_events (id);");
    this.roomEventsReady = true;
    return true;
  }

  latestEventSeq() {
    if (!this.ensureRoomEventStore()) return 0;
    const rows = cursorRows(this.state.storage.sql.exec(
      "SELECT seq FROM room_events ORDER BY seq DESC LIMIT 1"
    ));
    return normalizeSeq(rows[0]?.seq);
  }

  existingEventById(id) {
    if (!id || !this.ensureRoomEventStore()) return null;
    const rows = cursorRows(this.state.storage.sql.exec(
      "SELECT seq, id, resource, action, entity_id, actor_email, actor_name, at, passive, payload FROM room_events WHERE id = ? ORDER BY seq DESC LIMIT 1",
      id
    ));
    return rowEvent(rows[0]);
  }

  persistRoomEvent(event) {
    if (!this.ensureRoomEventStore()) return event;
    if (event.dedupe === "keep-first") {
      const existing = this.existingEventById(event.id);
      if (existing) return existing;
    }

    const payload = JSON.stringify(event);
    const rows = cursorRows(this.state.storage.sql.exec(
      `INSERT INTO room_events
        (id, resource, action, entity_id, actor_email, actor_name, at, passive, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING seq`,
      event.id,
      event.resource,
      event.action,
      event.entityId,
      event.actorEmail,
      event.actorName,
      event.at,
      event.passive ? 1 : 0,
      payload
    ));
    const persisted = { ...event, seq: normalizeSeq(rows[0]?.seq) };
    this.pruneRoomEvents();
    return persisted;
  }

  pruneRoomEvents() {
    if (!this.ensureRoomEventStore()) return;
    this.state.storage.sql.exec(
      `DELETE FROM room_events
       WHERE seq NOT IN (
         SELECT seq FROM room_events ORDER BY seq DESC LIMIT ?
       )`,
      EVENT_RETENTION_LIMIT
    );
  }

  readEventsAfter(seq) {
    const after = normalizeSeq(seq);
    if (!after || !this.ensureRoomEventStore()) return [];
    const rows = cursorRows(this.state.storage.sql.exec(
      `SELECT seq, id, resource, action, entity_id, actor_email, actor_name, at, passive, payload
       FROM room_events
       WHERE seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
      after,
      EVENT_REPLAY_LIMIT
    ));
    return rows.map(rowEvent).filter(Boolean);
  }

  replayMissedEvents(ws, state) {
    const missed = this.readEventsAfter(state.lastEventSeq);
    for (const event of missed) {
      try { ws.send(JSON.stringify(eventMessage(event))); } catch {}
    }
  }

  // Freshness for a socket without writing storage on every ping. The runtime
  // records the timestamp of the last auto-answered heartbeat; prefer it, and
  // fall back to the attachment's lastSeenAt/joinedAt for sockets that have not
  // pinged yet (or runtimes that lack the auto-response timestamp API).
  lastSeenMs(ws, attachment) {
    let best = 0;
    try {
      const ts = this.state.getWebSocketAutoResponseTimestamp(ws);
      const ms = ts instanceof Date ? ts.getTime() : new Date(ts || 0).getTime();
      if (Number.isFinite(ms)) best = ms;
    } catch {}
    const attached = attachment || (() => {
      try { return ws.deserializeAttachment() || {}; } catch { return {}; }
    })();
    const fallback = new Date(attached.lastSeenAt || attached.joinedAt || 0).getTime();
    if (Number.isFinite(fallback) && fallback > best) best = fallback;
    return best;
  }

  // True if some OTHER live socket is already bound to this actor. Used to dedup
  // presence so multiple tabs / reconnect flaps don't churn online<->offline.
  hasOtherSocketForActor(actorEmail, except) {
    if (!actorEmail) return false;
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      let attachment = {};
      try { attachment = ws.deserializeAttachment() || {}; } catch {}
      if (attachment.actorEmail === actorEmail) return true;
    }
    return false;
  }

  // The distinct actors with a live socket right now (excluding `except`). Sent
  // in room.hello so a connecting client learns who is ALREADY present — plain
  // presence events only cover online/offline changes after the connect.
  connectedActorEmails(except) {
    const emails = new Set();
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      let attachment = {};
      try { attachment = ws.deserializeAttachment() || {}; } catch {}
      if (attachment.actorEmail) emails.add(attachment.actorEmail);
    }
    return [...emails];
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/connect") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return json(426, { error: "WebSocket upgrade required." });
      }
      const connectionState = connectionStateFromRequest(request);
      if (!connectionState.workspaceId || !connectionState.actorEmail) {
        return json(400, { error: "Missing live-room identity." });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      // Let the runtime answer client heartbeats while the DO is hibernated, so
      // the steady stream of pings does not keep the object awake or thrash a
      // storage write per ping. webSocketMessage keeps a heartbeat branch as a
      // fallback for any ping that still reaches us.
      try {
        this.state.setWebSocketAutoResponse(
          new WebSocketRequestResponsePair(HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE)
        );
      } catch {}
      // Dedup presence: only announce "online" if this actor isn't already
      // represented by another live socket (multi-tab / reconnect flaps).
      const announceOnline = !this.hasOtherSocketForActor(connectionState.actorEmail, server);
      server.serializeAttachment(connectionState);
      server.send(JSON.stringify({
        type: "room.hello",
        workspaceId: connectionState.workspaceId,
        latestSeq: this.latestEventSeq(),
        online: this.connectedActorEmails(server),
        at: new Date().toISOString()
      }));
      this.replayMissedEvents(server, connectionState);
      if (announceOnline) {
        this.broadcast(presencePayload(connectionState, "online"), server);
      }
      // Arm the dead-socket reaper. Auto-answered heartbeats never wake us, so a
      // background-killed client (no clean webSocketClose) would otherwise stay
      // "online" forever; the alarm sweeps and emits "offline" for it.
      try { await this.state.storage.setAlarm(Date.now() + REAPER_INTERVAL_MS); } catch {}
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      const text = await request.text();
      if (text.length > MAX_EVENT_BYTES) {
        return json(413, { error: "Live-room event too large." });
      }
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; }
      catch { return json(400, { error: "Invalid live-room event JSON." }); }
      const event = safeEvent(payload);
      if (!event.resource || !event.action) {
        return json(400, { error: "Live-room event needs resource and action." });
      }
      const persisted = this.persistRoomEvent(event);
      this.broadcast(eventMessage(persisted));
      return json(202, {
        ok: true,
        seq: persisted.seq || 0,
        delivered: this.state.getWebSockets().length
      });
    }

    if (url.pathname === "/disconnect" && request.method === "POST") {
      const text = await request.text();
      if (text.length > MAX_EVENT_BYTES) {
        return json(413, { error: "Live-room disconnect payload too large." });
      }
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; }
      catch { return json(400, { error: "Invalid live-room disconnect JSON." }); }
      const actorEmail = cleanEmail(payload.actorEmail);
      const reason = clean(payload.reason || "access_revoked", 80) || "access_revoked";
      const closed = this.disconnectSockets(actorEmail, reason);
      return json(202, { ok: true, closed });
    }

    if (url.pathname === "/events" && request.method === "GET") {
      const after = normalizeSeq(url.searchParams.get("after"));
      return json(200, {
        ok: true,
        latestSeq: this.latestEventSeq(),
        events: this.readEventsAfter(after)
      });
    }

    return json(404, { error: "Not found." });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") return;
    let payload = {};
    try { payload = JSON.parse(message); }
    catch { return; }

    const state = ws.deserializeAttachment() || {};
    if (payload?.type === "heartbeat") {
      // Fallback path only. Heartbeats are normally answered by the runtime via
      // setWebSocketAutoResponse without waking the DO, and freshness is read
      // from getWebSocketAutoResponseTimestamp (see lastSeenMs). If a ping still
      // reaches us, refresh the attachment and reply so the client stays happy.
      const next = { ...state, lastSeenAt: new Date().toISOString() };
      ws.serializeAttachment(next);
      ws.send(JSON.stringify({ type: "room.pong", at: next.lastSeenAt }));
      return;
    }

    if (payload?.type === "presence") {
      const next = { ...state, lastSeenAt: new Date().toISOString() };
      ws.serializeAttachment(next);
      this.broadcast(presencePayload(next, "active"), ws);
    }
  }

  async webSocketClose(ws) {
    const state = ws.deserializeAttachment() || {};
    // Dedup presence: only announce "offline" if no other live socket still
    // represents this actor (other tabs / an in-flight reconnect). Exclude this
    // socket from the scan since it is closing.
    if (state.actorEmail && !this.hasOtherSocketForActor(state.actorEmail, ws)) {
      this.broadcast(presencePayload(state, "offline"), ws);
    }
  }

  // Dead-socket reaper. Auto-answered heartbeats never wake the DO, and iOS
  // background kills do not deliver a clean webSocketClose, so without this a
  // dead socket would stay "online" forever and suppress real-event pushes.
  // Runs on a timer: close anything past the TTL, announce "offline" once per
  // actor that has no surviving socket, then re-arm while sockets remain.
  async alarm() {
    const now = Date.now();
    const stale = [];
    for (const ws of this.state.getWebSockets()) {
      let attachment = {};
      try { attachment = ws.deserializeAttachment() || {}; } catch {}
      const lastSeen = this.lastSeenMs(ws, attachment);
      if (now - lastSeen > STALE_SOCKET_TTL_MS) {
        stale.push({ ws, actorEmail: attachment.actorEmail, state: attachment });
      }
    }

    // Close first, then decide presence against the survivors so a dead socket
    // does not count itself as "still online" and multiple dead sockets for the
    // same actor only emit one "offline".
    for (const entry of stale) {
      try { entry.ws.close(1001, "stale"); } catch {}
    }

    const announced = new Set();
    for (const entry of stale) {
      const actorEmail = entry.actorEmail;
      if (!actorEmail || announced.has(actorEmail)) continue;
      announced.add(actorEmail);
      if (!this.hasOtherSocketForActor(actorEmail, null)) {
        this.broadcast(presencePayload(entry.state, "offline"));
      }
    }

    // Keep sweeping while anyone is connected; otherwise let the DO hibernate.
    if (this.state.getWebSockets().length > 0) {
      try { await this.state.storage.setAlarm(now + REAPER_INTERVAL_MS); } catch {}
    }
  }

  broadcast(message, except = null) {
    const body = JSON.stringify(message);
    const now = Date.now();
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      const attachment = ws.deserializeAttachment() || {};
      const lastSeen = this.lastSeenMs(ws, attachment);
      if (Number.isFinite(lastSeen) && now - lastSeen > STALE_SOCKET_TTL_MS) {
        try { ws.close(1001, "stale"); } catch {}
        continue;
      }
      try { ws.send(body); } catch {}
    }
  }

  disconnectSockets(actorEmail = "", reason = "access_revoked") {
    const closedStates = [];
    for (const ws of this.state.getWebSockets()) {
      let attachment = {};
      try { attachment = ws.deserializeAttachment() || {}; } catch {}
      if (actorEmail && attachment.actorEmail !== actorEmail) continue;
      closedStates.push(attachment);
      try { ws.close(1008, reason); } catch {}
    }
    const announced = new Set();
    for (const state of closedStates) {
      const email = state.actorEmail;
      if (!email || announced.has(email)) continue;
      announced.add(email);
      this.broadcast(presencePayload(state, "offline"));
    }
    return closedStates.length;
  }
}

// Compare-and-set coordinator for contended KV records. One instance per
// logical record (addressed via idFromName("state:<fullKey>") for a single key
// or idFromName("record:<name>") for a multi-key record). Because a Durable
// Object runs single-threaded, the version check + KV write in /state/cas is
// atomic, which gives the read-modify-write callers true cross-isolate
// optimistic concurrency that plain KV cannot (KV has no compare-and-swap). KV
// remains the durable store; this object holds only a monotonic version counter.
export class StateStoreDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async version() {
    return Number(await this.state.storage.get("version")) || 0;
  }

  async readKv(key) {
    if (!this.env?.STORE) return null;
    try { return await this.env.STORE.get(key, "json"); }
    catch { return null; }
  }

  // Accepts a single `key` or a `keys` array; returns the keys to operate on.
  keysFromBody(body) {
    if (Array.isArray(body.keys)) {
      return body.keys.map((k) => clean(k, 320)).filter(Boolean);
    }
    const single = clean(body.key, 320);
    return single ? [single] : [];
  }

  async fetch(request) {
    const url = new URL(request.url);
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const keys = this.keysFromBody(body);
    if (!keys.length) return json(400, { error: "key or keys required." });
    const singleMode = !Array.isArray(body.keys);

    if (url.pathname === "/state/read" && request.method === "POST") {
      const version = await this.version();
      if (singleMode) {
        // Read-your-writes: Cloudflare KV is eventually consistent, so prefer the
        // strongly-consistent value this DO stored on the last single-key CAS.
        // Fall back to KV for records written before this existed (no `kvval` yet)
        // or via the no-DO local path.
        const stored = await this.state.storage.get("kvval");
        return json(200, { ok: true, version, value: stored !== undefined ? stored : await this.readKv(keys[0]) });
      }
      const values = {};
      for (const k of keys) values[k] = await this.readKv(k);
      return json(200, { ok: true, version, values });
    }

    if (url.pathname === "/state/cas" && request.method === "POST") {
      const expectedVersion = Number(body.expectedVersion);
      if (!Number.isFinite(expectedVersion)) {
        return json(400, { error: "expectedVersion required." });
      }
      if (!this.env?.STORE) return json(503, { error: "STORE binding missing." });

      // Map of key -> value to write. Single mode writes {key: value}; multi
      // mode writes only the keys present in `values`.
      const writes = singleMode
        ? { [keys[0]]: body.value ?? null }
        : (body.values && typeof body.values === "object" ? body.values : {});

      // Crash-safety: bump and persist the version BEFORE writing KV.
      //
      // The durable record is the set of KV keys; this DO holds only the version
      // counter, and readers (see functions/api/_state.js readKey/readRecord)
      // read each KV key directly, bypassing this object. So the keys cannot be
      // collapsed into one DO-held value without diverging from what readers see
      // — they are genuinely independent records and must each be put().
      //
      // The old order (compare -> N puts -> bump version) tore on eviction: a
      // crash partway through the puts left KV partially written AND the version
      // unchanged, so the next writer passed its CAS against the stale version
      // and composed on top of half-applied data, silently clobbering.
      //
      // Persisting the bumped version first closes that hole: if we crash during
      // the puts, the version has already advanced, so any writer still holding
      // the old expectedVersion is rejected and forced to re-read the live KV
      // values and recompute its transform (mutateKey/mutateRecord retry on
      // conflict). The partially written record becomes the new base and the
      // transform reapplies cleanly instead of overwriting it. blockConcurrency-
      // While serializes the whole section so no other /state/cas interleaves.
      const result = await this.state.blockConcurrencyWhile(async () => {
        const current = await this.version();
        if (current !== expectedVersion) {
          return { ok: false, version: current };
        }
        const next = current + 1;
        await this.state.storage.put("version", next);
        // Defense in depth: confirm the version we just persisted is the one we
        // hold before mutating KV. Under blockConcurrencyWhile this always holds;
        // bail without writing if storage ever surprises us so we never write KV
        // under a version another writer might already own.
        const persisted = await this.version();
        if (persisted !== next) {
          return { ok: false, version: persisted };
        }
        for (const [k, v] of Object.entries(writes)) {
          await this.env.STORE.put(k, JSON.stringify(v ?? null));
        }
        // Mirror the single-key value into DO storage (strongly consistent) so
        // /state/read can serve a just-written value before KV propagates. Single
        // -key only — multi-key records span independent KV keys (see above) and
        // keep reading KV. Stored as the same encoded envelope KV holds.
        if (singleMode) await this.state.storage.put("kvval", writes[keys[0]] ?? null);
        return { ok: true, version: next };
      });
      return json(200, result);
    }

    return json(404, { error: "Not found." });
  }
}

export default {
  async fetch() {
    return json(404, { error: "Use the Pages /api/room/socket proxy." });
  },

  async scheduled(_controller, env, ctx) {
    const token = clean(env.PILE_REMINDER_RUNNER_TOKEN, 240);
    if (!token) return;
    const url = clean(env.PILE_REMINDER_RUNNER_URL || "https://sexualsync.io/api/pile-reminders", 240);
    ctx.waitUntil(fetch(url, {
      method: "POST",
      headers: {
        "x-sexualsync-reminder-token": token
      }
    }).catch(() => null));
  }
};
