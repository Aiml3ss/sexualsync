import { jsonResponse, normalizeEmail } from "./_auth.js";
import { focusActivityId, recordActivityEvent, shouldRecordFocusActivity } from "./_activity.js";

const ROOM_INTERNAL_URL = "https://room.sexualsync.internal";

function clean(value, max = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function liveRoomNamespace(env) {
  const rooms = env?.ROOMS;
  if (!rooms || typeof rooms.idFromName !== "function" || typeof rooms.get !== "function") {
    return null;
  }
  return rooms;
}

export function liveRoomStub(env, workspaceId) {
  const rooms = liveRoomNamespace(env);
  const cleanWorkspaceId = clean(workspaceId, 120);
  if (!rooms || !cleanWorkspaceId) return null;
  return rooms.get(rooms.idFromName(`workspace:${cleanWorkspaceId}`));
}

export function liveRoomUnavailableResponse() {
  return jsonResponse(503, {
    error: "Live room is not configured yet.",
    realtime: false
  });
}

export function liveRoomProxyRequest(context, { workspaceId, actorEmail, actorName }) {
  const url = new URL("/connect", ROOM_INTERNAL_URL);
  const sourceUrl = new URL(context.request.url);
  const lastEventSeq = clean(sourceUrl.searchParams.get("lastEventSeq"), 32).replace(/\D/g, "");
  if (lastEventSeq) url.searchParams.set("lastEventSeq", lastEventSeq);
  const headers = new Headers(context.request.headers);
  headers.set("x-sexualsync-workspace-id", clean(workspaceId, 120));
  headers.set("x-sexualsync-actor-email", normalizeEmail(actorEmail));
  headers.set("x-sexualsync-actor-name", clean(actorName, 80));
  if (lastEventSeq) headers.set("x-sexualsync-last-event-seq", lastEventSeq);
  return new Request(url.toString(), {
    method: "GET",
    headers
  });
}

export function broadcastRoomEvent(context, workspaceId, event) {
  const payload = {
    type: "room.event",
    id: clean(event?.id, 120) || crypto.randomUUID(),
    resource: clean(event?.resource, 64),
    action: clean(event?.action, 64),
    entityId: clean(event?.entityId, 120),
    actorEmail: normalizeEmail(event?.actorEmail),
    actorName: clean(event?.actorName, 80),
    at: event?.at || new Date().toISOString(),
    passive: Boolean(event?.passive),
    dedupe: clean(event?.dedupe || event?.coalesce, 40)
  };
  if (!payload.resource || !payload.action) return null;

  const recordTask = recordActivityEvent(context?.env, workspaceId, payload).catch(() => null);
  if (typeof context?.waitUntil === "function") {
    context.waitUntil(recordTask);
  }

  const stub = liveRoomStub(context?.env, workspaceId);
  if (!stub) return recordTask;

  const task = stub.fetch(new Request(`${ROOM_INTERNAL_URL}/broadcast`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  })).catch(() => null);

  if (typeof context?.waitUntil === "function") {
    context.waitUntil(task);
    return Promise.all([recordTask, task]);
  }
  return Promise.all([recordTask, task]);
}

// Broadcast-only fan-out: same live delivery as broadcastRoomEvent, but it does
// NOT record an activity-feed event. For high-frequency / ephemeral / self-
// surfacing resources (chat messages, typing, read receipts) where recording
// every event would flood the metadata activity log. The room stub's /broadcast
// endpoint exists on both runtimes, so this stays Web-standard and edition-safe.
export function broadcastRoomSignal(context, workspaceId, event) {
  const payload = {
    type: "room.event",
    id: clean(event?.id, 120) || crypto.randomUUID(),
    resource: clean(event?.resource, 64),
    action: clean(event?.action, 64),
    entityId: clean(event?.entityId, 120),
    actorEmail: normalizeEmail(event?.actorEmail),
    actorName: clean(event?.actorName, 80),
    at: event?.at || new Date().toISOString(),
    passive: Boolean(event?.passive),
    dedupe: clean(event?.dedupe || event?.coalesce, 40)
  };
  if (!payload.resource || !payload.action) return null;

  const stub = liveRoomStub(context?.env, workspaceId);
  if (!stub) return null;

  const task = stub.fetch(new Request(`${ROOM_INTERNAL_URL}/broadcast`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  })).catch(() => null);

  if (typeof context?.waitUntil === "function") context.waitUntil(task);
  return task;
}

function closeLiveRoomSockets(context, workspaceId, payload) {
  const stub = liveRoomStub(context?.env, workspaceId);
  if (!stub) return null;
  const task = stub.fetch(new Request(`${ROOM_INTERNAL_URL}/disconnect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {})
  })).catch(() => null);
  if (typeof context?.waitUntil === "function") context.waitUntil(task);
  return task;
}

export function closeLiveRoomActor(context, workspaceId, actorEmail, reason = "access_revoked") {
  const email = normalizeEmail(actorEmail);
  if (!email) return null;
  return closeLiveRoomSockets(context, workspaceId, {
    actorEmail: email,
    reason: clean(reason, 80) || "access_revoked"
  });
}

export function closeLiveRoomWorkspace(context, workspaceId, reason = "workspace_closed") {
  return closeLiveRoomSockets(context, workspaceId, {
    reason: clean(reason, 80) || "workspace_closed"
  });
}

export async function broadcastFocusRoomEvent(context, workspaceId, event) {
  const at = event?.at || new Date().toISOString();
  const decision = await shouldRecordFocusActivity(context?.env, workspaceId, {
    ...event,
    action: "focused",
    at
  });
  if (!decision.ok) {
    return {
      activityRecorded: false,
      focusSuppressed: decision.reason
    };
  }

  broadcastRoomEvent(context, workspaceId, {
    ...event,
    id: focusActivityId(event?.actorEmail, at),
    resource: clean(event?.resource, 64),
    action: "focused",
    at,
    passive: true,
    dedupe: "keep-first"
  });
  return {
    activityRecorded: true,
    focusSuppressed: ""
  };
}
