// Mutual blind reveal for first-share fantasies.
//
// Both partners can submit an answer, but the API hides partner text until
// every active workspace member has submitted. Once revealed, either
// partner can promote their own answer into the regular Ideas room.

import { getStore } from "./_kv.js";
import { mutateKey } from "./_state.js";
import {
  LEGACY_WORKSPACE_ID,
  getAuthenticatedIdentity,
  jsonResponse,
  normalizeEmail,
} from "./_auth.js";
import {
  authorizeWorkspaceAccess,
  cleanText,
  workspaceIdFromPayload,
  workspaceIdFromRequest,
} from "./_workspaces.js";
import { appendAudit } from "./_audit.js";
import { notifyWorkspaceEvent } from "./_notification_policy.js";
import { broadcastRoomEvent } from "./_live_room.js";
import { cleanRoomEncryptedBox } from "./_e2ee.js";

const STORE_NAME = "sexualsync-ideas";
// C3 — blind reveals (and the ideas they promote into) are now keyed per
// workspace so the MAX_REVEALS / MAX_IDEAS caps and the CAS versions are scoped
// to one couple. The bare "blindReveals"/"ideas" keys are retained ONLY as a
// read-time legacy fallback and as a seed for the first per-workspace write; new
// writes never touch them. See scripts/migrate-store-keys.mjs.
const LEGACY_REVEALS_KEY = "blindReveals";
const LEGACY_IDEAS_KEY = "ideas";
// Exported so the E2EE migration routes (status/reencrypt) mutate the SAME
// per-workspace key the handlers do, instead of the dead legacy global key.
export function revealsKey(workspaceId) { return `blindReveals:${workspaceId}`; }
function ideasKey(workspaceId) { return `ideas:${workspaceId}`; }
const MAX_REVEALS = 80;
const MAX_IDEAS = 300;
const MAX_TEXT_LENGTH = 1800;
const MAX_PROMPT_LENGTH = 220;

function store(env) {
  return getStore(env, STORE_NAME);
}

function cleanLongText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

function cleanPrompt(value) {
  return cleanText(value, MAX_PROMPT_LENGTH) || "What fantasy would feel easier if they admitted it too?";
}

function roomE2eeRequired(workspace) {
  return Boolean(workspace?.settings?.roomE2eeEnabled);
}

function entrySubmitted(entry) {
  return Boolean(cleanLongText(entry?.text) || cleanRoomEncryptedBox(entry?.encryptedText, 60000));
}

