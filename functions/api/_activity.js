import { normalizeEmail } from "./_auth.js";
import { getStore } from "./_kv.js";
import { mutateKey } from "./_state.js";

export const ACTIVITY_STORE_NAME = "sexualsync-activity";
const MAX_EVENTS = 80;
const MAX_READERS = 20;
const MAX_DISMISSED = 240;
const ACTIVITY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const FOCUS_COOLDOWN_MS = 36 * 60 * 60 * 1000;
const FOCUS_ENTITY_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

const RESOURCE_LABELS = {
  "request-board": "Sexboard",
  "fantasy-backlog": "Inspiration",
  shelf: "Shelf",
  vault: "Vault",
  pile: "Pile",
  "blind-reveals": "Blind Reveal"
};

const ACTION_LABELS = {
  "request-board": {
    created: "Ask drafted",
    sent: "New Ask landed",
    reviewed: "Ask reviewed",
    counter_accepted: "Counter accepted",
    revoked: "Ask taken back",
    archive: "Ask archived",
    restore: "Ask restored",
    on_deck: "Ask moved on deck",
    completed: "Ask completed",
    expire: "Ask expired",
    updated: "Sexboard updated"
  },
  "fantasy-backlog": {
    created: "New Kink shared",
    focused: "",
    updated: "Idea updated",
    restored: "Idea restored",
    deleted: "Idea archived"
  },
  shelf: {
    added: "Shelf updated",
    focused: "",
    revealed: "Opened a Shelf save",
    reacted: "Shelf reaction landed",
    updated: "Shelf updated",
    deleted: "Shelf item removed"
  },
  vault: {
    added: "Vault clip added",
    title_updated: "Vault title updated",
    moment: "Vault moment saved",
    moment_title_updated: "Vault moment title updated",
    moment_deleted: "Vault moment removed",
    reacted: "Vault reaction landed",
    commented: "Vault comment added",
    deleted: "Vault clip removed"
  },
  pile: {
    started: "Pile started",
    ended: "Pile ended",
    declined: "Pile declined",
    locked: "Pile locked in",
    removed: "Pile lock removed",
    time_updated: "Pile time changed",
    dropped: "Pile changed",
    undropped: "Pile changed"
  },
  "blind-reveals": {
    created: "Blind Reveal started",
    submitted: "Answer locked",
    revealed: "Blind Reveal opened",
    archived: "Blind Reveal closed",
    promoted: "Saved to Inspiration"
  }
};

