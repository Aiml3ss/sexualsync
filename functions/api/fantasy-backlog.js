import { getStore } from "./_kv.js";
import { mutateKey } from "./_state.js";
import {
  LEGACY_WORKSPACE_ID,
  getAuthenticatedIdentity,
  jsonResponse,
  normalizeEmail
} from "./_auth.js";
import {
  authorizeWorkspaceAccess,
  cleanText,
  legacyEmailForName,
  legacyNameForEmail,
  legacyPeopleForEnv,
  workspaceIdFromPayload,
  workspaceIdFromRequest
} from "./_workspaces.js";
import { appendAudit } from "./_audit.js";
import { cleanRoomEncryptedBox } from "./_e2ee.js";
import { checkRateLimit, rateLimitResponse } from "./_rate_limit.js";
import { broadcastFocusRoomEvent, broadcastRoomEvent } from "./_live_room.js";
import { isNotificationSatisfied, notifyWorkspaceEvent } from "./_notification_policy.js";
import { cleanIdempotencyKey, idempotentId } from "./_idempotency.js";

const STORE_NAME = "sexualsync-ideas";
// C3 — ideas and graveyard are now keyed per workspace so the MAX_IDEAS /
// MAX_GRAVEYARD caps and the CAS versions are scoped to one couple. The bare
// "ideas"/"graveyard" keys are retained ONLY as a read-time legacy fallback and
// as a seed for the first per-workspace write; new writes never touch them.
// See scripts/migrate-store-keys.mjs.
const LEGACY_IDEAS_KEY = "ideas";
const LEGACY_GRAVEYARD_KEY = "graveyard";
// Exported so the E2EE migration routes (status/reencrypt) mutate the SAME
// per-workspace keys the handlers do, instead of the dead legacy global keys.
export function ideasKey(workspaceId) { return `ideas:${workspaceId}`; }
export function graveyardKey(workspaceId) { return `graveyard:${workspaceId}`; }
const KINK_NUDGE_KEY_PREFIX = "kink-nudges";
const GRAVEYARD_PURGE_KEY = "_graveyard_purge_version";
const GRAVEYARD_PURGE_VERSION = "2026-05-18-clear";
const MAX_IDEAS = 300;
const MAX_GRAVEYARD = 300;
const MAX_TEXT_LENGTH = 1800;
const MAX_NOTE_LENGTH = 700;
const MAX_COMMENT_LENGTH = 700;
const MAX_COMMENTS = 80;
const MAX_TAGS = 8;
const MAX_HISTORY = 24;
const KINK_NUDGE_AFTER_MS = 24 * 60 * 60 * 1000;
const KINK_NUDGE_REPEAT_MS = 48 * 60 * 60 * 1000;
const KINK_NUDGE_STALE_MS = 72 * 60 * 60 * 1000;
const KINK_NUDGE_MIN_WAITING = 3;
const KINK_NUDGE_MAX_PER_WAITING_SET = 2;

// v1.0 locked Kink reaction vocabulary. Labels are API contract, not just UI.
// Keep the legacy `status` path accepting these exact labels while the v1 UI
// moves to the richer `reactions[]` objects.
const KINK_REACTIONS = [
  { id: "curious", glyph: "🤔", label: "Curious", tone: "positive", caption: "{name} is curious." },
  { id: "hell_yeah", glyph: "🔥", label: "Hell yeah", tone: "positive", caption: "{name} said hell yeah." },
  { id: "tell_me_more", glyph: "👀", label: "Tell me more", tone: "positive", caption: "{name} wants to hear more." },
  { id: "me_too", glyph: "🤤", label: "Me too", tone: "positive", caption: "{name} said me too." },
  { id: "give_me_a_minute", glyph: "💭", label: "Give me a minute", tone: "pause", caption: "{name} needs a minute on this." },
  { id: "not_for_me", glyph: "🌷", label: "Not for me — thank you for telling me", tone: "no", caption: "{name} passed, with grace." }
];
const KINK_REACTIONS_PUBLIC = KINK_REACTIONS.map(({ id, glyph, label, tone, caption }) => ({ id, glyph, label, tone, caption }));

const STATUS_ALIASES = {
  "Let's chat": "Tell me more",
  Maybe: "Curious",
  "Talk first": "Give me a minute",
  "Not now": "Curious",
  Approved: "Hell yeah",
  "I'm in": "Hell yeah",
  Later: "Curious",
  Sure: "Curious",
  No: "Not for me — thank you for telling me",
  "Not for me": "Not for me — thank you for telling me",
  "Not into it": "Not for me — thank you for telling me",
  notforme: "Not for me — thank you for telling me",
  hellyeah: "Hell yeah"
};
const DEFAULT_STATUS = "Curious";
const VALID_STATUSES = new Set(KINK_REACTIONS.map((reaction) => reaction.label));
const REACTION_BY_LABEL = new Map(KINK_REACTIONS.flatMap((reaction) => [
  [reaction.label.toLowerCase(), reaction],
  [reaction.id.toLowerCase(), reaction],
  [reaction.glyph, reaction]
]));
const VALID_TAGS = new Set([
  "soft", "rough", "quick", "slow", "romantic", "experimental",
  "talk-first", "needs-prep", "kink", "oral", "position", "roleplay"
]);

function fantasyStore(env) {
  return getStore(env, STORE_NAME);
}

function cleanIdeaText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

function cleanNote(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim().slice(0, MAX_NOTE_LENGTH);
}

function cleanCommentText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim().slice(0, MAX_COMMENT_LENGTH);
}

function cleanStatus(value) {
  const aliased = STATUS_ALIASES[value] || value;
  return VALID_STATUSES.has(aliased) ? aliased : DEFAULT_STATUS;
}

function reactionForValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const aliased = STATUS_ALIASES[raw] || raw;
  return REACTION_BY_LABEL.get(aliased.toLowerCase()) || REACTION_BY_LABEL.get(raw.toLowerCase()) || REACTION_BY_LABEL.get(raw) || null;
}

function reactionCaption(reaction, actorName) {
  const first = String(actorName || "Your partner").split(" ")[0] || "Your partner";
  return String(reaction?.caption || "").replace("{name}", first);
}

function cleanKinkReaction(input, actorEmail, actorName, now) {
  if (!input || typeof input !== "object") return null;
  if (!normalizeEmail(actorEmail)) return null;
  const canonical = reactionForValue(input.label) || reactionForValue(input.id) || reactionForValue(input.glyph);
  if (!canonical) return null;
  const encryptedNote = cleanRoomEncryptedBox(input.encryptedNote, 12000);
  const reaction = {
    by: actorEmail,
    id: canonical.id,
    glyph: canonical.glyph,
    label: canonical.label,
    caption: reactionCaption(canonical, actorName),
    tone: canonical.tone,
    note: encryptedNote ? "" : cleanNote(input.note),
    createdAt: input.createdAt || now,
    ...(input.seenByAuthorAt ? { seenByAuthorAt: input.seenByAuthorAt } : {})
  };
  if (encryptedNote) reaction.encryptedNote = encryptedNote;
  return reaction;
}

function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((tag) => String(tag || "").toLowerCase().trim()).filter((tag) => VALID_TAGS.has(tag)))].slice(0, MAX_TAGS);
}

