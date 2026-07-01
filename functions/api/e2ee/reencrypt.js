import {
  getAuthenticatedIdentity,
  jsonResponse,
  normalizeEmail
} from "../_auth.js";
import { cleanRoomEncryptedBox } from "../_e2ee.js";
import { getStore } from "../_kv.js";
import { mutateKey } from "../_state.js";
import {
  authorizeWorkspaceAccess,
  workspaceIdFromPayload,
  workspaceIdFromRequest
} from "../_workspaces.js";
import { authorizeE2eeReencrypt } from "./_reencrypt_gate.js";
// C3 — these five stores moved from ONE global key to PER-WORKSPACE keys. The
// reencrypt mutations MUST target the same per-workspace key the handlers write
// (mutateKey on `requests:${ws}`, `boundaries:${ws}`, …), seeding from the
// legacy global key when the per-workspace key is still empty (mirroring the
// handlers' adopt-on-first-write), so re-encrypted rows land where reads look
// and never clobber or write the dead global key.
import { requestsKey } from "../request-board.js";
import { boundariesKey } from "../boundaries.js";
import { actsKey } from "../approved-acts.js";
import { ideasKey, graveyardKey } from "../fantasy-backlog.js";
import { revealsKey } from "../blind-reveals.js";

const REQUEST_STORE = "sexualsync-request-board";
// Legacy global keys are now read-only seeds for the per-workspace keys above.
const REQUEST_LEGACY_KEY = "requests";
const BOUNDARY_STORE = "sexualsync-boundaries";
const BOUNDARY_LEGACY_KEY = "boundaries";
const ACT_STORE = "sexualsync-approved-acts";
const ACT_LEGACY_KEY = "acts";
const FANTASY_STORE = "sexualsync-ideas";
const IDEAS_LEGACY_KEY = "ideas";
const GRAVEYARD_LEGACY_KEY = "graveyard";
const BLIND_REVEALS_LEGACY_KEY = "blindReveals";
const SHELF_STORE = "sexualsync-shelf";
const PILE_STORE = "sexualsync-pile";
const LEGACY_WORKSPACE_ID = "legacy-couple";

const VALID_DECISIONS = new Set(["Yes", "Maybe", "Let's chat", "Counter", "No", ""]);
const VALID_TARGET_TYPES = new Set(["act", "timing", "filming", "general"]);

function shelfKey(workspaceId) {
  return `shelf:${workspaceId}`;
}

function pileKey(workspaceId) {
  return `pile:${workspaceId}:active`;
}

function pileSessionsKey(workspaceId) {
  return `pile:${workspaceId}:sessions`;
}

function cleanId(value, max = 120) {
  return String(value || "").replace(/[^A-Za-z0-9:_-]/g, "").slice(0, max);
}

function cleanToken(value) {
  return String(value || "").replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 180);
}

function cleanWorkspaceId(row) {
  return String(row?.workspaceId || LEGACY_WORKSPACE_ID);
}

function patchList(value, max = 80) {
  return Array.isArray(value) ? value.slice(0, max).filter((item) => item && typeof item === "object") : [];
}

function patchById(patches) {
  const map = new Map();
  patchList(patches).forEach((patch) => {
    const id = cleanId(patch.id);
    if (id) map.set(id, patch);
  });
  return map;
}

function roomE2eeRequired(workspace) {
  return Boolean(workspace?.settings?.roomE2eeEnabled);
}

function allowedWorkspace(row, ids) {
  return ids.has(cleanWorkspaceId(row));
}

function box(value, max = 60000) {
  return cleanRoomEncryptedBox(value, max);
}

function placeholderDecision(item = {}) {
  return {
    label: "Encrypted content",
    decision: VALID_DECISIONS.has(item.decision) ? item.decision : "",
    counter: "",
    counterActId: "",
    note: "",
    targetType: VALID_TARGET_TYPES.has(item.targetType) ? item.targetType : "act",
    actId: ""
  };
}

// Read-only legacy seed: the bare global key rows for ONE workspace. Used to
// seed a per-workspace key on its first write (mirrors the handlers'
// adopt-on-first-write); the legacy key itself is never written here.
async function readLegacySeed(env, storeName, legacyKey, workspaceId) {
  try {
    const rows = await getStore(env, storeName).get(legacyKey, { type: "json" });
    if (!Array.isArray(rows)) return [];
    return rows.filter((row) => cleanWorkspaceId(row) === workspaceId);
  } catch {
    return [];
  }
}

