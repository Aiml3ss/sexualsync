// v2 · Sprint A · Tonight Pile — server-backed collaborative async asking.
// Both partners drop acts during the day. Until revealAt, each partner only
// sees their own contributions plus a masked signal that the other has joined.
// After revealAt, server returns full contributions plus the derived overlap.

import { getStore } from "./_kv.js";
import { mutateKey, readKeyStrong } from "./_state.js";
import {
  getAuthenticatedIdentity,
  jsonResponse,
  normalizeEmail
} from "./_auth.js";
import {
  authorizeWorkspaceAccess,
  workspaceIdFromRequest,
  workspaceIdFromPayload,
  workspaceIdsForDataAccess
} from "./_workspaces.js";
import { appendAudit } from "./_audit.js";
import { notifyWorkspaceEvent } from "./_notification_policy.js";
import { checkRateLimit, rateLimitResponse } from "./_rate_limit.js";
import { broadcastRoomEvent } from "./_live_room.js";
import { readActsForWorkspace } from "./approved-acts.js";
import { readBoundaries, hardNoConflicts } from "./request-board.js";
import { narrateMatch } from "./_match_narration.js";
import { cleanRoomEncryptedBox } from "./_e2ee.js";

const STORE_NAME = "sexualsync-pile";
const LEGACY_MAX_DROPS_PER_USER = 30;
const MAX_LABEL_LENGTH = 80;
const BUILT_IN_PILE_ACT_LABELS = [
  "💆 Sensual massage",
  "👅 Tongue Lashing",
  "💋 Mutual oral",
  "🍆 Penetration",
  "🐢 Slow positions",
  "🔥 Active positions",
  "🤠 Cowgirl or reverse",
  "🍑 From behind",
  "🧍 Standing or wall",
  "👑 On Top",
  "🛋️ Couch",
  "🎁 Toys or accessories",
  "💬 Dirty talk",
  "🔗 Kink",
  "⛓️ Light restraint",
  "🤗 Cuddling",
  "✋ Mutual Masturbation",
  "🪑 Face Sitting",
  "🎭 Roleplay",
];

function pileStore(env) { return getStore(env, STORE_NAME); }
function pileKey(workspaceId) { return `pile:${workspaceId}:active`; }
function pileSessionsKey(workspaceId) { return `pile:${workspaceId}:sessions`; }

function sessionIdFromRequest(request) {
  try {
    return cleanLabel(new URL(request.url).searchParams.get("sessionId") || "");
  } catch {
    return "";
  }
}

function cleanLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
}

function cleanToken(value) {
  return String(value || "").replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 180);
}

function roomE2eeRequired(workspace) {
  return Boolean(workspace?.settings?.roomE2eeEnabled);
}

function cleanEncryptedLabelEntry(entry) {
  const token = cleanToken(entry?.token || entry?.labelToken);
  const encryptedLabel = cleanRoomEncryptedBox(entry?.encryptedLabel, 12000);
  return token && encryptedLabel ? { token, encryptedLabel } : null;
}

function encryptedEntriesForEmail(pile, email) {
  const norm = normalizeEmail(email);
  const entries = pile?.encryptedContributions?.[norm];
  return Array.isArray(entries) ? entries.map(cleanEncryptedLabelEntry).filter(Boolean) : [];
}

function encryptedEntriesForValues(pile, values, preferredEmail = "") {
  const wanted = new Set((values || []).map((value) => String(value || "")));
  const entries = [];
  const seen = new Set();
  const addEntries = (list = []) => {
    list.forEach((entry) => {
      const clean = cleanEncryptedLabelEntry(entry);
      if (!clean || !wanted.has(clean.token) || seen.has(clean.token)) return;
      seen.add(clean.token);
      entries.push(clean);
    });
  };
  if (preferredEmail) addEntries(encryptedEntriesForEmail(pile, preferredEmail));
  Object.values(pile?.encryptedContributions || {}).forEach((list) => addEntries(Array.isArray(list) ? list : []));
  return entries;
}

function isPileRequester(pile, email) {
  const startedBy = normalizeEmail(pile?.startedByEmail);
  return Boolean(startedBy) && startedBy === normalizeEmail(email);
}

function canRemovePileSession(session, email) {
  const lockedBy = normalizeEmail(session?.lockedByEmail);
  return !lockedBy || lockedBy === normalizeEmail(email);
}

function safePositiveInteger(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

export function pileDropCapMax(totalActCount) {
  const count = Math.max(1, safePositiveInteger(totalActCount));
  return Math.max(1, Math.floor(count / 3));
}

function randomInteger(min, max) {
  const low = Math.ceil(min);
  const high = Math.floor(max);
  if (high <= low) return low;
  const span = high - low + 1;
  const values = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values);
    return low + (values[0] % span);
  }
  return low + Math.floor(Math.random() * span);
}

