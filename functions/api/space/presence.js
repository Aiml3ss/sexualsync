// v2 · Sprint C · Presence — partner-last-seen + days-in-sync streak.
// Called on every dashboard open; records caller's last-seen as a side-effect.

import { getStore, storageKeyCandidates } from "../_kv.js";
import { decodeStoredJson } from "../_encrypted_store.js";
import { mutateKey } from "../_state.js";
import {
  getAuthenticatedIdentity,
  jsonResponse,
  normalizeEmail
} from "../_auth.js";
import {
  authorizeWorkspaceAccess,
  workspaceIdFromRequest
} from "../_workspaces.js";

const STORE_NAME = "sexualsync-presence";
const HISTORY_DAYS = 60;
const SEEN_FRESH_MS = 60_000;

function presenceStore(env) { return getStore(env, STORE_NAME); }
function presenceKey(workspaceId) { return `presence:${workspaceId}`; }

function emptyPresence() {
  return { byEmail: {}, opens: {} };
}

function normalizePresenceRecord(value) {
  if (!value || typeof value !== "object") return emptyPresence();
  const byEmail = {};
  const opens = {};
  for (const [email, seen] of Object.entries(value.byEmail || {})) {
    const normalized = normalizeEmail(email);
    if (normalized && typeof seen === "string" && seen) byEmail[normalized] = seen;
  }
  for (const [email, days] of Object.entries(value.opens || {})) {
    const normalized = normalizeEmail(email);
    if (!normalized || !days || typeof days !== "object") continue;
    opens[normalized] = {};
    for (const [dk, active] of Object.entries(days)) {
      if (active) opens[normalized][dk] = true;
    }
  }
  return { byEmail, opens };
}

function newerSeen(a, b) {
  if (!a) return b || "";
  if (!b) return a;
  const at = Date.parse(a);
  const bt = Date.parse(b);
  if (Number.isFinite(at) && Number.isFinite(bt)) return bt > at ? b : a;
  return b || a;
}

function mergePresenceRecords(...records) {
  const merged = emptyPresence();
  for (const record of records) {
    const data = normalizePresenceRecord(record);
    for (const [email, seen] of Object.entries(data.byEmail)) {
      merged.byEmail[email] = newerSeen(merged.byEmail[email], seen);
    }
    for (const [email, days] of Object.entries(data.opens)) {
      merged.opens[email] = merged.opens[email] || {};
      for (const [dk, active] of Object.entries(days)) {
        if (active) merged.opens[email][dk] = true;
      }
    }
  }
  trimHistory(merged.opens);
  return merged;
}

async function readLegacyPresenceAliases(env, workspaceId) {
  const candidates = storageKeyCandidates(STORE_NAME, presenceKey(workspaceId)).slice(1);
  let merged = emptyPresence();
  for (const storageKey of candidates) {
    try {
      const raw = await env?.STORE?.get(storageKey, "json");
      if (raw === null || raw === undefined) continue;
      merged = mergePresenceRecords(merged, await decodeStoredJson(env, storageKey, raw));
    } catch {}
  }
  return merged;
}

export async function readPresence(env, workspaceId) {
  try {
    const raw = await presenceStore(env).get(presenceKey(workspaceId), { type: "json" });
    return mergePresenceRecords(await readLegacyPresenceAliases(env, workspaceId), raw);
  } catch { return emptyPresence(); }
}
export async function writePresence(env, workspaceId, data) {
  await presenceStore(env).setJSON(presenceKey(workspaceId), data);
}

function dayKey(iso) {
  const d = new Date(iso || Date.now());
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}

function trimHistory(opens) {
  // opens is { [email]: { [dayKey]: true } }; keep last 60 days only.
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - HISTORY_DAYS);
  const cutoffKey = dayKey(cutoff.toISOString());
  Object.keys(opens).forEach((email) => {
    const days = opens[email] || {};
    Object.keys(days).forEach((dk) => { if (dk < cutoffKey) delete days[dk]; });
    opens[email] = days;
  });
}