// Atomic read-modify-write of ONE workspace's per-workspace list key. The
// transform runs against the per-workspace rows (seeded read-only from the
// legacy global key when still empty) and returns { next, changed }. Only writes
// when something changed, so an unmatched patch is a no-op (no stray adoption).
async function mutateWorkspaceList(env, storeName, keyFn, legacyKey, workspaceId, transform) {
  const legacySeed = await readLegacySeed(env, storeName, legacyKey, workspaceId);
  const out = await mutateKey(env, storeName, keyFn(workspaceId), (raw) => {
    const current = Array.isArray(raw) && raw.length ? raw : legacySeed;
    const { next, changed } = transform(current);
    return { value: next, write: changed > 0, result: { changed } };
  });
  return out.result?.changed || 0;
}

// Apply a per-workspace list mutation across every workspace in the data-access
// set, returning the total number of rows changed. A patch is matched by id
// inside each workspace's own key, so it only affects the workspace that owns it.
async function mutateListAcrossWorkspaces(env, storeName, keyFn, legacyKey, ids, transform) {
  let changed = 0;
  for (const workspaceId of ids) {
    changed += await mutateWorkspaceList(env, storeName, keyFn, legacyKey, workspaceId, transform);
  }
  return changed;
}

// Single-key list mutator for the shelf/tonight-pile surfaces, which were
// ALREADY keyed per workspace before C3 (shelfKey/pileSessionsKey) and have no
// legacy global key to seed from — so they don't go through the seeding path.
async function mutateList(env, storeName, key, transform) {
  const out = await mutateKey(env, storeName, key, (raw) => {
    const current = Array.isArray(raw) ? raw : [];
    const { next, changed } = transform(current);
    return { value: changed ? next : current, result: { changed } };
  });
  return out.result?.changed ? 1 : 0;
}

async function patchRequests(env, patches, ids) {
  const byId = patchById(patches);
  if (!byId.size) return 0;
  return mutateListAcrossWorkspaces(env, REQUEST_STORE, requestsKey, REQUEST_LEGACY_KEY, ids, (current) => {
    let changed = 0;
    const next = current.map((request) => {
      if (!allowedWorkspace(request, ids)) return request;
      const patch = byId.get(String(request.id || ""));
      if (!patch) return request;
      let item = request;
      const encryptedPayload = box(patch.encryptedPayload);
      if (encryptedPayload) {
        item = {
          ...item,
          categories: ["Encrypted content"],
          timing: "Tonight",
          filming: "No",
          note: "",
          boundaryConflicts: [],
          encryptedPayload
        };
        changed += 1;
      }
      const encryptedReply = box(patch.encryptedReply);
      if (encryptedReply) {
        const decisions = Array.isArray(item.decisions) && item.decisions.length
          ? item.decisions.map(placeholderDecision)
          : [];
        item = {
          ...item,
          decisions,
          counters: [],
          feedback: "",
          matchNarration: "",
          reviewSummary: "",
          encryptedReply
        };
        changed += 1;
      }
      return item;
    });
    return { next, changed };
  });
}

async function patchSimpleList(env, storeName, keyFn, legacyKey, patches, ids, applyPatch) {
  const byId = patchById(patches);
  if (!byId.size) return 0;
  return mutateListAcrossWorkspaces(env, storeName, keyFn, legacyKey, ids, (current) => {
    let changed = 0;
    const next = current.map((row) => {
      if (!allowedWorkspace(row, ids)) return row;
      const patch = byId.get(String(row.id || ""));
      if (!patch) return row;
      const patched = applyPatch(row, patch);
      if (patched !== row) changed += 1;
      return patched;
    });
    return { next, changed };
  });
}

function patchBoundary(row, patch) {
  const encryptedText = box(patch.encryptedText, 12000);
  if (!encryptedText) return row;
  return {
    ...row,
    text: "Encrypted limit",
    encryptedText,
    updatedAt: new Date().toISOString()
  };
}

function patchAct(row, patch) {
  const encryptedPayload = box(patch.encryptedPayload, 12000);
  if (!encryptedPayload) return row;
  return {
    ...row,
    label: "Encrypted act",
    tags: [],
    encryptedPayload,
    updatedAt: new Date().toISOString()
  };
}