export function randomPileMaxDropCount(totalActCount) {
  return randomInteger(1, pileDropCapMax(totalActCount));
}

function pileMaxDropCount(pile) {
  return safePositiveInteger(pile?.maxDropCount || pile?.targetDropCount);
}

function pileDropLimit(pile) {
  return pileMaxDropCount(pile) || LEGACY_MAX_DROPS_PER_USER;
}

function pileHasTwoDroppingPartners(pile) {
  return Object.values(pile?.contributions || {})
    .filter((labels) => Array.isArray(labels) && labels.length > 0)
    .length >= 2;
}

function pileIsRevealed(pile, now = Date.now()) {
  const revealAt = pile?.revealAt ? new Date(pile.revealAt).getTime() : 0;
  return revealAt > 0 && now >= revealAt && pileHasTwoDroppingPartners(pile);
}

export async function pileActPoolCount(env, workspace, actorEmail, options = {}) {
  const labels = new Set(BUILT_IN_PILE_ACT_LABELS.map((label) => cleanLabel(label).toLowerCase()).filter(Boolean));
  try {
    const workspaceIds = options.workspaceIds || workspaceIdsForDataAccess(workspace, actorEmail, options.legacyWorkspace);
    const { acts } = await readActsForWorkspace(env, workspace.id, { workspaceIds });
    for (const act of acts || []) {
      const label = act?.encryptedPayload
        ? `encrypted:${cleanLabel(act.id)}`
        : cleanLabel(act?.label).toLowerCase();
      if (label) labels.add(label);
    }
  } catch {}
  return Math.max(1, labels.size);
}

// Compute the overlap (labels present in BOTH partners' contributions).
export function computeOverlapLabels(pile) {
  const arrs = Object.values(pile?.contributions || {})
    .map((labels) => Array.isArray(labels) ? labels.map((s) => String(s).toLowerCase()) : []);
  if (arrs.length < 2) return [];
  const first = arrs[0];
  const overlap = [];
  for (const label of first) {
    if (arrs.every((arr) => arr.includes(label))) {
      // Recover the original-case version from the first partner.
      const orig = (pile.contributions[Object.keys(pile.contributions)[0]] || []).find(
        (s) => s.toLowerCase() === label
      );
      if (orig && !overlap.includes(orig)) overlap.push(orig);
    }
  }
  return overlap;
}

// Calls the narrator endpoint behavior inline (rather than HTTP-self-fetching)
// to write a one-line description of the overlap.
async function narratePileOverlap(env, { myName, partnerName, acts }) {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY || !acts?.length) return "";
  try {
    const generated = await narrateMatch(env, {
      you: myName,
      partner: partnerName,
      acts,
      timing: "Tonight",
      filming: false
    }, {
      feature: "pile-narration",
      routeFlag: "LLM_ENABLE_PILE_NARRATION",
      defaultEnabled: true,
      timeoutMs: 8000,
      maxTokens: 60
    });
    return generated.text || "";
  } catch { return ""; }
}

export async function readPile(env, workspaceId) {
  try {
    // Strong read so a Pile you just dropped into shows on the Sexboard right
    // away, instead of lagging KV's ~60s eventual consistency.
    return await readKeyStrong(env, STORE_NAME, pileKey(workspaceId));
  } catch { return null; }
}
async function writePile(env, workspaceId, pile) {
  if (pile === null) {
    // The active-pile key is CAS-managed: readPile → readKeyStrong serves the
    // coordinator's strongly-consistent mirror. A plain KV delete never touches
    // that mirror, so it keeps the just-ended pile and the next read resurrects
    // it (and `start` then 409s on the ghost, bricking The Pile). Clear the
    // mirror through a CAS null-write FIRST, then delete the KV key so "no active
    // pile" (key absence) still holds and a concurrent drop's CAS sees the bump.
    try { await mutateKey(env, STORE_NAME, pileKey(workspaceId), () => ({ value: null })); } catch {}
    try { await pileStore(env).delete(pileKey(workspaceId)); } catch {}
    return;
  }
  await pileStore(env).setJSON(pileKey(workspaceId), pile);
}

export async function readPileSessions(env, workspaceId) {
  try {
    const sessions = await readKeyStrong(env, STORE_NAME, pileSessionsKey(workspaceId));
    return Array.isArray(sessions) ? sessions : [];
  } catch { return []; }
}