function computeStreak(opens, emails) {
  // Days where every email in `emails` has an "open" entry, counted back from today.
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < HISTORY_DAYS; i++) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const dk = dayKey(d.toISOString());
    const allActive = emails.every((e) => opens[e] && opens[e][dk]);
    if (allActive) streak++;
    else break;
  }
  return streak;
}

export async function readPresenceResponse(env, ws, actorEmail, { stamp = true } = {}) {
  const now = new Date().toISOString();
  // Stamp this caller as seen via an atomic read-modify-write. Two concurrent
  // opens (even from different isolates) compose instead of clobbering, so no
  // last-seen / open-day stamp is lost — the "days in sync" streak and the
  // active-recipient push suppression in _notification_policy.js both read this
  // record and depend on every open being recorded. The transform is synchronous
  // and idempotent (it may run more than once on a CAS retry). `result` is the
  // merged post-write view we render the response from.
  //
  // Freshness short-circuit: this runs on every dashboard/sexboard GET, so an
  // unconditional write would hammer KV. When the caller's last-seen is already
  // <60s old AND today's open is already recorded, the write is a no-op for the
  // semantics we keep (last-seen resolution + per-day open for the streak), so
  // we skip it (write:false). We still return an explicit merged `result` so the
  // response is consistent on both mutateKey paths (the CAS path returns the
  // fresh-read value, not our computed `next`, when no `result` is given).
  const todayKey = dayKey(now);
  const legacyPresence = await readLegacyPresenceAliases(env, ws.id);
  const data = await mutateKey(env, STORE_NAME, presenceKey(ws.id), (current) => {
    const next = mergePresenceRecords(legacyPresence, current);
    next.byEmail = next.byEmail || {};
    next.opens   = next.opens   || {};
    // Read-only callers (a backgrounded/realtime-driven sexboard refetch) still
    // get the merged view for partner-last-seen + streak, but must NOT stamp the
    // caller as active — that false "active" is what suppresses their real pushes.
    if (!stamp) return { value: next, result: next, write: false };
    const prevSeen = next.byEmail[actorEmail];
    const seenFresh = prevSeen && (Date.parse(now) - Date.parse(prevSeen)) < SEEN_FRESH_MS;
    const openRecorded = Boolean(next.opens[actorEmail] && next.opens[actorEmail][todayKey]);
    if (seenFresh && openRecorded) return { value: next, result: next, write: false };
    next.byEmail[actorEmail] = now;
    next.opens[actorEmail] = next.opens[actorEmail] || {};
    next.opens[actorEmail][todayKey] = true;
    trimHistory(next.opens);
    return { value: next, result: next };
  });

  const members = (ws.members || []).filter((m) => m.status === "active");
  const me = members.find((m) => normalizeEmail(m.email) === actorEmail);
  const partner = members.find((m) => normalizeEmail(m.email) !== actorEmail);

  const partnerEmail = partner ? normalizeEmail(partner.email) : "";
  const partnerLastSeen = partnerEmail ? (data.byEmail[partnerEmail] || null) : null;
  const myLastSeen = data.byEmail[actorEmail] || now;

  const emailsForStreak = [actorEmail];
  if (partnerEmail) emailsForStreak.push(partnerEmail);
  const daysInSync = partnerEmail ? computeStreak(data.opens, emailsForStreak) : 0;

  return {
    me:       { email: actorEmail, lastSeen: myLastSeen, displayName: me?.displayName || "" },
    partner:  partner ? { email: partnerEmail, lastSeen: partnerLastSeen, displayName: partner.displayName || "" } : null,
    daysInSync,
  };
}

export async function onRequest(context) {
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;
  const env = context.env;
  const workspaceId = workspaceIdFromRequest(context.request);
  const access = await authorizeWorkspaceAccess(context, identity, workspaceId);
  if (!access.ok) return access.response;
  const ws = access.workspace;
  const actorEmail = normalizeEmail(identity.email);
  return jsonResponse(200, await readPresenceResponse(env, ws, actorEmail));
}