function cleanNotes(notes) {
  if (!notes || typeof notes !== "object") return {};
  const result = {};
  Object.entries(notes).forEach(([email, value]) => {
    const cleanEmail = normalizeEmail(email);
    if (cleanEmail) result[cleanEmail] = cleanNote(value);
  });
  return result;
}

function cleanActorNotes(notes, actorEmail) {
  const email = normalizeEmail(actorEmail);
  if (!email) return {};
  if (typeof notes === "string") {
    const note = cleanNote(notes);
    return note ? { [email]: note } : {};
  }
  if (!notes || typeof notes !== "object") return {};
  const note = cleanNote(notes[email] || notes.myNote || notes.note || "");
  return note ? { [email]: note } : {};
}

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-MAX_HISTORY).map((entry) => ({
    email: normalizeEmail(entry?.email),
    name: cleanText(entry?.name, 80),
    status: cleanStatus(entry?.status),
    tone: reactionForValue(entry?.status)?.tone || "",
    glyph: reactionForValue(entry?.status)?.glyph || cleanText(entry?.glyph, 8),
    caption: cleanNote(entry?.caption),
    at: entry?.at || new Date().toISOString()
  }));
}

function stripAuthorSelfResponses({ history, reactions, addedByEmail }) {
  const author = normalizeEmail(addedByEmail);
  if (!author) return { history, reactions };
  return {
    history: (Array.isArray(history) ? history : []).filter((entry) => normalizeEmail(entry?.email) !== author),
    reactions: (Array.isArray(reactions) ? reactions : []).filter((reaction) => normalizeEmail(reaction?.by) !== author)
  };
}

function cleanComments(comments) {
  if (!Array.isArray(comments)) return [];
  return comments.slice(-MAX_COMMENTS).map((entry) => {
    const encryptedText = cleanRoomEncryptedBox(entry?.encryptedText, 12000);
    const text = encryptedText ? "Encrypted comment" : cleanCommentText(entry?.text);
    if (!text) return null;
    const comment = {
      id: cleanText(entry?.id, 64) || crypto.randomUUID(),
      email: normalizeEmail(entry?.email),
      name: cleanText(entry?.name, 80),
      text,
      at: entry?.at || new Date().toISOString()
    };
    const editedAt = cleanText(entry?.editedAt, 40);
    const editedByEmail = normalizeEmail(entry?.editedByEmail);
    const editedByName = cleanText(entry?.editedByName, 80);
    if (editedAt) comment.editedAt = editedAt;
    if (editedByEmail) comment.editedByEmail = editedByEmail;
    if (editedByName) comment.editedByName = editedByName;
    if (encryptedText) comment.encryptedText = encryptedText;
    return comment;
  }).filter(Boolean);
}

// Read-only legacy fallbacks: the bare global keys from before per-workspacing.
async function readLegacyIdeas(env) {
  try {
    const ideas = await fantasyStore(env).get(LEGACY_IDEAS_KEY, { type: "json" });
    return Array.isArray(ideas) ? ideas : [];
  } catch {
    return [];
  }
}

async function readLegacyGraveyard(env) {
  try {
    const graveyard = await fantasyStore(env).get(LEGACY_GRAVEYARD_KEY, { type: "json" });
    return Array.isArray(graveyard) ? graveyard : [];
  } catch {
    return [];
  }
}