function quietDropCount(pile, overlapLabels) {
  const overlap = new Set((overlapLabels || []).map((label) => String(label).toLowerCase()));
  return Object.values(pile?.contributions || {}).reduce((count, labels) => {
    const safeLabels = Array.isArray(labels) ? labels : [];
    return count + safeLabels.filter((label) => !overlap.has(String(label).toLowerCase())).length;
  }, 0);
}

// Public view: hide partner's labels AND counts until revealAt has passed.
// Sprint 0.8 — leaking the partner's count before reveal creates implicit
// pressure ("they've dropped 5, I've dropped 0"). Each partner sees only
// their own count until the reveal moment, when both counts surface together.
export function publicPile(pile, viewerEmail) {
  if (!pile) return null;
  const me = normalizeEmail(viewerEmail);
  const isRevealed = pileIsRevealed(pile);
  const isEncrypted = pile.roomE2ee === true;
  const maxDropCount = pileMaxDropCount(pile);
  const contributions = pile.contributions || {};
  const mine = (contributions[me] || []).slice();
  const masked = {};
  const counts = {};
  // Has-the-partner-engaged-at-all signal — boolean only, no number.
  // Lets the UI render "your partner is dropping picks" without revealing
  // how many.
  let partnerHasDropped = false;
  let overlapLabels = [];
  let onlyMineLabels = [];
  let onlyTheirsLabels = [];
  Object.entries(contributions).forEach(([email, labels]) => {
    const norm = normalizeEmail(email);
    const safeLabels = Array.isArray(labels) ? labels : [];
    if (norm === me) {
      counts[norm] = safeLabels.length;
      return;
    }
    if (isRevealed) {
      counts[norm] = safeLabels.length;
      masked[norm] = safeLabels.slice();
    } else {
      // Pre-reveal: hide both the labels and the count from the viewer.
      // The boolean `partnerHasDropped` (below) lets the UI show a
      // generic "they're in" state without leaking the magnitude.
      if (safeLabels.length > 0) partnerHasDropped = true;
    }
  });
  if (isRevealed) {
    const all = Object.values(contributions).map((arr) => (arr || []).map((s) => s.toLowerCase()));
    if (all.length >= 2) {
      overlapLabels = (contributions[me] || []).filter((label) =>
        all.every((arr) => arr.includes(label.toLowerCase()))
      );
      // Labels from the partner side that the VIEWER didn't drop. Diff against
      // the viewer's own set — not the first contributor's (key order is
      // arbitrary, so the non-starter viewer used to diff the partner's labels
      // against the partner's own set and always see an empty list here).
      const myLabelSet = new Set((contributions[me] || []).map((s) => s.toLowerCase()));
      onlyTheirsLabels = [];
      Object.entries(contributions).forEach(([email, labels]) => {
        if (normalizeEmail(email) === me) return;
        (labels || []).forEach((label) => {
          if (!myLabelSet.has(label.toLowerCase())) {
            onlyTheirsLabels.push(label);
          }
        });
      });
      onlyMineLabels = mine.filter((label) =>
        !overlapLabels.map((s) => s.toLowerCase()).includes(label.toLowerCase())
      );
    } else {
      onlyMineLabels = mine.slice();
    }
  }
  const out = {
    revealAt: pile.revealAt,
    startedAt: pile.startedAt,
    startedByEmail: pile.startedByEmail,
    maxDropCount,
    // Compatibility alias for active clients/data created before this became
    // a cap instead of an exact target.
    targetDropCount: maxDropCount,
    targetMaxDropCount: safePositiveInteger(pile.targetMaxDropCount),
    actPoolCount: safePositiveInteger(pile.actPoolCount),
    isRevealed,
    mine,
    // Pre-reveal: `counts` only contains the viewer's own count.
    // Post-reveal: contains both. Client treats missing keys as opaque.
    counts,
    partnerHasDropped: isRevealed ? undefined : partnerHasDropped,
    partnerLabels: isRevealed ? masked : null,
    overlap: isRevealed ? overlapLabels : null,
    onlyMine: isRevealed ? onlyMineLabels : null,
    onlyTheirs: isRevealed ? onlyTheirsLabels : null,
    revealNarration: isRevealed ? (pile.revealNarration || "") : "",
  };
  if (isEncrypted) {
    out.encryptedMine = encryptedEntriesForValues(pile, mine, me);
    if (isRevealed) {
      const encryptedPartnerLabels = {};
      Object.keys(masked).forEach((email) => {
        encryptedPartnerLabels[email] = encryptedEntriesForValues(pile, masked[email], email);
      });
      out.encryptedPartnerLabels = encryptedPartnerLabels;
      out.encryptedOverlap = encryptedEntriesForValues(pile, overlapLabels, me);
      out.encryptedOnlyMine = encryptedEntriesForValues(pile, onlyMineLabels, me);
      out.encryptedOnlyTheirs = encryptedEntriesForValues(pile, onlyTheirsLabels);
    }
  }
  return out;
}