function patchKink(row, patch) {
  let item = row;
  const encryptedText = box(patch.encryptedText, 12000);
  if (encryptedText) {
    item = {
      ...item,
      text: "Encrypted kink",
      tags: [],
      encryptedText,
      updatedAt: new Date().toISOString()
    };
  }
  const commentPatches = patchList(patch.comments);
  if (commentPatches.length) {
    item = {
      ...item,
      comments: (Array.isArray(item.comments) ? item.comments : []).map((comment, index) => {
        const patchForComment = commentPatches.find((entry) => cleanId(entry.id) === String(comment.id || ""))
          || commentPatches.find((entry) => Number(entry.index) === index);
        const encryptedComment = box(patchForComment?.encryptedText, 12000);
        return encryptedComment
          ? { ...comment, text: "Encrypted comment", encryptedText: encryptedComment }
          : comment;
      }),
      updatedAt: new Date().toISOString()
    };
  }
  const reactionPatches = patchList(patch.reactions);
  if (reactionPatches.length) {
    item = {
      ...item,
      reactions: (Array.isArray(item.reactions) ? item.reactions : []).map((reaction, index) => {
        const patchForReaction = reactionPatches.find((entry) => Number(entry.index) === index)
          || reactionPatches.find((entry) => normalizeEmail(entry.by) === normalizeEmail(reaction.by)
            && (!entry.createdAt || String(entry.createdAt) === String(reaction.createdAt || "")));
        const encryptedNote = box(patchForReaction?.encryptedNote, 12000);
        return encryptedNote
          ? { ...reaction, note: "", encryptedNote }
          : reaction;
      }),
      updatedAt: new Date().toISOString()
    };
  }
  return item;
}

function patchBlindReveal(row, patch) {
  let item = row;
  const encryptedPrompt = box(patch.encryptedPrompt, 12000);
  if (encryptedPrompt) {
    item = {
      ...item,
      prompt: "Encrypted prompt",
      encryptedPrompt,
      updatedAt: new Date().toISOString()
    };
  }
  const entryPatches = patchList(patch.entries);
  if (entryPatches.length) {
    const entries = item.entries && typeof item.entries === "object" ? item.entries : {};
    const nextEntries = { ...entries };
    entryPatches.forEach((entryPatch) => {
      const email = normalizeEmail(entryPatch.email);
      const encryptedText = box(entryPatch.encryptedText);
      if (!email || !encryptedText || !nextEntries[email]) return;
      nextEntries[email] = {
        ...nextEntries[email],
        text: "Encrypted answer",
        encryptedText,
        updatedAt: new Date().toISOString()
      };
    });
    item = {
      ...item,
      entries: nextEntries,
      updatedAt: new Date().toISOString()
    };
  }
  return item;
}

async function patchShelf(env, workspaceId, patches) {
  const byId = patchById(patches);
  if (!byId.size) return 0;
  return mutateList(env, SHELF_STORE, shelfKey(workspaceId), (current) => {
    let changed = 0;
    const next = current.map((row) => {
      const patch = byId.get(String(row.id || ""));
      if (!patch) return row;
      let item = row;
      const encryptedContent = box(patch.encryptedContent);
      if (encryptedContent) {
        item = {
          ...item,
          type: "encrypted",
          source: null,
          sourceUrl: "",
          sourceId: "",
          embedUrl: "",
          posterUrl: "",
          videoHdUrl: "",
          videoSdUrl: "",
          passageText: "Encrypted shelf item",
          encryptedContent
        };
        changed += 1;
      }
      const encryptedTitle = box(patch.encryptedTitle, 12000);
      if (encryptedTitle) {
        item = {
          ...item,
          title: "Encrypted title",
          encryptedTitle
        };
        changed += 1;
      }
      return item;
    });
    return { next, changed };
  });
}

function cleanEncryptedLabel(entry) {
  const token = cleanToken(entry?.token);
  const encryptedLabel = box(entry?.encryptedLabel, 12000);
  return token && encryptedLabel ? { token, encryptedLabel } : null;
}