async function readWorkspaceListRaw(env, key) {
  try {
    const value = await fantasyStore(env).get(key, { type: "json" });
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

// Read every idea/graveyard row visible to a set of workspace ids: union of the
// per-workspace keys PLUS a read-only fallback to the legacy global key
// (filtered to the same ids). De-duped by id with the per-workspace key winning.
function makeIdsReader(perWorkspaceKey, readLegacy) {
  return async function readForIds(env, workspaceIds) {
    const ids = workspaceIdSet(workspaceIds);
    const seen = new Set();
    const out = [];
    const lists = await Promise.all([...ids].map((id) => readWorkspaceListRaw(env, perWorkspaceKey(id))));
    for (const list of lists) {
      for (const row of list) {
        if (row && row.id && !seen.has(row.id)) { seen.add(row.id); out.push(row); }
      }
    }
    const legacy = await readLegacy(env);
    for (const row of legacy) {
      const wsId = row?.workspaceId || LEGACY_WORKSPACE_ID;
      if (ids.has(wsId) && row?.id && !seen.has(row.id)) { seen.add(row.id); out.push(row); }
    }
    return out;
  };
}

// Exported so the AI reaction routes (suggest / gentle-no) and the dashboard
// pulse read ideas through the SAME per-workspace key + legacy-fallback union
// the backlog uses, instead of the dead bare "ideas" key.
export const readIdeasForIds = makeIdsReader(ideasKey, readLegacyIdeas);
const readGraveyardForIds = makeIdsReader(graveyardKey, readLegacyGraveyard);

// Seed for the first per-workspace write while the legacy key still holds this
// workspace's rows (pre-migration).
async function legacyIdeasSeedFor(env, workspaceId) {
  return (await readLegacyIdeas(env)).filter((idea) => (idea?.workspaceId || LEGACY_WORKSPACE_ID) === workspaceId);
}
async function legacyGraveyardSeedFor(env, workspaceId) {
  return (await readLegacyGraveyard(env)).filter((idea) => (idea?.workspaceId || LEGACY_WORKSPACE_ID) === workspaceId);
}

// Stable structural comparison so a read-time migration only persists when it
// actually changed the stored bytes (avoids a write on every GET).
function sameRows(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Adopt + persist a read-time migration for ONE workspace's list. When the
// migrated (cleaned) rows differ from what is physically stored — because the
// per-workspace key is still empty and legacy holds un-cleaned rows, or a
// legacy row carried author-self response noise that migrate() strips — write
// the cleaned rows to the per-workspace key (adoption). The legacy global key is
// never written: it is a read-only fallback + one-time adoption seed, retired by
// the offline migration (scripts/migrate-store-keys.mjs). Idempotent: a
// steady-state GET whose stored rows already equal their migrated form performs
// no write. Returns the cleaned rows for this workspace.
async function persistMigratedList(env, { perKey, legacySeedFor, workspaceId, legacyPeople, max }) {
  const stored = await readWorkspaceListRaw(env, perKey(workspaceId));
  const legacySlice = await legacySeedFor(env, workspaceId);
  const sourceRaw = stored.length ? stored : legacySlice;
  const cleaned = sourceRaw.map((row) => migrate(row, legacyPeople));

  const perChanged = !sameRows(stored, cleaned);
  if (perChanged) {
    await mutateKey(env, STORE_NAME, perKey(workspaceId), (raw) => {
      const base = Array.isArray(raw) && raw.length ? raw : sourceRaw;
      const fresh = base.map((row) => migrate(row, legacyPeople));
      return { value: fresh.slice(0, max), result: fresh };
    });
  }

  return cleaned;
}

async function purgeGraveyardIfStale(env) {
  try {
    const store = fantasyStore(env);
    const recorded = await store.get(GRAVEYARD_PURGE_KEY, { type: "text" });
    if (recorded === GRAVEYARD_PURGE_VERSION) return;
    // One-time deliberate wipe of the legacy global graveyard (its original
    // target before per-workspacing). Per-workspace graveyards are unaffected.
    await store.setJSON(LEGACY_GRAVEYARD_KEY, []);
    await store.set(GRAVEYARD_PURGE_KEY, GRAVEYARD_PURGE_VERSION);
  } catch {
    // Best effort.
  }
}

function legacyNotesToEmails(notes, legacyPeople = {}) {
  if (!notes || typeof notes !== "object") return {};
  const result = {};
  Object.entries(notes).forEach(([key, value]) => {
    const email = key.includes("@") ? normalizeEmail(key) : legacyEmailForName(key, legacyPeople);
    if (email) result[email] = cleanNote(value);
  });
  return result;
}

function sameMoment(a, b) {
  if (!a || !b) return false;
  const ams = new Date(a).getTime();
  const bms = new Date(b).getTime();
  if (!Number.isFinite(ams) || !Number.isFinite(bms)) return false;
  return Math.abs(ams - bms) <= 5 * 60 * 1000;
}

function isAuthorSeedReaction({ addedByEmail, statusByEmail, status, history, createdAt, statusAt }) {
  const author = normalizeEmail(addedByEmail);
  const setter = normalizeEmail(statusByEmail);
  if (!author || author !== setter) return false;
  if (status !== DEFAULT_STATUS) return false;
  if (!Array.isArray(history) || history.length !== 1) return false;
  const [entry] = history;
  if (normalizeEmail(entry?.email) !== author) return false;
  if (cleanStatus(entry?.status) !== DEFAULT_STATUS) return false;
  const at = entry?.at || statusAt || "";
  return !createdAt || sameMoment(at, createdAt) || sameMoment(statusAt, createdAt);
}

function migrate(idea, legacyPeople = {}) {
  const statusByEmail = idea.statusByEmail
    || legacyEmailForName(idea.statusBy, legacyPeople);
  const addedByEmail = idea.addedByEmail
    || legacyEmailForName(idea.addedBy, legacyPeople);

  const normalizedAddedByEmail = normalizeEmail(addedByEmail);
  const normalizedSetterEmail = normalizeEmail(statusByEmail);
  const setterName = idea.statusByName || idea.statusBy || legacyNameForEmail(statusByEmail, legacyPeople) || "";
  const hasExplicitStatus = typeof idea.status === "string" && idea.status.trim();
  const normalizedStatus = hasExplicitStatus ? cleanStatus(idea.status) : "";
  const encryptedText = cleanRoomEncryptedBox(idea.encryptedText, 12000);
  let history = cleanHistory(idea.statusHistory);

  if (normalizedSetterEmail && normalizedStatus && !history.some((entry) => entry.email === normalizedSetterEmail)) {
    history = [
      ...history,
      {
        email: normalizedSetterEmail,
        name: setterName,
        status: normalizedStatus,
        at: idea.statusAt || idea.updatedAt || idea.createdAt || new Date().toISOString()
      }
    ];
  }

  const createdAt = idea.createdAt || new Date().toISOString();
  const clearAuthorSeed = isAuthorSeedReaction({
    addedByEmail: normalizedAddedByEmail,
    statusByEmail: normalizedSetterEmail,
    status: normalizedStatus,
    history,
    createdAt,
    statusAt: idea.statusAt || idea.updatedAt || createdAt
  });

  const cleanedReactions = Array.isArray(idea.reactions)
    ? idea.reactions.map((reaction) => cleanKinkReaction(
	      reaction,
	      normalizeEmail(reaction?.by),
	      reaction?.name || legacyNameForEmail(reaction?.by, legacyPeople) || "",
	      reaction?.createdAt || idea.updatedAt || createdAt
    )).filter(Boolean).slice(-12)
    : [];
  const withoutAuthorSelf = stripAuthorSelfResponses({
    history: clearAuthorSeed ? [] : history,
    reactions: cleanedReactions,
    addedByEmail: normalizedAddedByEmail
  });

  const migrated = {
    ...idea,
    workspaceId: idea.workspaceId || LEGACY_WORKSPACE_ID,
    text: encryptedText ? "Encrypted kink" : cleanIdeaText(idea.text),
    addedByEmail: normalizedAddedByEmail,
    addedByName: idea.addedByName || idea.addedBy || legacyNameForEmail(addedByEmail, legacyPeople) || "",
    notes: cleanNotes(legacyNotesToEmails(idea.notes, legacyPeople)),
    tags: cleanTags(idea.tags),
    comments: cleanComments(idea.comments),
    reactions: withoutAuthorSelf.reactions,
    statusHistory: withoutAuthorSelf.history,
    createdAt,
    updatedAt: idea.updatedAt || createdAt
  };
  if (encryptedText) migrated.encryptedText = encryptedText;
  else delete migrated.encryptedText;

  if (clearAuthorSeed || !normalizedStatus || !normalizedSetterEmail || normalizedSetterEmail === normalizedAddedByEmail) {
    delete migrated.status;
    delete migrated.statusByEmail;
    delete migrated.statusByName;
    delete migrated.statusAt;
  } else {
    migrated.status = normalizedStatus;
    migrated.statusByEmail = normalizedSetterEmail;
    migrated.statusByName = setterName;
    migrated.statusAt = idea.statusAt || idea.updatedAt || createdAt;
  }

  return migrated;
}

function workspaceIdSet(workspaceIds) {
  return new Set((Array.isArray(workspaceIds) ? workspaceIds : [workspaceIds]).filter(Boolean));
}

// De-dupe a flattened set of per-workspace slices by row id (first wins). Used
// to recombine the persisted-migration slices the GET handler produces.
function dedupeById(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (row && row.id && !seen.has(row.id)) { seen.add(row.id); out.push(row); }
  }
  return out;
}

function forWorkspace(ideas, workspaceIds) {
  const ids = workspaceIdSet(workspaceIds);
  return ideas.filter((idea) => ids.has(idea.workspaceId));
}

// A per-workspace write returns only the written workspace's rows. Recombine
// them with the rest of the data-access set (e.g. legacy-couple rows under a
// different key, from the earlier scoped read) so the response stays complete.
function recombineRows(allRows, writtenWorkspaceId, writtenRows) {
  return [...allRows.filter((row) => row.workspaceId !== writtenWorkspaceId), ...writtenRows];
}

function publicNotesFor(idea, actorEmail) {
  const notes = idea?.notes && typeof idea.notes === "object" ? idea.notes : {};
  const actor = normalizeEmail(actorEmail);
  const result = {};
  if (actor && notes[actor]) result[actor] = cleanNote(notes[actor]);
  if (typeof notes._reactions === "string") result._reactions = notes._reactions;
  return result;
}

function publicIdea(idea, actorEmail) {
  return {
    ...idea,
    notes: publicNotesFor(idea, actorEmail)
  };
}

function publicForWorkspace(ideas, workspaceIds, actorEmail) {
  return forWorkspace(ideas, workspaceIds).map((idea) => publicIdea(idea, actorEmail));
}

function roomE2eeRequired(workspace) {
  return Boolean(workspace?.settings?.roomE2eeEnabled);
}

function safeTimeMs(value) {
  const ms = new Date(value || "").getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function kinkNudgeKey(workspaceId) {
  return `${KINK_NUDGE_KEY_PREFIX}:${cleanText(workspaceId, 120)}`;
}

async function readKinkNudgeState(env, workspaceId) {
  try {
    const state = await fantasyStore(env).get(kinkNudgeKey(workspaceId), { type: "json" });
    return state && typeof state === "object" && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

async function writeKinkNudgeState(env, workspaceId, state) {
  await fantasyStore(env).setJSON(kinkNudgeKey(workspaceId), state && typeof state === "object" ? state : {});
}

function activeWorkspaceMembers(workspace) {
  return (Array.isArray(workspace?.members) ? workspace.members : [])
    .filter((member) => member?.status === "active" && normalizeEmail(member?.email))
		.map((member) => ({
		  email: normalizeEmail(member.email),
		  name: cleanText(member.displayName || member.name, 80)
		}));
}

function kinkCreatedMs(idea) {
  return safeTimeMs(idea?.createdAt || idea?.updatedAt);
}

function hasKinkResponseFrom(idea, email) {
  const actor = normalizeEmail(email);
  if (!actor) return false;

  const history = Array.isArray(idea?.statusHistory) ? idea.statusHistory : [];
  if (history.some((entry) => normalizeEmail(entry?.email) === actor)) return true;

  const reactions = Array.isArray(idea?.reactions) ? idea.reactions : [];
  if (reactions.some((reaction) => normalizeEmail(reaction?.by) === actor)) return true;

  const comments = Array.isArray(idea?.comments) ? idea.comments : [];
  if (comments.some((comment) => normalizeEmail(comment?.email) === actor)) return true;

  return normalizeEmail(idea?.statusByEmail) === actor;
}

function waitingKinksForMember(ideas, workspaceIds, email, nowMs = Date.now()) {
  const recipient = normalizeEmail(email);
  if (!recipient) return [];
  return forWorkspace(Array.isArray(ideas) ? ideas : [], workspaceIds)
    .filter((idea) => {
      if (normalizeEmail(idea?.addedByEmail) === recipient) return false;
      const created = kinkCreatedMs(idea);
      return created > 0 && created <= nowMs && !hasKinkResponseFrom(idea, recipient);
    })
    .sort((a, b) => kinkCreatedMs(a) - kinkCreatedMs(b));
}

function kinkNudgeDue(waiting, stateForRecipient, nowMs) {
  if (!Array.isArray(waiting) || waiting.length < 1) return null;
  const oldest = waiting[0];
  const oldestMs = kinkCreatedMs(oldest);
  if (!oldestMs || nowMs - oldestMs < KINK_NUDGE_AFTER_MS) return null;

  const hasBatch = waiting.length >= KINK_NUDGE_MIN_WAITING;
  const hasStale = nowMs - oldestMs >= KINK_NUDGE_STALE_MS;
  if (!hasBatch && !hasStale) return null;

  const lastNudgedMs = safeTimeMs(stateForRecipient?.lastNudgedAt);
  if (lastNudgedMs && nowMs - lastNudgedMs < KINK_NUDGE_REPEAT_MS) return null;

  const newestMs = waiting.reduce((latest, idea) => Math.max(latest, kinkCreatedMs(idea)), 0);
  const previousNewestMs = safeTimeMs(stateForRecipient?.newestAt);
  const hasNewWaiting = Boolean(previousNewestMs && newestMs > previousNewestMs);
  const previousCount = hasNewWaiting
    ? 0
    : Number(stateForRecipient?.nudgeCount || (lastNudgedMs ? 1 : 0));
  if (previousCount >= KINK_NUDGE_MAX_PER_WAITING_SET) return null;

  return {
    reason: hasBatch ? "batch" : "stale",
    waitingCount: waiting.length,
    oldestAt: new Date(oldestMs).toISOString(),
    newestAt: newestMs ? new Date(newestMs).toISOString() : "",
    nudgeCount: previousCount + 1,
    actorEmail: normalizeEmail(oldest?.addedByEmail),
    actorName: cleanText(oldest?.addedByName, 80),
    waitingIds: waiting.map((idea) => cleanText(idea?.id, 64)).filter(Boolean).slice(0, 12)
  };
}

function deliveryReason(results) {
  if (Array.isArray(results) && results.some((result) => result?.ok)) return "delivered";
  const reason = Array.isArray(results) ? results.find((result) => result?.reason)?.reason : "";
  return reason || "unknown";
}

export async function processKinkNudges(context, workspace, activeViewerEmail, ideas, workspaceIds, now = new Date()) {
  const env = context?.env || context;
  const workspaceId = workspace?.id;
  if (!env || !workspaceId) return [];

  const nowMs = now instanceof Date ? now.getTime() : safeTimeMs(now);
  if (!Number.isFinite(nowMs) || nowMs <= 0) return [];

  const state = await readKinkNudgeState(env, workspaceId);
  const activeViewer = normalizeEmail(activeViewerEmail);
  const members = activeWorkspaceMembers(workspace);
  const results = [];
  let mutated = false;

  for (const member of members) {
    const recipientEmail = normalizeEmail(member.email);
    const waiting = waitingKinksForMember(ideas, workspaceIds || workspaceId, recipientEmail, nowMs);
    const due = kinkNudgeDue(waiting, state[recipientEmail], nowMs);
    if (!due) continue;

    let notifyResults = [];
    if (recipientEmail === activeViewer) {
      notifyResults = [{ ok: false, suppressed: true, reason: "recipient-active", tag: "kink-nudge", targets: [recipientEmail] }];
    } else {
      notifyResults = await notifyWorkspaceEvent(context, workspaceId, due.actorEmail || activeViewer, {
        title: "Sexualsync",
        body: "Something is waiting in your room.",
        tag: "kink-nudge",
        url: "/inspiration",
        onlyEmail: recipientEmail
      });
    }

    if (!isNotificationSatisfied(notifyResults)) {
      results.push({ recipientEmail, ok: false, reason: deliveryReason(notifyResults), waitingCount: due.waitingCount });
      continue;
    }

    const handledAt = new Date(nowMs).toISOString();
    const delivery = deliveryReason(notifyResults);
    state[recipientEmail] = {
      lastNudgedAt: handledAt,
      waitingCount: due.waitingCount,
      oldestAt: due.oldestAt,
      newestAt: due.newestAt,
      reason: due.reason,
      delivery,
      nudgeCount: due.nudgeCount,
      waitingIds: due.waitingIds
    };
    mutated = true;
    results.push({ recipientEmail, ok: true, reason: due.reason, delivery, waitingCount: due.waitingCount });

    await appendAudit(env, workspaceId, {
      type: "fantasy_nudge_sent",
      actorEmail: due.actorEmail || activeViewer || "",
      actorName: due.actorName || "Sexualsync",
      entityType: "fantasy",
      entityId: due.waitingIds[0] || "",
      metadata: {
        recipient: recipientEmail,
        waitingCount: due.waitingCount,
        reason: due.reason,
        delivery,
        nudgeCount: due.nudgeCount
      }
    });
  }

  if (mutated) await writeKinkNudgeState(env, workspaceId, state);
  return results;
}

export function scheduleKinkNudges(context, workspace, activeViewerEmail, ideas, workspaceIds, now = new Date()) {
  const task = processKinkNudges(context, workspace, activeViewerEmail, ideas, workspaceIds, now).catch(() => []);
  if (context && typeof context.waitUntil === "function") context.waitUntil(task);
  return task;
}

// An archived idea is tombstoned in the graveyard but must NEVER reappear as
// active. makeIdsReader unions the per-workspace ideas key with a read-only
// fallback to the legacy global "ideas" key; archiving removes the idea from
// the per-workspace key (and tombstones it in the graveyard) but deliberately
// does not rewrite the legacy key — so a stale legacy row for an archived idea
// would otherwise be resurrected on the next read (the "I archived them but
// they still show" bug). Enforce the invariant at every read boundary that has
// both lists in hand: active ideas = ideas minus everything in the graveyard.
function dropTombstonedIdeas(ideas, graveyard) {
  if (!ideas.length || !graveyard.length) return ideas;
  const tombstoned = new Set(graveyard.map((idea) => idea && idea.id).filter(Boolean));
  return tombstoned.size ? ideas.filter((idea) => !tombstoned.has(idea.id)) : ideas;
}

export async function readFantasyBacklogForWorkspace(env, workspaceId, actorEmail, options = {}) {
  const workspaceIds = options.workspaceIds || workspaceId;
  const [rawIdeas, rawGraveyard] = await Promise.all([
    readIdeasForIds(env, workspaceIds),
    readGraveyardForIds(env, workspaceIds)
  ]);
  const legacyPeople = options.legacyPeople || await legacyPeopleForEnv(env);
  const ideas = rawIdeas.map((idea) => migrate(idea, legacyPeople));
  const graveyard = rawGraveyard.map((idea) => migrate(idea, legacyPeople));
  return {
    workspaceId,
    reactionCatalog: KINK_REACTIONS_PUBLIC,
    ideas: publicForWorkspace(dropTombstonedIdeas(ideas, graveyard), workspaceIds, actorEmail),
    graveyard: publicForWorkspace(graveyard, workspaceIds, actorEmail)
  };
}

export async function onRequest(context) {
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;

  const env = context.env;
  const legacyPeople = await legacyPeopleForEnv(env);
  const request = context.request;
  const method = request.method.toUpperCase();
  const queryWorkspace = workspaceIdFromRequest(request);

  await purgeGraveyardIfStale(env);

  // Per-workspace keying means we read scoped to the caller's data-access set,
  // so authorize first. Migration normalization still runs on every read
  // (in-memory) and inside every atomic write transform, so the previous eager
  // whole-list rewrite-on-read is no longer needed (and couldn't span multiple
  // per-workspace keys cheaply).

  if (method === "GET") {
    const access = await authorizeWorkspaceAccess(context, identity, queryWorkspace);
    if (!access.ok) return access.response;
    const dataWorkspaceIds = access.dataWorkspaceIds;
    // Read-time migration is PERSISTED here (the GET handler is the canonical
    // mutating reader for the fantasy board): for each workspace in the access
    // set, adopt legacy rows into the per-workspace key and strip author-self
    // response noise. The write targets ONLY the per-workspace key; the legacy
    // global key is read-only (fallback + adoption seed). Idempotent — a
    // steady-state GET whose stored rows already match their migrated form
    // performs no write. (bootstrap.js reads via the pure
    // readFantasyBacklogForWorkspace and must not mutate, so this lives in the
    // handler, not the shared reader.)
    const ids = [...workspaceIdSet(dataWorkspaceIds)];
    const ideaSlices = await Promise.all(ids.map((wsId) => persistMigratedList(env, {
      perKey: ideasKey, legacySeedFor: legacyIdeasSeedFor,
      workspaceId: wsId, legacyPeople, max: MAX_IDEAS
    })));
    const graveSlices = await Promise.all(ids.map((wsId) => persistMigratedList(env, {
      perKey: graveyardKey, legacySeedFor: legacyGraveyardSeedFor,
      workspaceId: wsId, legacyPeople, max: MAX_GRAVEYARD
    })));
    const ideas = dedupeById(ideaSlices.flat());
    const graveyard = dedupeById(graveSlices.flat());
    const liveIdeas = dropTombstonedIdeas(ideas, graveyard);
    scheduleKinkNudges(context, access.workspace, identity.email, liveIdeas, dataWorkspaceIds);
    return jsonResponse(200, {
      workspaceId: access.workspace.id,
      reactionCatalog: KINK_REACTIONS_PUBLIC,
      ideas: publicForWorkspace(liveIdeas, dataWorkspaceIds, identity.email),
      graveyard: publicForWorkspace(graveyard, dataWorkspaceIds, identity.email)
    });
  }

  if (!["POST", "PATCH", "DELETE"].includes(method)) {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  let payload = {};
  try { payload = await request.json(); }
  catch { return jsonResponse(400, { error: "Expected JSON body" }); }

  const access = await authorizeWorkspaceAccess(context, identity, workspaceIdFromPayload(payload, queryWorkspace));
  if (!access.ok) return access.response;

  const workspace = access.workspace;
  const actorEmail = identity.email;
  const actorName = access.actorName;
  const dataWorkspaceIds = access.dataWorkspaceIds;
  const now = new Date().toISOString();
  const idempotencyKey = cleanIdempotencyKey(request.headers.get("idempotency-key"));
  const ideas = (await readIdeasForIds(env, dataWorkspaceIds)).map((idea) => migrate(idea, legacyPeople));
  const graveyard = (await readGraveyardForIds(env, dataWorkspaceIds)).map((idea) => migrate(idea, legacyPeople));
  const limited = await checkRateLimit(env, {
    bucket: `fantasy-${method}`,
    key: `${actorEmail}:${workspace.id}`,
    limit: 80,
    windowSeconds: 5 * 60
  });
  if (!limited.ok) return rateLimitResponse(limited.retryAfter);

  if (method === "POST") {
    const encryptedText = cleanRoomEncryptedBox(payload.encryptedText, 12000);
    if (roomE2eeRequired(workspace) && !encryptedText) {
      return jsonResponse(400, { error: "Room Encryption requires encrypted Idea text." });
    }
    const text = encryptedText ? "Encrypted kink" : cleanIdeaText(payload.text);
    if (!text) return jsonResponse(400, { error: "Idea text is required" });

    // Author status: only seed if the client explicitly sent one. Default
    // POSTs (no payload.status) leave the author unreacted to their own
    // post — which is the truthful state. The partner's view will show
    // "shared this" instead of a fake "Tell me more" reaction.
    const explicitStatus = (typeof payload.status === "string" && payload.status.trim())
      ? cleanStatus(payload.status)
      : null;

    const ideaId = idempotencyKey
      ? await idempotentId({
          namespace: "fantasy:create",
          key: idempotencyKey,
          prefix: "idea",
          workspaceId: workspace.id,
          actorEmail
        })
      : crypto.randomUUID();
    const existingReplay = ideaId
      ? ideas.find((candidate) => candidate.id === ideaId && dataWorkspaceIds.includes(candidate.workspaceId))
      : null;
    if (existingReplay) {
      return jsonResponse(200, {
        idea: publicIdea(existingReplay, actorEmail),
        reactionCatalog: KINK_REACTIONS_PUBLIC,
        ideas: publicForWorkspace(ideas, dataWorkspaceIds, actorEmail),
        graveyard: publicForWorkspace(graveyard, dataWorkspaceIds, actorEmail),
        workspaceId: workspace.id,
        idempotent: true
      });
    }

    const idea = {
      id: ideaId,
      workspaceId: workspace.id,
      text,
      tags: cleanTags(payload.tags),
      // status / statusByEmail / statusAt remain undefined when the author
      // didn't pre-react. Downstream code (publicIdea, fantasyStatusByEmail)
      // already handles missing values via the alias/default machinery.
      ...(explicitStatus ? {
        status: explicitStatus,
        statusByEmail: actorEmail,
        statusByName: actorName,
        statusAt: now,
      } : {}),
      addedByEmail: actorEmail,
      addedByName: actorName,
      notes: cleanActorNotes(payload.notes, actorEmail),
      comments: cleanComments(payload.comments),
      // Only include the author in statusHistory if they explicitly reacted.
      statusHistory: explicitStatus ? [{
        email: actorEmail,
        name: actorName,
        status: explicitStatus,
        at: now
      }] : [],
      createdAt: now,
      updatedAt: now
    };
    if (encryptedText) idea.encryptedText = encryptedText;

    // Prepend atomically against THIS workspace's fresh snapshot so a concurrent
    // partner POST or PATCH composes instead of clobbering (mirrors the PATCH
    // path below). The per-workspace key is seeded read-only from the legacy
    // global list (filtered to this workspace) when still empty (pre-migration).
    const ideasSeed = await legacyIdeasSeedFor(env, workspace.id);
    const writtenIdeas = await mutateKey(env, STORE_NAME, ideasKey(workspace.id), (current) => {
      const base = Array.isArray(current) && current.length ? current : ideasSeed;
      const list = base.map(migrate);
      const capped = [idea, ...list].slice(0, MAX_IDEAS);
      return { value: capped, result: capped };
    });
    const next = recombineRows(ideas, workspace.id, writtenIdeas);
    await appendAudit(env, workspace.id, {
      type: "fantasy_created",
      actorEmail,
      actorName,
      entityType: "fantasy",
      entityId: idea.id,
      metadata: { tagCount: idea.tags.length }
    });
    broadcastRoomEvent(context, workspace.id, {
      resource: "fantasy-backlog",
      action: "created",
      entityId: idea.id,
      actorEmail,
      actorName,
    });

    return jsonResponse(201, {
      idea: publicIdea(idea, actorEmail),
      reactionCatalog: KINK_REACTIONS_PUBLIC,
      ideas: publicForWorkspace(next, dataWorkspaceIds, actorEmail),
      graveyard: publicForWorkspace(graveyard, dataWorkspaceIds, actorEmail),
      workspaceId: workspace.id
    });
  }

  const id = cleanText(payload.id, 64);

  if (method === "PATCH") {
    if (payload.action === "focused") {
      const idea = ideas.find((candidate) => candidate.id === id && dataWorkspaceIds.includes(candidate.workspaceId));
      if (!idea) return jsonResponse(404, { error: "Idea not found" });
      const focus = await broadcastFocusRoomEvent(context, workspace.id, {
        resource: "fantasy-backlog",
        entityId: idea.id,
        actorEmail,
        actorName,
        at: now,
      });
      return jsonResponse(200, {
        workspaceId: workspace.id,
        ...focus
      });
    }

    if (payload.action === "restore") {
      // Locate which workspace's graveyard the target lives in (from the scoped
      // read) so both the graveyard removal and the ideas insert hit that
      // workspace's per-workspace keys.
      const graveTarget = graveyard.find((idea) => idea.id === id && dataWorkspaceIds.includes(idea.workspaceId));
      if (!graveTarget) return jsonResponse(404, { error: "Idea not found" });
      if (normalizeEmail(graveTarget.addedByEmail) !== actorEmail) {
        return jsonResponse(403, { error: "Only the fantasy's author can restore it." });
      }
      const targetWorkspaceId = graveTarget.workspaceId;
      const graveyardSeed = await legacyGraveyardSeedFor(env, targetWorkspaceId);
      // Remove from the graveyard atomically, deriving the restored idea from
      // the fresh snapshot so a concurrent graveyard mutation can't clobber.
      const graveyardResult = await mutateKey(env, STORE_NAME, graveyardKey(targetWorkspaceId), (current) => {
        const base = Array.isArray(current) && current.length ? current : graveyardSeed;
        const list = base.map(migrate);
        const idx = list.findIndex((idea) => idea.id === id && dataWorkspaceIds.includes(idea.workspaceId));
        if (idx === -1) {
          return { write: false, result: { found: false } };
        }
        if (normalizeEmail(list[idx].addedByEmail) !== actorEmail) {
          return { write: false, result: { found: true, forbidden: true } };
        }
        const restored = {
          ...list[idx],
          restoredByEmail: actorEmail,
          restoredByName: actorName,
          restoredAt: now,
          updatedAt: now
        };
        delete restored.deletedAt;
        delete restored.deletedByEmail;
        delete restored.deletedByName;
        const nextGraveyard = list.filter((idea, i) => i !== idx).slice(0, MAX_GRAVEYARD);
        return { value: nextGraveyard, result: { found: true, restored, nextGraveyard } };
      });
      if (!graveyardResult.found) return jsonResponse(404, { error: "Idea not found" });
      if (graveyardResult.forbidden) {
        return jsonResponse(403, { error: "Only the fantasy's author can restore it." });
      }

      const restored = graveyardResult.restored;
      const writtenGraveyard = graveyardResult.nextGraveyard;
      const ideasSeed = await legacyIdeasSeedFor(env, targetWorkspaceId);
      // Prepend to ideas atomically, against that workspace's own fresh snapshot.
      const writtenIdeas = await mutateKey(env, STORE_NAME, ideasKey(targetWorkspaceId), (current) => {
        const base = Array.isArray(current) && current.length ? current : ideasSeed;
        const list = base.map(migrate);
        const capped = [restored, ...list].slice(0, MAX_IDEAS);
        return { value: capped, result: capped };
      });
      const nextIdeas = recombineRows(ideas, targetWorkspaceId, writtenIdeas);
      const nextGraveyard = recombineRows(graveyard, targetWorkspaceId, writtenGraveyard);
      await appendAudit(env, workspace.id, {
        type: "fantasy_restored",
        actorEmail,
        actorName,
        entityType: "fantasy",
        entityId: restored.id
      });
      broadcastRoomEvent(context, workspace.id, {
        resource: "fantasy-backlog",
        action: "restored",
        entityId: restored.id,
        actorEmail,
        actorName,
      });

      return jsonResponse(200, {
        idea: publicIdea(restored, actorEmail),
        reactionCatalog: KINK_REACTIONS_PUBLIC,
        ideas: publicForWorkspace(nextIdeas, dataWorkspaceIds, actorEmail),
        graveyard: publicForWorkspace(nextGraveyard, dataWorkspaceIds, actorEmail),
        workspaceId: workspace.id
      });
    }

    const index = ideas.findIndex((idea) => idea.id === id && dataWorkspaceIds.includes(idea.workspaceId));
    if (index === -1) return jsonResponse(404, { error: "Idea not found" });

    const existing = ideas[index];

    // Validate against the locally-read snapshot (ownership is immutable, so
    // ownership-gated checks are safe to evaluate against `existing`). The
    // resulting plan describes the change without mutating any state; it is
    // applied atomically against a fresh snapshot inside mutateKey so a
    // concurrent partner reaction or comment isn't clobbered.
    let statusPlan = null;
    let tagsPlan = null;
    let notesPlan = null;
    let commentPlan = null;
    let commentEditPlan = null;
    let ackReactionsPlan = false;
    let reactionsPlan = null;
    let textPlan = null;
    const payloadAction = cleanText(payload.action, 40);

    if (Object.prototype.hasOwnProperty.call(payload, "status")) {
      if (normalizeEmail(existing.addedByEmail) === actorEmail) {
        return jsonResponse(400, { error: "You don't react to your own Idea." });
      }
      const status = cleanStatus(payload.status);
      const reaction = reactionForValue(status);
      statusPlan = {
        status,
        tone: reaction?.tone || "",
        glyph: reaction?.glyph || "",
        caption: reaction ? reactionCaption(reaction, actorName) : ""
      };
    }

    if (Object.prototype.hasOwnProperty.call(payload, "tags")) {
      tagsPlan = cleanTags(payload.tags);
    }

    if (Object.prototype.hasOwnProperty.call(payload, "notes")) {
      const incomingNotes = cleanActorNotes(payload.notes, actorEmail);
      if (!Object.keys(incomingNotes).length) {
        return jsonResponse(400, { error: "Use your own note field when updating notes." });
      }
      notesPlan = incomingNotes;
    }

    if (Object.prototype.hasOwnProperty.call(payload, "comment") && payloadAction === "update_comment") {
      const commentId = cleanText(payload.commentId, 64);
      if (!commentId) return jsonResponse(400, { error: "Comment id is required" });
      const encryptedComment = cleanRoomEncryptedBox(payload.encryptedComment, 12000);
      if (roomE2eeRequired(workspace) && !encryptedComment) {
        return jsonResponse(400, { error: "Room Encryption requires encrypted comments." });
      }
      const commentText = encryptedComment ? "Encrypted comment" : cleanCommentText(payload.comment);
      if (!commentText) return jsonResponse(400, { error: "Comment text is required" });
      commentEditPlan = {
        id: commentId,
        text: commentText,
        encryptedText: encryptedComment || null
      };
    } else if (Object.prototype.hasOwnProperty.call(payload, "comment")) {
      const encryptedComment = cleanRoomEncryptedBox(payload.encryptedComment, 12000);
      if (roomE2eeRequired(workspace) && !encryptedComment) {
        return jsonResponse(400, { error: "Room Encryption requires encrypted comments." });
      }
      const commentText = encryptedComment ? "Encrypted comment" : cleanCommentText(payload.comment);
      if (!commentText) return jsonResponse(400, { error: "Comment text is required" });
      const commentId = idempotencyKey
        ? await idempotentId({
            namespace: "fantasy:comment",
            key: idempotencyKey,
            prefix: "comment",
            workspaceId: existing.workspaceId,
            actorEmail,
            entityId: existing.id
          })
        : crypto.randomUUID();
      commentPlan = {
        id: commentId,
        email: actorEmail,
        name: actorName,
        text: commentText,
        at: now
      };
      if (encryptedComment) commentPlan.encryptedText = encryptedComment;
    }

    if (Object.prototype.hasOwnProperty.call(payload, "ackReactions")) {
      // v2 · Sprint E · Only the original author may ack reactions on their
      // own fantasy. Silently ignored otherwise so the partner can no-op-call
      // this on shared list refreshes.
      if (normalizeEmail(existing.addedByEmail) === actorEmail) {
        ackReactionsPlan = true;
      }
    }

    if (Object.prototype.hasOwnProperty.call(payload, "reactions")) {
      if (normalizeEmail(existing.addedByEmail) === actorEmail) {
        return jsonResponse(400, { error: "You don't react to your own Idea." });
      }
      const incoming = Array.isArray(payload.reactions) ? payload.reactions : [];
      const mine = incoming
        .filter((r) => normalizeEmail(r.by) === actorEmail)
        .slice(-1);
      if (mine.some((r) => roomE2eeRequired(workspace) && cleanNote(r.note) && !cleanRoomEncryptedBox(r.encryptedNote, 12000))) {
        return jsonResponse(400, { error: "Room Encryption requires encrypted reaction notes." });
      }
      reactionsPlan = mine
        .map((r) => cleanKinkReaction(r, actorEmail, actorName, now))
        .filter(Boolean);
    }

    if (Object.prototype.hasOwnProperty.call(payload, "text")) {
      if (normalizeEmail(existing.addedByEmail) !== normalizeEmail(actorEmail)) {
        return jsonResponse(403, { error: "Only the fantasy's author can edit it." });
      }
      const encryptedText = cleanRoomEncryptedBox(payload.encryptedText, 12000);
      if (roomE2eeRequired(workspace) && !encryptedText) {
        return jsonResponse(400, { error: "Room Encryption requires encrypted Idea text." });
      }
      const nextText = encryptedText ? "Encrypted kink" : cleanIdeaText(payload.text);
      if (!nextText) return jsonResponse(400, { error: "Fantasy text can't be empty." });
      textPlan = { text: nextText, encryptedText };
    }

    // Apply the plan atomically. mutateKey routes through the StateStore DO
    // CAS coordinator when bound; otherwise it falls back to plain KV
    // read-modify-write with the same data shape. Either way the read of
    // `base` inside the transform is the version the write commits against,
    // so concurrent partner edits compose instead of clobbering.
    const patchIdeasSeed = await legacyIdeasSeedFor(env, existing.workspaceId);
    const casResult = await mutateKey(env, STORE_NAME, ideasKey(existing.workspaceId), (current) => {
      const list = (Array.isArray(current) && current.length ? current : patchIdeasSeed).map(migrate);
      const idx = list.findIndex((idea) => idea.id === id && dataWorkspaceIds.includes(idea.workspaceId));
      if (idx === -1) {
        return { value: list, result: { found: false } };
      }
      const base = list[idx];
      const updates = { ...base };
      const baseComments = cleanComments(base.comments);
      const replayedComment = Boolean(commentPlan && baseComments.some((comment) => comment.id === commentPlan.id));
      if (
        replayedComment
        && !statusPlan
        && tagsPlan === null
        && !notesPlan
        && !commentEditPlan
        && !ackReactionsPlan
        && !reactionsPlan
        && textPlan === null
      ) {
        return {
          write: false,
          result: { found: true, updated: base, next: list, replayedComment: true }
        };
      }

      if (statusPlan) {
        updates.status = statusPlan.status;
        updates.statusByEmail = actorEmail;
        updates.statusByName = actorName;
        updates.statusAt = now;
        updates.statusHistory = [
          ...(base.statusHistory || []),
          {
            email: actorEmail,
            name: actorName,
            status: statusPlan.status,
            tone: statusPlan.tone,
            glyph: statusPlan.glyph,
            caption: statusPlan.caption,
            at: now
          }
        ].slice(-MAX_HISTORY);
      }

      if (tagsPlan !== null) {
        updates.tags = tagsPlan;
      }

      if (notesPlan) {
        updates.notes = { ...(base.notes || {}), ...notesPlan };
        updates.notesUpdatedAt = now;
        updates.notesUpdatedByEmail = actorEmail;
        updates.notesUpdatedByName = actorName;
      }

      if (commentPlan) {
        updates.comments = replayedComment
          ? baseComments
          : [
              ...baseComments,
              commentPlan
            ].slice(-MAX_COMMENTS);
        if (!replayedComment) updates.commentsUpdatedAt = now;
      }

      if (commentEditPlan) {
        const commentIndex = baseComments.findIndex((comment) => comment.id === commentEditPlan.id);
        if (commentIndex === -1) {
          return { write: false, result: { found: true, commentNotFound: true, updated: base, next: list } };
        }
        const target = baseComments[commentIndex];
        if (normalizeEmail(target.email) !== actorEmail) {
          return { write: false, result: { found: true, commentForbidden: true, updated: base, next: list } };
        }
        const editedComment = {
          ...target,
          text: commentEditPlan.text,
          editedAt: now,
          editedByEmail: actorEmail,
          editedByName: actorName
        };
        if (commentEditPlan.encryptedText) {
          editedComment.encryptedText = commentEditPlan.encryptedText;
        } else {
          delete editedComment.encryptedText;
        }
        updates.comments = baseComments.map((comment, i) => (
          i === commentIndex ? editedComment : comment
        ));
        updates.commentsUpdatedAt = now;
      }

      if (ackReactionsPlan) {
        const current = Array.isArray(base.reactions) ? base.reactions : [];
        updates.reactions = current.map((r) => (
          normalizeEmail(r.by) !== actorEmail && !r.seenByAuthorAt
            ? { ...r, seenByAuthorAt: now }
            : r
        ));
      }

      if (reactionsPlan) {
        const others = (Array.isArray(base.reactions) ? base.reactions : [])
          .filter((r) => normalizeEmail(r.by) !== actorEmail);
        updates.reactions = [...others, ...reactionsPlan].slice(-12);
      }

      if (textPlan !== null) {
        if (textPlan.text !== (base.text || "") || Boolean(textPlan.encryptedText) !== Boolean(base.encryptedText)) {
          updates.editCount = Number(base.editCount || 0) + 1;
          const partnerHasEngaged =
            (Array.isArray(base.statusHistory) && base.statusHistory.some((e) => normalizeEmail(e?.email) !== actorEmail)) ||
            (Array.isArray(base.comments) && base.comments.some((c) => normalizeEmail(c?.email) !== actorEmail));
          if (partnerHasEngaged) {
            const history = Array.isArray(base.textHistory) ? base.textHistory.slice(-10) : [];
            history.push({
              text: base.text || "",
              ...(base.encryptedText ? { encryptedText: base.encryptedText } : {}),
              at: base.textEditedAt || base.createdAt || now
            });
            updates.textHistory = history.slice(-10);
          }
        }
        updates.text = textPlan.text;
        if (textPlan.encryptedText) updates.encryptedText = textPlan.encryptedText;
        else delete updates.encryptedText;
        updates.textEditedAt = now;
      }

      updates.updatedAt = now;

      const next = list.map((item, i) => i === idx ? updates : item).slice(0, MAX_IDEAS);
      return { value: next, result: { found: true, updated: updates, next, replayedComment } };
    });

    if (!casResult.found) return jsonResponse(404, { error: "Idea not found" });
    if (casResult.commentNotFound) return jsonResponse(404, { error: "Comment not found" });
    if (casResult.commentForbidden) return jsonResponse(403, { error: "Only the comment's author can edit it." });
    const updates = casResult.updated;
    const nextIdeas = recombineRows(ideas, existing.workspaceId, casResult.next);
    if (!casResult.replayedComment) {
      await appendAudit(env, workspace.id, {
        type: "fantasy_updated",
        actorEmail,
        actorName,
        entityType: "fantasy",
        entityId: updates.id
      });
      broadcastRoomEvent(context, workspace.id, {
        resource: "fantasy-backlog",
        action: "updated",
        entityId: updates.id,
        actorEmail,
        actorName,
      });
    }

    return jsonResponse(200, {
      idea: publicIdea(updates, actorEmail),
      reactionCatalog: KINK_REACTIONS_PUBLIC,
      ideas: publicForWorkspace(nextIdeas, dataWorkspaceIds, actorEmail),
      graveyard: publicForWorkspace(graveyard, dataWorkspaceIds, actorEmail),
      workspaceId: workspace.id
    });
  }

  // DELETE
  // Locate which workspace the idea lives in (from the scoped read) so the
  // ideas removal and the graveyard tombstone both target that workspace's keys.
  const deleteTarget = ideas.find((idea) => idea.id === id && dataWorkspaceIds.includes(idea.workspaceId));
  if (!deleteTarget) return jsonResponse(404, { error: "Idea not found" });
  if (normalizeEmail(deleteTarget.addedByEmail) !== actorEmail) {
    return jsonResponse(403, { error: "Only the fantasy's author can archive it." });
  }
  const targetWorkspaceId = deleteTarget.workspaceId;
  const deleteIdeasSeed = await legacyIdeasSeedFor(env, targetWorkspaceId);
  // Remove from ideas atomically, deriving the removed (tombstoned) idea from
  // the fresh snapshot so a concurrent partner edit can't be clobbered.
  const deleteResult = await mutateKey(env, STORE_NAME, ideasKey(targetWorkspaceId), (current) => {
    const list = (Array.isArray(current) && current.length ? current : deleteIdeasSeed).map(migrate);
    const idx = list.findIndex((idea) => idea.id === id && dataWorkspaceIds.includes(idea.workspaceId));
    if (idx === -1) {
      return { write: false, result: { found: false } };
    }
    if (normalizeEmail(list[idx].addedByEmail) !== actorEmail) {
      return { write: false, result: { found: true, forbidden: true } };
    }
    const removed = {
      ...list[idx],
      deletedByEmail: actorEmail,
      deletedByName: actorName,
      deletedAt: now
    };
    const nextIdeas = list.filter((idea, i) => i !== idx).slice(0, MAX_IDEAS);
    return { value: nextIdeas, result: { found: true, removed, nextIdeas } };
  });
  if (!deleteResult.found) return jsonResponse(404, { error: "Idea not found" });
  if (deleteResult.forbidden) return jsonResponse(403, { error: "Only the fantasy's author can archive it." });

  const removed = deleteResult.removed;
  const writtenIdeas = deleteResult.nextIdeas;
  const deleteGraveyardSeed = await legacyGraveyardSeedFor(env, targetWorkspaceId);
  // Prepend the tombstone to that workspace's graveyard atomically.
  const writtenGraveyard = await mutateKey(env, STORE_NAME, graveyardKey(targetWorkspaceId), (current) => {
    const list = (Array.isArray(current) && current.length ? current : deleteGraveyardSeed).map(migrate);
    const capped = [removed, ...list].slice(0, MAX_GRAVEYARD);
    return { value: capped, result: capped };
  });
  const nextIdeas = recombineRows(ideas, targetWorkspaceId, writtenIdeas);
  const nextGraveyard = recombineRows(graveyard, targetWorkspaceId, writtenGraveyard);
  await appendAudit(env, workspace.id, {
    type: "fantasy_deleted",
    actorEmail,
    actorName,
    entityType: "fantasy",
    entityId: removed.id
  });
  broadcastRoomEvent(context, workspace.id, {
    resource: "fantasy-backlog",
    action: "deleted",
    entityId: removed.id,
    actorEmail,
    actorName,
  });

  return jsonResponse(200, {
    reactionCatalog: KINK_REACTIONS_PUBLIC,
    ideas: publicForWorkspace(nextIdeas, dataWorkspaceIds, actorEmail),
    graveyard: publicForWorkspace(nextGraveyard, dataWorkspaceIds, actorEmail),
    workspaceId: workspace.id
  });
}