// One in-flight narration per workspace per isolate. Cross-isolate duplicates
// are tolerated: the CAS patch below is first-write-wins and the LLM call is
// rate-limited, so a duplicate just wastes one bounded background call.
const NARRATION_INFLIGHT = new Set();

// v2 · Pile reveal narration, generated OFF the response path. The old inline
// version awaited the LLM (up to 8s) inside the Sexboard/pile GET — stalling
// the dashboard for both partners whenever the LLM was slow — and then wrote
// back the whole pre-LLM pile snapshot, clobbering concurrent drops and
// resurrecting a pile deleted by lock/end during the LLM window. Now: serve
// immediately with empty narration, generate in the background, and CAS-patch
// ONLY revealNarration onto the fresh record (no write if the pile is gone,
// re-rolled, or already narrated).
function schedulePileNarration(context, env, ws, actorEmail, actorName) {
  if (NARRATION_INFLIGHT.has(ws.id)) return;
  NARRATION_INFLIGHT.add(ws.id);
  const task = (async () => {
    try {
      const narrationLimit = await checkRateLimit(env, {
        bucket: "ai-pile-narration",
        key: `${actorEmail}:${ws.id}`,
        limit: 10,
        windowSeconds: 60 * 60
      });
      if (!narrationLimit.ok) return;
      const fresh = await readPile(env, ws.id);
      if (!fresh || fresh.roomE2ee || !pileIsRevealed(fresh) || fresh.revealNarration) return;
      const overlapLabels = computeOverlapLabels(fresh);
      if (!overlapLabels.length) return;
      const startedAt = fresh.startedAt;
      const members = (ws.members || []).filter((m) => m.status === "active");
      const me      = members.find((m) => normalizeEmail(m.email) === actorEmail);
      const partner = members.find((m) => normalizeEmail(m.email) !== actorEmail);
      const myName       = me?.displayName?.split(" ")[0]      || actorName?.split(" ")[0] || "You";
      const partnerName  = partner?.displayName?.split(" ")[0] || "Partner";
      const narration = await narratePileOverlap(env, {
        myName, partnerName,
        acts: overlapLabels,
      });
      if (!narration) return;
      await mutateKey(env, STORE_NAME, pileKey(ws.id), (cur) => {
        // Patch only if it is still the SAME revealed, un-narrated pile.
        if (!cur || cur.roomE2ee || !pileIsRevealed(cur) || cur.revealNarration) return { write: false, result: null };
        if (cur.startedAt !== startedAt) return { write: false, result: null };
        return { value: { ...cur, revealNarration: narration }, result: null };
      });
    } catch {} finally {
      NARRATION_INFLIGHT.delete(ws.id);
    }
  })();
  if (typeof context?.waitUntil === "function") context.waitUntil(task);
}

export async function readPileResponse(env, ws, actorEmail, actorName = "", options = {}) {
  const [pile, sessions] = await Promise.all([
    readPile(env, ws.id),
    readPileSessions(env, ws.id)
  ]);
  if (pile && !pile.roomE2ee && pileIsRevealed(pile) && !pile.revealNarration) {
    schedulePileNarration(options.context, env, ws, actorEmail, actorName);
  }
  return {
    pile: publicPile(pile, actorEmail),
    sessions
  };
}