async function patchPileActive(env, workspaceId, patches) {
  const patch = patchList(patches, 1)[0];
  const encryptedContributions = patch?.encryptedContributions;
  if (!encryptedContributions || typeof encryptedContributions !== "object") return 0;
  const out = await mutateKey(env, PILE_STORE, pileKey(workspaceId), (raw) => {
    if (!raw || typeof raw !== "object") return { write: false, result: { changed: false } };
    let changed = 0;
    const contributions = { ...(raw.contributions || {}) };
    const encrypted = { ...(raw.encryptedContributions || {}) };
    Object.entries(encryptedContributions).forEach(([email, entries]) => {
      const normalized = normalizeEmail(email);
      const cleanEntries = Array.isArray(entries) ? entries.map(cleanEncryptedLabel).filter(Boolean) : [];
      if (!normalized || !cleanEntries.length) return;
      contributions[normalized] = cleanEntries.map((entry) => entry.token);
      encrypted[normalized] = cleanEntries;
      changed += 1;
    });
    if (!changed) return { write: false, result: { changed: false } };
    return {
      value: {
        ...raw,
        roomE2ee: true,
        contributions,
        encryptedContributions: encrypted
      },
      result: { changed: true }
    };
  });
  return out.result?.changed ? 1 : 0;
}

async function patchPileSessions(env, workspaceId, patches) {
  const byId = patchById(patches);
  if (!byId.size) return 0;
  return mutateList(env, PILE_STORE, pileSessionsKey(workspaceId), (current) => {
    let changed = 0;
    const next = current.map((session) => {
      const patch = byId.get(String(session.id || ""));
      if (!patch) return session;
      const encryptedActs = Array.isArray(patch.encryptedActs)
        ? patch.encryptedActs.map(cleanEncryptedLabel).filter(Boolean)
        : [];
      const encryptedOverlap = Array.isArray(patch.encryptedOverlap)
        ? patch.encryptedOverlap.map(cleanEncryptedLabel).filter(Boolean)
        : encryptedActs;
      if (!encryptedActs.length && !encryptedOverlap.length) return session;
      changed += 1;
      return {
        ...session,
        roomE2ee: true,
        acts: encryptedActs.map(() => "Encrypted pile match"),
        overlap: encryptedOverlap.map(() => "Encrypted pile match"),
        encryptedActs,
        encryptedOverlap,
        revealNarration: ""
      };
    });
    return { next, changed };
  });
}

async function applySurface(context, surface, patches, access) {
  const ids = new Set(access.dataWorkspaceIds || [access.workspace.id]);
  switch (surface) {
    case "request-board":
      return patchRequests(context.env, patches, ids);
    case "boundaries":
      return patchSimpleList(context.env, BOUNDARY_STORE, boundariesKey, BOUNDARY_LEGACY_KEY, patches, ids, patchBoundary);
    case "approved-acts":
      return patchSimpleList(context.env, ACT_STORE, actsKey, ACT_LEGACY_KEY, patches, ids, patchAct);
    case "fantasy-backlog": {
      const changedIdeas = await patchSimpleList(context.env, FANTASY_STORE, ideasKey, IDEAS_LEGACY_KEY, patches, ids, patchKink);
      const changedGraveyard = await patchSimpleList(context.env, FANTASY_STORE, graveyardKey, GRAVEYARD_LEGACY_KEY, patches, ids, patchKink);
      return changedIdeas + changedGraveyard;
    }
    case "blind-reveals":
      return patchSimpleList(context.env, FANTASY_STORE, revealsKey, BLIND_REVEALS_LEGACY_KEY, patches, ids, patchBlindReveal);
    case "shelf":
      return patchShelf(context.env, access.workspace.id, patches);
    case "pile-active":
      return patchPileActive(context.env, access.workspace.id, patches);
    case "pile-sessions":
      return patchPileSessions(context.env, access.workspace.id, patches);
    default:
      return -1;
  }
}

export async function onRequest(context) {
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;
  if (context.request.method.toUpperCase() !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  let payload = {};
  try { payload = await context.request.json(); }
  catch { return jsonResponse(400, { error: "Expected JSON body." }); }

  const migrationAuth = authorizeE2eeReencrypt(context.request, context.env, payload);
  if (!migrationAuth.ok) return jsonResponse(migrationAuth.status, { error: migrationAuth.error });

  const access = await authorizeWorkspaceAccess(
    context,
    identity,
    workspaceIdFromPayload(payload, workspaceIdFromRequest(context.request))
  );
  if (!access.ok) return access.response;
  if (!roomE2eeRequired(access.workspace)) {
    return jsonResponse(409, { error: "Room Encryption is not enabled." });
  }

  const surface = String(payload.surface || "").trim();
  const changed = await applySurface(context, surface, payload.patches, access);
  if (changed < 0) return jsonResponse(400, { error: "Unsupported E2EE migration surface." });
  return jsonResponse(200, {
    ok: true,
    workspaceId: access.workspace.id,
    surface,
    changed
  });
}