function clean(value, max = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanToken(value, max = 64) {
  return clean(value, max).replace(/[^a-z0-9:_-]/gi, "");
}

function firstName(value) {
  return clean(value, 80).split(/\s+/)[0] || "Your partner";
}

function activityDayStamp(value = new Date()) {
  return new Date(value).toISOString().slice(0, 10);
}

function activityStore(env) {
  return getStore(env, ACTIVITY_STORE_NAME);
}

function eventsKey(workspaceId) {
  return `events:${clean(workspaceId, 120)}`;
}

function readKey(workspaceId) {
  return `read:${clean(workspaceId, 120)}`;
}

function labelFor(resource, action, actorName = "") {
  if (action === "focused") {
    const actor = firstName(actorName);
    if (resource === "fantasy-backlog") return `This kink got ${actor} thinking dirty.`;
    if (resource === "shelf") return `${actor} came back for another taste.`;
  }
  return ACTION_LABELS[resource]?.[action] || `${RESOURCE_LABELS[resource] || "Activity"} updated`;
}

function normalizeIso(value) {
  const at = new Date(value || Date.now());
  return Number.isFinite(at.getTime()) ? at.toISOString() : new Date().toISOString();
}

function publicEvent(event) {
  const resource = cleanToken(event?.resource, 64);
  const action = cleanToken(event?.action, 64);
  if (!RESOURCE_LABELS[resource] || !action) return null;

  return {
    id: clean(event?.id, 120) || crypto.randomUUID(),
    workspaceId: clean(event?.workspaceId, 120),
    resource,
    resourceLabel: RESOURCE_LABELS[resource],
    action,
    label: labelFor(resource, action, event?.actorName),
    entityId: clean(event?.entityId, 120),
    actorEmail: normalizeEmail(event?.actorEmail),
    actorName: clean(event?.actorName, 80) || "Partner",
    at: normalizeIso(event?.at),
    passive: Boolean(event?.passive)
  };
}

async function readRawEvents(env, workspaceId) {
  try {
    const value = await activityStore(env).get(eventsKey(workspaceId), { type: "json" });
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function writeRawEvents(env, workspaceId, events) {
  await activityStore(env).setJSON(eventsKey(workspaceId), retainedActivityEvents(events).slice(0, MAX_EVENTS));
}

async function readState(env, workspaceId) {
  try {
    const value = await activityStore(env).get(readKey(workspaceId), { type: "json" });
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function writeState(env, workspaceId, state) {
  const entries = Object.entries(state || {}).slice(-MAX_READERS);
  await activityStore(env).setJSON(readKey(workspaceId), Object.fromEntries(entries));
}

function readMarker(state, email, resource) {
  const reader = state?.[normalizeEmail(email)] || {};
  const all = clean(reader.all, 40);
  const scoped = clean(reader.resources?.[resource], 40);
  return scoped > all ? scoped : all;
}

function cleanDismissedIds(ids) {
  const source = Array.isArray(ids) ? ids : [];
  return Array.from(new Set(source.map((id) => clean(id, 120)).filter(Boolean)));
}

function dismissedIdsFor(state, email) {
  const reader = state?.[normalizeEmail(email)] || {};
  return new Set(cleanDismissedIds(reader.dismissed));
}

function mutableReader(state, email) {
  const existing = state?.[normalizeEmail(email)];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return {
      all: clean(existing.all, 40),
      resources: existing.resources && typeof existing.resources === "object" && !Array.isArray(existing.resources)
        ? existing.resources
        : {},
      dismissed: cleanDismissedIds(existing.dismissed).slice(-MAX_DISMISSED)
    };
  }
  return { all: "", resources: {}, dismissed: [] };
}

function publicReaderState(state, email) {
  const reader = mutableReader(state || {}, email);
  return {
    all: reader.all,
    resources: reader.resources || {},
    dismissed: cleanDismissedIds(reader.dismissed).slice(-MAX_DISMISSED)
  };
}

function markerForEvents(events, resource = "") {
  const scopedResource = cleanToken(resource, 64);
  const latest = events
    .map(publicEvent)
    .filter(Boolean)
    .filter((item) => !scopedResource || item.resource === scopedResource)
    .reduce((current, item) => item.at > current ? item.at : current, "");
  const now = new Date().toISOString();
  return latest > now ? latest : now;
}

function safeMs(value) {
  const ms = new Date(value || "").getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function retainedActivityEvents(events, nowMs = Date.now()) {
  const cutoff = nowMs - ACTIVITY_RETENTION_MS;
  return (Array.isArray(events) ? events : []).filter((event) => {
    const atMs = safeMs(event?.at);
    return atMs && atMs >= cutoff;
  });
}

function isRecent(existingAt, nowMs, windowMs) {
  const existingMs = safeMs(existingAt);
  if (!existingMs || !Number.isFinite(nowMs)) return false;
  return existingMs > nowMs - windowMs;
}

function withUnread(item, state, actorEmail) {
  const currentActor = normalizeEmail(actorEmail);
  const fromSelf = currentActor && normalizeEmail(item.actorEmail) === currentActor;
  const marker = readMarker(state, currentActor, item.resource);
  return {
    ...item,
    unread: !item.passive && !fromSelf && (!marker || item.at > marker)
  };
}

export function focusActivityId(actorEmail, now = new Date()) {
  return [
    "focus",
    normalizeEmail(actorEmail),
    activityDayStamp(now)
  ].join(":");
}

export async function shouldRecordFocusActivity(env, workspaceId, event, options = {}) {
  const item = publicEvent({
    ...event,
    workspaceId,
    action: "focused",
    passive: true
  });
  if (!item) return { ok: false, reason: "invalid" };

  const actorEmail = normalizeEmail(item.actorEmail);
  if (!actorEmail || !item.entityId) return { ok: false, reason: "invalid" };

  const nowMs = safeMs(item.at) || Date.now();
  const actorCooldownMs = Number(options.actorCooldownMs || FOCUS_COOLDOWN_MS);
  const entityCooldownMs = Number(options.entityCooldownMs || FOCUS_ENTITY_COOLDOWN_MS);
  const current = retainedActivityEvents(await readRawEvents(env, workspaceId))
    .map(publicEvent)
    .filter(Boolean);

  const actorRecent = current.find((entry) => (
    entry.action === "focused"
      && normalizeEmail(entry.actorEmail) === actorEmail
      && isRecent(entry.at, nowMs, actorCooldownMs)
  ));
  if (actorRecent) return { ok: false, reason: "actor-cooldown", event: actorRecent };

  const entityRecent = current.find((entry) => (
    entry.action === "focused"
      && entry.resource === item.resource
      && entry.entityId === item.entityId
      && normalizeEmail(entry.actorEmail) === actorEmail
      && isRecent(entry.at, nowMs, entityCooldownMs)
  ));
  if (entityRecent) return { ok: false, reason: "entity-cooldown", event: entityRecent };

  return { ok: true, event: item };
}

export async function recordActivityEvent(env, workspaceId, event) {
  const dedupe = cleanToken(event?.dedupe || event?.coalesce, 40);
  const item = publicEvent({
    ...event,
    workspaceId
  });
  if (!item) return null;

  // Route through mutateKey so concurrent broadcasts (fired via waitUntil) can't
  // lose an event to a read-then-write race: each retry re-applies this synchronous
  // transform onto the freshest value. The list is kept pre-sorted newest-first,
  // so we splice the new item into place and cap by length instead of re-sorting
  // every write. Returns the existing entry on a keep-first dedupe hit (no write),
  // else the recorded item.
  return mutateKey(env, ACTIVITY_STORE_NAME, eventsKey(workspaceId), (raw) => {
    const current = retainedActivityEvents(raw)
      .map(publicEvent)
      .filter(Boolean)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const existing = current.find((entry) => entry.id === item.id);
    if (existing && dedupe === "keep-first") {
      return { value: current.slice(0, MAX_EVENTS), result: existing, write: false };
    }
    const next = current.filter((entry) => entry.id !== item.id);
    // Insert newest-first: splice in ahead of the first entry that is not strictly
    // newer (older-or-equal `at`). On an `at` tie this keeps the new item ahead of
    // its equals — matching the prior `[item, ...].sort()` stable ordering.
    const at = String(item.at);
    let index = next.findIndex((entry) => String(entry.at).localeCompare(at) <= 0);
    if (index < 0) index = next.length;
    next.splice(index, 0, item);
    return { value: next.slice(0, MAX_EVENTS), result: item };
  });
}

export async function readActivity(env, workspaceId, actorEmail) {
  const [rawEvents, state] = await Promise.all([
    readRawEvents(env, workspaceId),
    readState(env, workspaceId)
  ]);
  const events = retainedActivityEvents(rawEvents);
  if (events.length !== rawEvents.length) {
    await writeRawEvents(env, workspaceId, events).catch(() => {});
  }
  const dismissed = dismissedIdsFor(state, actorEmail);
  const items = events
    .map(publicEvent)
    .filter(Boolean)
    .filter((item) => !dismissed.has(item.id))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, MAX_EVENTS)
    .map((item) => withUnread(item, state, actorEmail));

  const unreadByResource = {};
  let unreadTotal = 0;
  for (const item of items) {
    if (!item.unread) continue;
    unreadTotal += 1;
    unreadByResource[item.resource] = (unreadByResource[item.resource] || 0) + 1;
  }

  return {
    workspaceId: clean(workspaceId, 120),
    items,
    unreadTotal,
    unreadByResource,
    readState: publicReaderState(state, actorEmail)
  };
}

export async function markActivityRead(env, workspaceId, actorEmail, resource = "") {
  const email = normalizeEmail(actorEmail);
  const scopedResource = cleanToken(resource, 64);
  const validScopedResource = scopedResource && RESOURCE_LABELS[scopedResource] ? scopedResource : "";
  const [state, events] = await Promise.all([
    readState(env, workspaceId),
    readRawEvents(env, workspaceId)
  ]);
  const reader = mutableReader(state, email);
  const marker = markerForEvents(events, validScopedResource);

  if (validScopedResource) {
    reader.resources = {
      ...(reader.resources || {}),
      [validScopedResource]: marker
    };
  } else {
    reader.all = marker;
  }

  state[email] = reader;
  await writeState(env, workspaceId, state);
  return readActivity(env, workspaceId, actorEmail);
}

export async function dismissActivityItems(env, workspaceId, actorEmail, ids = []) {
  const email = normalizeEmail(actorEmail);
  const dismissedIds = cleanDismissedIds(ids).slice(0, 40);
  if (!dismissedIds.length) {
    return readActivity(env, workspaceId, actorEmail);
  }

  const state = await readState(env, workspaceId);
  const reader = mutableReader(state, email);
  reader.dismissed = cleanDismissedIds([
    ...(reader.dismissed || []),
    ...dismissedIds
  ]).slice(-MAX_DISMISSED);

  state[email] = reader;
  await writeState(env, workspaceId, state);
  return readActivity(env, workspaceId, actorEmail);
}

// Empty the activity box for one reader: mark everything read AND dismiss every
// currently-retained event (not just the visible rows). The per-item dismiss is
// capped at 40 and the feed only renders MAX_ACTIVITY_ROWS, so "Mark read" alone
// left older rows behind — this clears them all in one shot. Per-reader only:
// the partner's own feed and the underlying events are untouched, and new
// partner activity repopulates the box afterwards.
export async function clearActivity(env, workspaceId, actorEmail) {
  const email = normalizeEmail(actorEmail);
  const [state, events] = await Promise.all([
    readState(env, workspaceId),
    readRawEvents(env, workspaceId)
  ]);
  const reader = mutableReader(state, email);
  reader.all = markerForEvents(events, "");
  const currentIds = retainedActivityEvents(events)
    .map(publicEvent)
    .filter(Boolean)
    .map((item) => item.id);
  reader.dismissed = cleanDismissedIds([
    ...(reader.dismissed || []),
    ...currentIds
  ]).slice(-MAX_DISMISSED);

  state[email] = reader;
  await writeState(env, workspaceId, state);
  return readActivity(env, workspaceId, actorEmail);
}