export async function onRequest(context) {
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;
  const env = context.env;
  const request = context.request;
  const method = request.method.toUpperCase();

  let payload = {};
  if (method !== "GET" && method !== "DELETE") {
    try { payload = await request.json(); }
    catch { return jsonResponse(400, { error: "Invalid JSON body." }); }
  }

  const workspaceId = workspaceIdFromRequest(request) || workspaceIdFromPayload(payload);
  const access = await authorizeWorkspaceAccess(context, identity, workspaceId);
  if (!access.ok) return access.response;
  const actorEmail = normalizeEmail(identity.email);
  const actorName = identity.displayName || access.workspace.members?.find((m) => normalizeEmail(m.email) === actorEmail)?.displayName || "";
  const ws = access.workspace;

  if (method === "GET") {
    return jsonResponse(200, await readPileResponse(env, ws, actorEmail, actorName, { workspaceIds: access.dataWorkspaceIds, context }));
  }

  // POST — action-based.
  const action = method === "DELETE" ? "end" : String(payload.action || "drop");
  const limited = await checkRateLimit(env, {
    bucket: `pile-${action}`,
    key: `${actorEmail}:${ws.id}`,
    limit: action === "drop" ? 30 : 20,
    windowSeconds: 5 * 60
  });
  if (!limited.ok) return rateLimitResponse(limited.retryAfter);

  const sessionId = method === "DELETE" ? sessionIdFromRequest(request) : "";
  if (sessionId) {
    const result = await mutateKey(env, STORE_NAME, pileSessionsKey(ws.id), (fresh) => {
      const sessions = Array.isArray(fresh) ? fresh : [];
      const session = sessions.find((entry) => String(entry?.id || "") === sessionId);
      if (!session) return { write: false, result: { found: false } };
      if (!canRemovePileSession(session, actorEmail)) {
        return { write: false, result: { found: true, forbidden: true, session } };
      }
      const nextSessions = sessions.filter((entry) => String(entry?.id || "") !== sessionId);
      return { value: nextSessions, result: { found: true, session, nextSessions } };
    });
    if (!result.found) return jsonResponse(404, { error: "Locked Pile session not found." });
    if (result.forbidden) return jsonResponse(403, { error: "Only the person who locked this Pile can remove it." });
    const session = result.session;
    const nextSessions = result.nextSessions || [];
    await appendAudit(env, ws.id, {
      type: "pile_session_removed",
      actorEmail,
      actorName,
      entityType: "pile_session",
      entityId: sessionId,
      metadata: {
        overlapCount: Array.isArray(session.acts) ? session.acts.length : 0,
        lockedByEmail: session.lockedByEmail || ""
      }
    });
    broadcastRoomEvent(context, ws.id, {
      resource: "pile",
      action: "removed",
      entityId: sessionId,
      actorEmail,
      actorName,
    });
    const activePile = await readPile(env, ws.id);
    return jsonResponse(200, {
      pile: publicPile(activePile, actorEmail),
      sessions: nextSessions
    });
  }

  if (action === "start") {
    const revealAt = String(payload.revealAt || "");
    if (!revealAt || Number.isNaN(new Date(revealAt).getTime())) {
      return jsonResponse(400, { error: "revealAt must be a valid ISO timestamp." });
    }
    const actPoolCount = await pileActPoolCount(env, ws, actorEmail, { workspaceIds: access.dataWorkspaceIds });
    const targetMaxDropCount = pileDropCapMax(actPoolCount);
    const maxDropCount = randomPileMaxDropCount(actPoolCount);
    const next = {
      startedAt: new Date().toISOString(),
      startedByEmail: actorEmail,
      revealAt,
      maxDropCount,
      targetDropCount: maxDropCount,
      targetMaxDropCount,
      actPoolCount,
      contributions: { [actorEmail]: [] },
    };
    if (roomE2eeRequired(ws)) {
      next.roomE2ee = true;
      next.encryptedContributions = { [actorEmail]: [] };
    }
    // `start` must not silently destroy a pile the couple is mid-game on
    // (double-tap, second device, or an offline-queued replay landing late).
    // A revealed pile may be replaced (starting fresh after looking at the
    // results is a legit flow); an in-progress one is protected: the same
    // actor re-sending the same start (a replay) gets the existing pile back,
    // anything else is a 409.
    const startOutcome = await mutateKey(env, STORE_NAME, pileKey(ws.id), (cur) => {
      if (cur && !pileIsRevealed(cur)) {
        const sameStart = normalizeEmail(cur.startedByEmail) === actorEmail && cur.revealAt === revealAt;
        return { write: false, result: sameStart ? { ok: true, pile: cur, replay: true } : { ok: false } };
      }
      return { value: next, result: { ok: true, pile: next } };
    });
    if (!startOutcome.ok) {
      return jsonResponse(409, { error: "A Pile is already in progress. End it before starting a new one." });
    }
    if (startOutcome.replay) {
      return jsonResponse(200, {
        pile: publicPile(startOutcome.pile, actorEmail),
        sessions: await readPileSessions(env, ws.id)
      });
    }
    await appendAudit(env, ws.id, {
      type: "pile_started",
      actorEmail,
      actorName,
      entityType: "pile",
      metadata: { targetDropCount: maxDropCount, targetMaxDropCount, actPoolCount }
    });
    broadcastRoomEvent(context, ws.id, {
      resource: "pile",
      action: "started",
      actorEmail,
      actorName,
    });
    // Notify partner. Sprint 0.2 — lock-screen-safe generic body.
    // Reveal time isn't leaked at the lock screen; partner sees it in-app.
    notifyWorkspaceEvent(context, ws.id, actorEmail, {
      title: "Sexualsync",
      body: "Something new in your room.",
      tag: "pile-started",
      url: "/"
    }).catch(() => {});
    return jsonResponse(200, { pile: publicPile(next, actorEmail) });
  }

  if (action === "end" || method === "DELETE") {
    const existing = await readPile(env, ws.id);
    if (!existing) return jsonResponse(404, { error: "No active pile." });
    if (!isPileRequester(existing, actorEmail)) {
      return jsonResponse(403, { error: "Only the requester can end The Pile." });
    }
    // Terminal close: delete the active-pile key. writePile(null) removes the
    // key entirely — a json `null` write would persist it as the string "null"
    // (key still present), which breaks "no active pile" detection.
    await writePile(env, ws.id, null);
    await appendAudit(env, ws.id, { type: "pile_ended", actorEmail, actorName, entityType: "pile" });
    broadcastRoomEvent(context, ws.id, {
      resource: "pile",
      action: "ended",
      actorEmail,
      actorName,
    });
    return jsonResponse(200, {
      pile: null,
      sessions: await readPileSessions(env, ws.id)
    });
  }

  const existing = await readPile(env, ws.id);
  if (!existing) return jsonResponse(404, { error: "No active pile." });

  if (action === "decline") {
    if (isPileRequester(existing, actorEmail)) {
      return jsonResponse(403, { error: "Only the partner can decline The Pile." });
    }
    // Terminal close: delete the active-pile key (see `end` above for why a
    // null write is not a delete).
    await writePile(env, ws.id, null);
    await appendAudit(env, ws.id, {
      type: "pile_declined",
      actorEmail,
      actorName,
      entityType: "pile",
      metadata: { startedByEmail: existing.startedByEmail || "" }
    });
    broadcastRoomEvent(context, ws.id, {
      resource: "pile",
      action: "declined",
      actorEmail,
      actorName,
    });
    return jsonResponse(200, {
      pile: null,
      sessions: await readPileSessions(env, ws.id)
    });
  }

  if (action === "lock") {
    if (!pileIsRevealed(existing)) {
      return jsonResponse(409, { error: "The Pile is not revealed yet." });
    }
    // Non-deterministic bits are generated ONCE here so a CAS retry of the
    // pile transform doesn't churn them (only the winning attempt persists).
    const sessionId = crypto.randomUUID();
    const lockedAt = new Date().toISOString();

    // STEP 1 (pile key): CLAIM the lock inside the CAS, then derive the session
    // from the fresh pile. The claim (lockedSessionId stamped on the record)
    // is what makes a double-tap / two-device race safe: the first writer wins
    // the version, every concurrent or later attempt sees the claim and
    // resumes the SAME session id instead of deriving a second session. The
    // append in STEP 2 dedupes by id, so the whole lock is idempotent — a
    // crash between the steps heals on the next tap.
    const locked = await mutateKey(env, STORE_NAME, pileKey(ws.id), (fresh) => {
      if (!fresh) return { write: false, result: { status: "gone" } };
      if (!pileIsRevealed(fresh)) return { write: false, result: { status: "not_revealed" } };
      const resuming = Boolean(fresh.lockedSessionId);
      const claim = {
        id: resuming ? String(fresh.lockedSessionId) : sessionId,
        at: resuming ? String(fresh.lockedSessionAt || lockedAt) : lockedAt,
        byEmail: resuming ? String(fresh.lockedSessionByEmail || actorEmail) : actorEmail,
        byName: resuming ? String(fresh.lockedSessionByName || "") : actorName,
      };
      const overlapLabels = computeOverlapLabels(fresh);
      const encryptedOverlap = fresh.roomE2ee
        ? encryptedEntriesForValues(fresh, overlapLabels, claim.byEmail)
        : [];
      const session = {
        id: claim.id,
        workspaceId: ws.id,
        acts: fresh.roomE2ee ? overlapLabels.map(() => "Encrypted pile match") : overlapLabels,
        overlap: fresh.roomE2ee ? overlapLabels.map(() => "Encrypted pile match") : overlapLabels,
        quietDropCount: quietDropCount(fresh, overlapLabels),
        revealAt: fresh.revealAt,
        startedAt: fresh.startedAt,
        lockedAt: claim.at,
        lockedByEmail: claim.byEmail,
        lockedByName: claim.byName,
        revealNarration: fresh.roomE2ee ? "" : fresh.revealNarration || "",
      };
      if (fresh.roomE2ee) {
        session.encryptedActs = encryptedOverlap;
        session.encryptedOverlap = encryptedOverlap;
        session.roomE2ee = true;
      }
      const result = { status: "locked", session, overlapCount: overlapLabels.length };
      if (resuming) return { write: false, result };
      return {
        value: {
          ...fresh,
          lockedSessionId: claim.id,
          lockedSessionAt: claim.at,
          lockedSessionByEmail: claim.byEmail,
          lockedSessionByName: claim.byName,
        },
        result
      };
    });

    if (locked.status === "gone") return jsonResponse(404, { error: "No active pile." });
    if (locked.status === "not_revealed") {
      return jsonResponse(409, { error: "The Pile is not revealed yet." });
    }
    const session = locked.session;

    // STEP 2 (sessions key — DIFFERENT key): append atomically, deduped by the
    // claimed session id so a resumed/raced lock cannot double-insert.
    const sessions = await mutateKey(env, STORE_NAME, pileSessionsKey(ws.id), (fresh) => {
      const current = Array.isArray(fresh) ? fresh : [];
      if (current.some((entry) => String(entry?.id || "") === session.id)) {
        return { write: false, result: current };
      }
      const next = [session, ...current].slice(0, 20);
      return { value: next, result: next };
    });

    // STEP 3: clear the active pile only after the session is durably
    // appended. Delete the key (writePile(null) removes it); a CAS `null`
    // write would persist the key as "null".
    await writePile(env, ws.id, null);
    await appendAudit(env, ws.id, {
      type: "pile_locked",
      actorEmail,
      actorName,
      entityType: "pile_session",
      entityId: session.id,
      metadata: { overlapCount: locked.overlapCount }
    });
    broadcastRoomEvent(context, ws.id, {
      resource: "pile",
      action: "locked",
      entityId: session.id,
      actorEmail,
      actorName,
    });
    return jsonResponse(200, { pile: null, session, sessions });
  }

  if (action === "update-time") {
    if (!isPileRequester(existing, actorEmail)) {
      return jsonResponse(403, { error: "Only the requester can move the reveal time." });
    }
    const revealAt = String(payload.revealAt || "");
    if (!revealAt || Number.isNaN(new Date(revealAt).getTime())) {
      return jsonResponse(400, { error: "revealAt must be a valid ISO timestamp." });
    }
    // Patch only `revealAt` onto the FRESH record so contributions a partner
    // dropped concurrently survive (don't write back the stale snapshot).
    const updated = await mutateKey(env, STORE_NAME, pileKey(ws.id), (fresh) => {
      if (!fresh) return { write: false, result: null };
      if (!isPileRequester(fresh, actorEmail)) return { write: false, result: { forbidden: true } };
      const next = { ...fresh, revealAt };
      return { value: next, result: next };
    });
    if (updated?.forbidden) {
      return jsonResponse(403, { error: "Only the requester can move the reveal time." });
    }
    if (!updated) return jsonResponse(404, { error: "No active pile." });
    broadcastRoomEvent(context, ws.id, {
      resource: "pile",
      action: "time_updated",
      actorEmail,
      actorName,
    });
    return jsonResponse(200, { pile: publicPile(updated, actorEmail) });
  }

  if (action === "drop") {
    // Input validation runs BEFORE the atomic transform (the transform may
    // re-run on a CAS retry, so it must be side-effect-free and stateless).
    // `roomE2eeRequired(ws)` is workspace config; `existing.roomE2ee` only ever
    // flips false->true, so gating the encrypted-payload requirement on the
    // snapshot here cannot wrongly accept a plaintext drop into an encrypted
    // pile — the transform re-derives encrypted mode from the fresh record.
    const encryptedMode = existing.roomE2ee === true || roomE2eeRequired(ws);
    const labelToken = cleanToken(payload.labelToken);
    const encryptedLabel = cleanRoomEncryptedBox(payload.encryptedLabel, 12000);
    if (encryptedMode && (!labelToken || !encryptedLabel)) {
      return jsonResponse(400, { error: "Room Encryption requires encrypted Pile drops." });
    }
    const rawLabel = encryptedMode ? labelToken : cleanLabel(payload.label);
    if (!rawLabel) return jsonResponse(400, { error: "Label is required." });
    const label = rawLabel;

    // A Hard No must never enter the Pile, where a both-partners overlap becomes
    // a mutual, "agreed" match. Mirror the Ask flow's server-side Hard No gate.
    // This can only run in PLAINTEXT mode: under Room Encryption the boundary
    // text and the drop are both ciphertext / opaque tokens, so the server
    // cannot compare them (the same limitation the Ask flow has) — the client
    // is responsible for filtering there.
    if (!encryptedMode) {
      const conflicts = hardNoConflicts(
        await readBoundaries(env, access.dataWorkspaceIds),
        access.dataWorkspaceIds,
        { categories: [label], filming: "No" }
      );
      if (conflicts.length) {
        return jsonResponse(409, { error: "This is on your Hard No list.", conflicts });
      }
    }

    // Merge the drop into the FRESH contributions so a partner dropping at the
    // same instant can't be clobbered. All state-dependent checks (reveal,
    // per-user drop limit, encrypted mode) read from `fresh`. The transform
    // returns a discriminator in `result.status`; HTTP mapping happens after.
    const outcome = await mutateKey(env, STORE_NAME, pileKey(ws.id), (fresh) => {
      if (!fresh) return { write: false, result: { status: "gone" } };
      if (pileIsRevealed(fresh)) return { write: false, result: { status: "revealed" } };
      const freshEncrypted = fresh.roomE2ee === true || roomE2eeRequired(ws);
      const next = { ...fresh, contributions: { ...(fresh.contributions || {}) } };
      const dropLimit = pileDropLimit(next);
      const mine = Array.isArray(next.contributions[actorEmail])
        ? next.contributions[actorEmail].slice(0, dropLimit)
        : [];
      next.contributions[actorEmail] = mine;
      const alreadyDropped = mine.some((entry) => entry.toLowerCase() === label.toLowerCase());
      if (alreadyDropped) {
        return { write: false, result: { status: "noop", pile: next } };
      }
      if (mine.length >= dropLimit) {
        return { write: false, result: { status: "limit", dropLimit } };
      }
      next.contributions[actorEmail] = [...mine, label];
      if (freshEncrypted) {
        next.roomE2ee = true;
        next.encryptedContributions = { ...(fresh.encryptedContributions || {}) };
        const currentEntries = Array.isArray(next.encryptedContributions[actorEmail])
          ? next.encryptedContributions[actorEmail]
          : [];
        next.encryptedContributions[actorEmail] = [
          ...currentEntries.filter((entry) => cleanToken(entry?.token) !== label),
          { token: label, encryptedLabel },
        ];
      }
      return { value: next, result: { status: "dropped", pile: next } };
    });

    if (outcome.status === "gone") return jsonResponse(404, { error: "No active pile." });
    if (outcome.status === "revealed") return jsonResponse(410, { error: "Pile already revealed." });
    if (outcome.status === "limit") {
      return jsonResponse(409, { error: `This Pile allows up to ${outcome.dropLimit} Acts each. Remove one to swap.` });
    }
    if (outcome.status === "dropped") {
      broadcastRoomEvent(context, ws.id, {
        resource: "pile",
        action: "dropped",
        actorEmail,
        actorName,
      });
    }
    return jsonResponse(200, { pile: publicPile(outcome.pile, actorEmail) });
  }

  if (action === "undrop") {
    // Encrypted mode is workspace config OR an already-encrypted pile; either
    // way the label key is the token. Validate input before the transform.
    const encryptedMode = existing.roomE2ee === true || roomE2eeRequired(ws);
    const label = encryptedMode ? cleanToken(payload.labelToken) : cleanLabel(payload.label);
    if (!label) return jsonResponse(400, { error: "Label is required." });

    // Remove only this actor's label from the FRESH record so a concurrent
    // partner drop isn't reverted along with it.
    const outcome = await mutateKey(env, STORE_NAME, pileKey(ws.id), (fresh) => {
      if (!fresh) return { write: false, result: { changed: false, pile: null } };
      const next = { ...fresh, contributions: { ...(fresh.contributions || {}) } };
      const mine = Array.isArray(next.contributions[actorEmail]) ? next.contributions[actorEmail] : [];
      const filtered = mine.filter((x) => x.toLowerCase() !== label.toLowerCase());
      next.contributions[actorEmail] = filtered;
      const freshEncrypted = next.roomE2ee === true || roomE2eeRequired(ws);
      if (freshEncrypted && Array.isArray(fresh.encryptedContributions?.[actorEmail])) {
        next.encryptedContributions = { ...(fresh.encryptedContributions || {}) };
        next.encryptedContributions[actorEmail] = fresh.encryptedContributions[actorEmail]
          .filter((entry) => cleanToken(entry?.token) !== label);
      }
      const changed = filtered.length !== mine.length;
      return { value: next, result: { changed, pile: next } };
    });

    if (!outcome.pile) return jsonResponse(404, { error: "No active pile." });
    if (outcome.changed) {
      broadcastRoomEvent(context, ws.id, {
        resource: "pile",
        action: "undropped",
        actorEmail,
        actorName,
      });
    }
    return jsonResponse(200, { pile: publicPile(outcome.pile, actorEmail) });
  }

  return jsonResponse(400, { error: "Unknown action." });
}