async function readList(env, key) {
  try {
    const value = await store(env).get(key, { type: "json" });
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

// Per-workspace reveals read with a read-only fallback to the legacy global key
// (filtered to this workspace) so nothing disappears before the migration runs.
// Reveals are always scoped to a single workspace here, so no cross-workspace
// merge is needed — the per-workspace key wins, with the legacy rows for this
// workspace appended (de-duped by id).
// Exported (raw rows, no side effects) so the E2EE status route can count
// plaintext blind-reveal fields off the SAME per-workspace key + legacy fallback
// the handler reads — readBlindRevealResponse can't be used because it returns
// the redacted publicReveal shape (partner entries hidden) and writes on read.
export async function readRevealsForWorkspace(env, workspaceId) {
  const own = await readList(env, revealsKey(workspaceId));
  const seen = new Set(own.map((reveal) => reveal?.id).filter(Boolean));
  const legacy = (await readList(env, LEGACY_REVEALS_KEY))
    .filter((reveal) => reveal?.workspaceId === workspaceId && reveal?.id && !seen.has(reveal.id));
  return [...own, ...legacy];
}

// Seed for the first per-workspace write while the legacy key still holds this
// workspace's reveals (pre-migration). The legacy key itself is never written.
async function legacyRevealsSeedFor(env, workspaceId) {
  return (await readList(env, LEGACY_REVEALS_KEY)).filter((reveal) => reveal?.workspaceId === workspaceId);
}

async function legacyIdeasSeedFor(env, workspaceId) {
  return (await readList(env, LEGACY_IDEAS_KEY)).filter((idea) => (idea?.workspaceId || LEGACY_WORKSPACE_ID) === workspaceId);
}

function activeMemberEmails(workspace) {
  return (workspace?.members || [])
    .filter((member) => member.status === "active")
    .map((member) => normalizeEmail(member.email))
    .filter(Boolean);
}

function actorNameFor(access, identity) {
  const actorEmail = normalizeEmail(identity.email);
  return access.actorName
    || access.workspace?.members?.find((member) => normalizeEmail(member.email) === actorEmail)?.displayName
    || "";
}

function migrateReveal(reveal) {
  const entries = reveal?.entries && typeof reveal.entries === "object" ? reveal.entries : {};
  const safeEntries = {};
  Object.entries(entries).forEach(([email, entry]) => {
    const normalized = normalizeEmail(email || entry?.email);
    const encryptedText = cleanRoomEncryptedBox(entry?.encryptedText, 60000);
    const text = encryptedText ? "Encrypted answer" : cleanLongText(entry?.text);
    if (!normalized || !text) return;
    const safeEntry = {
      email: normalized,
      name: cleanText(entry?.name, 80),
      text,
      promotedIdeaId: cleanText(entry?.promotedIdeaId, 80),
      createdAt: entry?.createdAt || entry?.updatedAt || reveal?.createdAt || new Date().toISOString(),
      updatedAt: entry?.updatedAt || entry?.createdAt || reveal?.createdAt || new Date().toISOString(),
    };
    if (encryptedText) safeEntry.encryptedText = encryptedText;
    safeEntries[normalized] = safeEntry;
  });

  const encryptedPrompt = cleanRoomEncryptedBox(reveal?.encryptedPrompt, 12000);
  const migrated = {
    id: cleanText(reveal?.id, 80) || crypto.randomUUID(),
    workspaceId: cleanText(reveal?.workspaceId, 120),
    prompt: encryptedPrompt ? "Encrypted prompt" : cleanPrompt(reveal?.prompt),
    status: ["open", "revealed", "archived"].includes(reveal?.status) ? reveal.status : "open",
    entries: safeEntries,
    createdByEmail: normalizeEmail(reveal?.createdByEmail),
    createdByName: cleanText(reveal?.createdByName, 80),
    createdAt: reveal?.createdAt || new Date().toISOString(),
    updatedAt: reveal?.updatedAt || reveal?.createdAt || new Date().toISOString(),
    revealedAt: reveal?.revealedAt || "",
    archivedAt: reveal?.archivedAt || "",
    archivedByEmail: normalizeEmail(reveal?.archivedByEmail),
    archivedByName: cleanText(reveal?.archivedByName, 80),
  };
  if (encryptedPrompt) migrated.encryptedPrompt = encryptedPrompt;
  return migrated;
}

function revealIfComplete(reveal, workspace, now) {
  if (!reveal || reveal.status !== "open") return reveal;
  const requiredEmails = activeMemberEmails(workspace);
  if (requiredEmails.length < 2) return reveal;
  const submitted = requiredEmails.filter((email) => entrySubmitted(reveal.entries?.[email]));
  if (submitted.length < requiredEmails.length) return reveal;
  return {
    ...reveal,
    status: "revealed",
    revealedAt: reveal.revealedAt || now,
    updatedAt: now,
  };
}

function publicEntry(entry) {
  const out = {
    email: entry.email,
    name: entry.name,
    text: entry.text,
    promotedIdeaId: entry.promotedIdeaId || "",
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
  const encryptedText = cleanRoomEncryptedBox(entry.encryptedText, 60000);
  if (encryptedText) out.encryptedText = encryptedText;
  return out;
}

export function publicReveal(reveal, workspace, actorEmail) {
  if (!reveal) return null;
  const me = normalizeEmail(actorEmail);
  const requiredEmails = activeMemberEmails(workspace);
  const entries = reveal.entries || {};
  const submittedCount = requiredEmails.filter((email) => entrySubmitted(entries[email])).length;
  const myEntry = entries[me] || null;
  const partnerSubmitted = Object.entries(entries).some(([email, entry]) => normalizeEmail(email) !== me && entrySubmitted(entry));
  const shouldShowEntries = reveal.status === "revealed" || reveal.status === "archived";

  const out = {
    id: reveal.id,
    workspaceId: reveal.workspaceId,
    prompt: reveal.prompt,
    status: reveal.status,
    createdAt: reveal.createdAt,
    updatedAt: reveal.updatedAt,
    revealedAt: reveal.revealedAt,
    archivedAt: reveal.archivedAt,
    requiredCount: Math.max(2, requiredEmails.length),
    submittedCount,
    mySubmitted: entrySubmitted(myEntry),
    partnerSubmitted,
    // Lets the UI offer "take back" only to the person who started it.
    startedByMe: normalizeEmail(reveal.createdByEmail) === me,
    myEntry: myEntry ? publicEntry(myEntry) : null,
    entries: shouldShowEntries
      ? Object.values(entries).map(publicEntry)
      : [],
  };
  const encryptedPrompt = cleanRoomEncryptedBox(reveal.encryptedPrompt, 12000);
  if (encryptedPrompt) out.encryptedPrompt = encryptedPrompt;
  return out;
}

export function pickActiveReveal(reveals, workspaceId) {
  const workspaceReveals = reveals.filter((reveal) => reveal.workspaceId === workspaceId);
  return workspaceReveals.find((reveal) => reveal.status === "open")
    || workspaceReveals.find((reveal) => reveal.status === "revealed")
    || null;
}

export async function readBlindRevealResponse(env, workspace, actorEmail, now = new Date().toISOString()) {
  const rawReveals = await readRevealsForWorkspace(env, workspace.id);
  const reveals = rawReveals
    .map(migrateReveal)
    .map((reveal) => reveal.workspaceId === workspace.id ? revealIfComplete(reveal, workspace, now) : reveal);
  if (JSON.stringify(rawReveals) !== JSON.stringify(reveals)) {
    // Persist auto-reveal transitions through a CAS transform, not a raw
    // writeList (which could clobber a partner's concurrent submit). Re-run the
    // reveal pipeline on the FRESH per-workspace value so a submit landed since
    // our union read is composed on, not overwritten. The response list above
    // still comes from the union read, so nothing drops from the history view.
    await mutateKey(env, STORE_NAME, revealsKey(workspace.id), (current) => {
      const base = Array.isArray(current) && current.length ? current : reveals;
      const next = base
        .map(migrateReveal)
        .map((reveal) => reveal.workspaceId === workspace.id ? revealIfComplete(reveal, workspace, now) : reveal);
      return { value: next.slice(0, MAX_REVEALS), write: JSON.stringify(base) !== JSON.stringify(next) };
    });
  }
  const activeReveal = pickActiveReveal(reveals, workspace.id);
  return {
    workspaceId: workspace.id,
    activeReveal: publicReveal(activeReveal, workspace, actorEmail),
    reveals: reveals
      .filter((reveal) => reveal.workspaceId === workspace.id)
      .slice(0, 20)
      .map((reveal) => publicReveal(reveal, workspace, actorEmail)),
  };
}

function makeIdeaFromEntry({ workspace, entry, actorEmail, actorName, now, revealId }) {
  const encryptedText = cleanRoomEncryptedBox(entry.encryptedText, 60000);
  const idea = {
    id: crypto.randomUUID(),
    workspaceId: workspace.id,
    text: encryptedText ? "Encrypted kink" : entry.text,
    tags: [],
    status: "Tell me more",
    statusByEmail: actorEmail,
    statusByName: actorName,
    statusAt: now,
    addedByEmail: actorEmail,
    addedByName: actorName,
    notes: {},
    comments: [],
    statusHistory: [{
      email: actorEmail,
      name: actorName,
      status: "Tell me more",
      at: now,
    }],
    source: "blind-reveal",
    sourceRevealId: revealId,
    createdAt: now,
    updatedAt: now,
  };
  if (encryptedText) idea.encryptedText = encryptedText;
  return idea;
}

export async function onRequest(context) {
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;

  const request = context.request;
  const method = request.method.toUpperCase();
  let payload = {};
  if (method !== "GET") {
    try { payload = await request.json(); }
    catch { return jsonResponse(400, { error: "Expected JSON body." }); }
  }

  const workspaceId = method === "GET"
    ? workspaceIdFromRequest(request)
    : workspaceIdFromPayload(payload, workspaceIdFromRequest(request));
  const access = await authorizeWorkspaceAccess(context, identity, workspaceId);
  if (!access.ok) return access.response;

  const actorEmail = normalizeEmail(identity.email);
  const actorName = actorNameFor(access, identity);
  const now = new Date().toISOString();
  const workspace = access.workspace;

  if (method === "GET") {
    return jsonResponse(200, await readBlindRevealResponse(context.env, workspace, actorEmail, now));
  }

  if (method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const action = cleanText(payload.action, 40) || "create";

  if (action === "create") {
    const encryptedPrompt = cleanRoomEncryptedBox(payload.encryptedPrompt, 12000);
    if (roomE2eeRequired(workspace) && !encryptedPrompt) {
      return jsonResponse(400, { error: "Room Encryption requires an encrypted Blind Reveal prompt." });
    }
    const reveal = {
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      prompt: encryptedPrompt ? "Encrypted prompt" : cleanPrompt(payload.prompt),
      status: "open",
      entries: {},
      createdByEmail: actorEmail,
      createdByName: actorName,
      createdAt: now,
      updatedAt: now,
      revealedAt: "",
      archivedAt: "",
    };
    if (encryptedPrompt) reveal.encryptedPrompt = encryptedPrompt;
    // Prepend atomically against a fresh snapshot (was a raw writeList that could
    // drop a partner's concurrent submit). The active-reveal guard runs INSIDE
    // the transform so two simultaneous creates can't both open a reveal. Seed
    // read-only from the legacy list when the per-workspace key is still empty.
    const createSeed = await legacyRevealsSeedFor(context.env, workspace.id);
    const created = await mutateKey(context.env, STORE_NAME, revealsKey(workspace.id), (current) => {
      const list = (Array.isArray(current) && current.length ? current : createSeed)
        .map(migrateReveal)
        .map((r) => r.workspaceId === workspace.id ? revealIfComplete(r, workspace, now) : r);
      const active = pickActiveReveal(list, workspace.id);
      if (active && active.status !== "archived") {
        return { write: false, result: { created: false, reveal: active } };
      }
      return { value: [reveal, ...list].slice(0, MAX_REVEALS), result: { created: true, reveal } };
    });
    if (!created.created) {
      return jsonResponse(200, {
        workspaceId: workspace.id,
        activeReveal: publicReveal(created.reveal, workspace, actorEmail),
        reveal: publicReveal(created.reveal, workspace, actorEmail),
      });
    }
    await appendAudit(context.env, workspace.id, {
      type: "blind_reveal_created",
      actorEmail,
      actorName,
      entityType: "blind_reveal",
      entityId: reveal.id,
    });
    broadcastRoomEvent(context, workspace.id, {
      resource: "blind-reveals",
      action: "created",
      entityId: reveal.id,
      actorEmail,
      actorName,
    });
    return jsonResponse(201, {
      workspaceId: workspace.id,
      activeReveal: publicReveal(reveal, workspace, actorEmail),
      reveal: publicReveal(reveal, workspace, actorEmail),
    });
  }

  const revealId = cleanText(payload.id, 80);
  let reveals = (await readRevealsForWorkspace(context.env, workspace.id))
    .map(migrateReveal)
    .map((reveal) => reveal.workspaceId === workspace.id ? revealIfComplete(reveal, workspace, now) : reveal);
  const index = reveals.findIndex((reveal) => reveal.id === revealId && reveal.workspaceId === workspace.id);
  if (index === -1) return jsonResponse(404, { error: "Blind reveal not found." });
  const reveal = reveals[index];

  if (action === "submit") {
    if (reveal.status !== "open") {
      return jsonResponse(409, { error: "This reveal is already closed." });
    }
    const encryptedText = cleanRoomEncryptedBox(payload.encryptedText, 60000);
    if (roomE2eeRequired(workspace) && !encryptedText) {
      return jsonResponse(400, { error: "Room Encryption requires encrypted Blind Reveal answers." });
    }
    const text = encryptedText ? "Encrypted answer" : cleanLongText(payload.text);
    if (!text) return jsonResponse(400, { error: "Write your answer first." });

    // Merge this partner's entry atomically against a fresh snapshot so the
    // other partner's concurrent submit (a different entry key) composes
    // instead of clobbering. The migrate + reveal-completion pipeline re-runs
    // inside the transform so the version we write is the one we computed on.
    // Per-workspace key, seeded read-only from the legacy list when still empty.
    const submitSeed = await legacyRevealsSeedFor(context.env, workspace.id);
    const submitResult = await mutateKey(context.env, STORE_NAME, revealsKey(workspace.id), (current) => {
      const list = (Array.isArray(current) && current.length ? current : submitSeed)
        .map(migrateReveal)
        .map((r) => r.workspaceId === workspace.id ? revealIfComplete(r, workspace, now) : r);
      const i = list.findIndex((r) => r.id === revealId && r.workspaceId === workspace.id);
      if (i === -1) return { write: false, result: { status: "missing" } };
      const fresh = list[i];
      if (fresh.status !== "open") return { write: false, result: { status: "closed" } };
      const priorEntry = fresh.entries?.[actorEmail] || {};
      const nextEntry = {
        email: actorEmail,
        name: actorName,
        text,
        promotedIdeaId: priorEntry.promotedIdeaId || "",
        createdAt: priorEntry.createdAt || now,
        updatedAt: now,
      };
      if (encryptedText) nextEntry.encryptedText = encryptedText;
      let nextReveal = {
        ...fresh,
        entries: {
          ...(fresh.entries || {}),
          [actorEmail]: nextEntry,
        },
        updatedAt: now,
      };
      nextReveal = revealIfComplete(nextReveal, workspace, now);
      const value = list.map((item, itemIdx) => itemIdx === i ? nextReveal : item).slice(0, MAX_REVEALS);
      return { value, result: { status: "ok", nextReveal } };
    });
    if (submitResult.status === "missing") return jsonResponse(404, { error: "Blind reveal not found." });
    if (submitResult.status === "closed") return jsonResponse(409, { error: "This reveal is already closed." });
    const nextReveal = submitResult.nextReveal;
    await appendAudit(context.env, workspace.id, {
      type: "blind_reveal_submitted",
      actorEmail,
      actorName,
      entityType: "blind_reveal",
      entityId: nextReveal.id,
      metadata: { revealed: nextReveal.status === "revealed" },
    });
    broadcastRoomEvent(context, workspace.id, {
      resource: "blind-reveals",
      action: nextReveal.status === "revealed" ? "revealed" : "submitted",
      entityId: nextReveal.id,
      actorEmail,
      actorName,
    });
    if (nextReveal.status === "revealed") {
      // Only the completed reveal interrupts. Created/submitted/archive states
      // stay in partner Activity.
      context.waitUntil?.(notifyWorkspaceEvent(context, workspace.id, actorEmail, {
        title: "Sexualsync",
        body: "Something new in your room.",
        tag: "blind-reveal",
        url: `/games/blind-reveal?id=${encodeURIComponent(nextReveal.id)}&activity=1`,
      }));
    }

    return jsonResponse(200, {
      workspaceId: workspace.id,
      activeReveal: publicReveal(nextReveal, workspace, actorEmail),
      reveal: publicReveal(nextReveal, workspace, actorEmail),
    });
  }

  if (action === "cancel") {
    // The starter takes back a reveal they began — only before it completes
    // (status "open"), only by whoever created it. Re-derive + re-check BOTH
    // guards (creator + status) against the fresh row INSIDE a CAS transform so
    // a concurrent submit/reveal can't be clobbered by our stale pre-read — a
    // plain writeList here would be last-write-wins and could silently discard a
    // partner's just-locked answer. Mirrors the `submit` action.
    if (normalizeEmail(reveal.createdByEmail) !== normalizeEmail(actorEmail)) {
      return jsonResponse(403, { error: "Only the person who started this can take it back." });
    }
    const cancelSeed = await legacyRevealsSeedFor(context.env, workspace.id);
    const cancelResult = await mutateKey(context.env, STORE_NAME, revealsKey(workspace.id), (current) => {
      const list = (Array.isArray(current) && current.length ? current : cancelSeed)
        .map(migrateReveal)
        .map((r) => r.workspaceId === workspace.id ? revealIfComplete(r, workspace, now) : r);
      const i = list.findIndex((r) => r.id === revealId && r.workspaceId === workspace.id);
      if (i === -1) return { write: false, result: { status: "missing" } };
      const fresh = list[i];
      if (normalizeEmail(fresh.createdByEmail) !== normalizeEmail(actorEmail)) {
        return { write: false, result: { status: "forbidden" } };
      }
      if (fresh.status !== "open") return { write: false, result: { status: "closed" } };
      const value = list.filter((_, itemIdx) => itemIdx !== i).slice(0, MAX_REVEALS);
      return { value, result: { status: "ok", list: value } };
    });
    if (cancelResult.status === "missing") return jsonResponse(404, { error: "Blind reveal not found." });
    if (cancelResult.status === "forbidden") return jsonResponse(403, { error: "Only the person who started this can take it back." });
    if (cancelResult.status === "closed") return jsonResponse(409, { error: "Too late — this reveal already opened." });
    await appendAudit(context.env, workspace.id, {
      type: "blind_reveal_cancelled",
      actorEmail,
      actorName,
      entityType: "blind_reveal",
      entityId: reveal.id,
    });
    broadcastRoomEvent(context, workspace.id, {
      resource: "blind-reveals",
      action: "cancelled",
      entityId: reveal.id,
      actorEmail,
      actorName,
    });
    return jsonResponse(200, {
      workspaceId: workspace.id,
      activeReveal: publicReveal(pickActiveReveal(cancelResult.list || [], workspace.id), workspace, actorEmail),
      reveal: null,
      cancelled: true,
    });
  }

  if (action === "archive") {
    // Flip to archived atomically against a fresh snapshot (was a raw writeList
    // that could drop a partner's concurrent submit/promote on the same list).
    const archiveSeed = await legacyRevealsSeedFor(context.env, workspace.id);
    const archiveResult = await mutateKey(context.env, STORE_NAME, revealsKey(workspace.id), (current) => {
      const list = (Array.isArray(current) && current.length ? current : archiveSeed)
        .map(migrateReveal)
        .map((r) => r.workspaceId === workspace.id ? revealIfComplete(r, workspace, now) : r);
      const i = list.findIndex((r) => r.id === revealId && r.workspaceId === workspace.id);
      if (i === -1) return { write: false, result: null };
      const archived = {
        ...list[i],
        status: "archived",
        archivedAt: now,
        archivedByEmail: actorEmail,
        archivedByName: actorName,
        updatedAt: now,
      };
      const value = list.map((item, idx) => idx === i ? archived : item).slice(0, MAX_REVEALS);
      return { value, result: { reveal: archived, list: value } };
    });
    if (!archiveResult) return jsonResponse(404, { error: "Blind reveal not found." });
    const nextReveal = archiveResult.reveal;
    await appendAudit(context.env, workspace.id, {
      type: "blind_reveal_archived",
      actorEmail,
      actorName,
      entityType: "blind_reveal",
      entityId: nextReveal.id,
    });
    broadcastRoomEvent(context, workspace.id, {
      resource: "blind-reveals",
      action: "archived",
      entityId: nextReveal.id,
      actorEmail,
      actorName,
    });

    return jsonResponse(200, {
      workspaceId: workspace.id,
      activeReveal: publicReveal(pickActiveReveal(archiveResult.list, workspace.id), workspace, actorEmail),
      reveal: publicReveal(nextReveal, workspace, actorEmail),
    });
  }

  if (action === "promote_entry") {
    if (reveal.status !== "revealed") {
      return jsonResponse(409, { error: "Both answers need to be revealed first." });
    }
    const entry = reveal.entries?.[actorEmail];
    if (!entry?.text) return jsonResponse(404, { error: "Your answer is not available." });
    if (entry.promotedIdeaId) {
      return jsonResponse(200, {
        workspaceId: workspace.id,
        activeReveal: publicReveal(reveal, workspace, actorEmail),
        reveal: publicReveal(reveal, workspace, actorEmail),
        promotedIdeaId: entry.promotedIdeaId,
      });
    }

    // Build the promoted idea once — its UUID must be stable across CAS
    // retries so the reveal's promotedIdeaId matches the idea actually stored.
    const idea = makeIdeaFromEntry({ workspace, entry, actorEmail, actorName, now, revealId: reveal.id });

    // Stamp promotedIdeaId on this partner's entry atomically. The fresh
    // re-check of promotedIdeaId makes a concurrent double-promote a no-op
    // (we reuse the id that won) instead of inserting a duplicate idea.
    // Per-workspace key, seeded read-only from the legacy list when still empty.
    const promoteSeed = await legacyRevealsSeedFor(context.env, workspace.id);
    const promoteResult = await mutateKey(context.env, STORE_NAME, revealsKey(workspace.id), (current) => {
      const list = (Array.isArray(current) && current.length ? current : promoteSeed)
        .map(migrateReveal)
        .map((r) => r.workspaceId === workspace.id ? revealIfComplete(r, workspace, now) : r);
      const i = list.findIndex((r) => r.id === revealId && r.workspaceId === workspace.id);
      if (i === -1) return { write: false, result: { status: "missing" } };
      const fresh = list[i];
      if (fresh.status !== "revealed") return { write: false, result: { status: "not_revealed" } };
      const freshEntry = fresh.entries?.[actorEmail];
      if (!freshEntry?.text) return { write: false, result: { status: "no_entry" } };
      if (freshEntry.promotedIdeaId) {
        // Already promoted by a concurrent call — return that reveal/id, no write.
        return { write: false, result: { status: "already", nextReveal: fresh, promotedIdeaId: freshEntry.promotedIdeaId } };
      }
      const nextReveal = {
        ...fresh,
        entries: {
          ...(fresh.entries || {}),
          [actorEmail]: {
            ...freshEntry,
            promotedIdeaId: idea.id,
            updatedAt: now,
          },
        },
        updatedAt: now,
      };
      const value = list.map((item, itemIdx) => itemIdx === i ? nextReveal : item).slice(0, MAX_REVEALS);
      return { value, result: { status: "promoted", nextReveal } };
    });

    if (promoteResult.status === "missing") return jsonResponse(404, { error: "Blind reveal not found." });
    if (promoteResult.status === "not_revealed") return jsonResponse(409, { error: "Both answers need to be revealed first." });
    if (promoteResult.status === "no_entry") return jsonResponse(404, { error: "Your answer is not available." });

    const nextReveal = promoteResult.nextReveal;
    // Insert the promoted idea into THIS workspace's Ideas list by-id (prepend
    // on a fresh snapshot), never overwriting the whole list — concurrent PATCH
    // reactions/comments on other ideas compose intact. Seeded read-only from
    // the legacy ideas list (filtered to this workspace) when still empty.
    //
    // This runs for the "already" path too: the reveal-side claim and the idea
    // insert live on two different keys, so a crash between them used to leave
    // promotedIdeaId pointing at an idea that was never written — and the
    // "already" guard then blocked re-promotion forever. Re-running the by-id
    // insert under the WINNING id is a no-op when the idea exists and heals
    // the dangling pointer when it doesn't.
    const promotedIdea = promoteResult.status === "already"
      ? { ...idea, id: promoteResult.promotedIdeaId }
      : idea;
    const ideasSeed = await legacyIdeasSeedFor(context.env, workspace.id);
    await mutateKey(context.env, STORE_NAME, ideasKey(workspace.id), (current) => {
      const list = Array.isArray(current) && current.length ? current : ideasSeed;
      if (list.some((it) => it.id === promotedIdea.id)) return { write: false };
      const value = [promotedIdea, ...list].slice(0, MAX_IDEAS);
      return { value };
    });

    if (promoteResult.status === "already") {
      return jsonResponse(200, {
        workspaceId: workspace.id,
        activeReveal: publicReveal(nextReveal, workspace, actorEmail),
        reveal: publicReveal(nextReveal, workspace, actorEmail),
        promotedIdeaId: promoteResult.promotedIdeaId,
      });
    }
    await appendAudit(context.env, workspace.id, {
      type: "blind_reveal_promoted",
      actorEmail,
      actorName,
      entityType: "blind_reveal",
      entityId: nextReveal.id,
      metadata: { ideaId: idea.id },
    });
    broadcastRoomEvent(context, workspace.id, {
      resource: "blind-reveals",
      action: "promoted",
      entityId: nextReveal.id,
      actorEmail,
      actorName,
    });
    broadcastRoomEvent(context, workspace.id, {
      resource: "fantasy-backlog",
      action: "created",
      entityId: idea.id,
      actorEmail,
      actorName,
    });

    return jsonResponse(200, {
      workspaceId: workspace.id,
      activeReveal: publicReveal(nextReveal, workspace, actorEmail),
      reveal: publicReveal(nextReveal, workspace, actorEmail),
      idea,
      promotedIdeaId: idea.id,
    });
  }

  return jsonResponse(400, { error: "Unsupported blind reveal action." });
}
