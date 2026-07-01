import { getStore } from "./_kv.js";
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
import { mutateKey } from "./_state.js";
import { sendBoundaryChangeEmail } from "./_email.js";
import { trustedOrigin } from "./_origin.js";

const STORE_NAME = "sexualsync-boundaries";
// C3 — boundaries are now keyed per workspace so the MAX_BOUNDARIES cap and the
// CAS version are scoped to one couple (a lost Hard No is a consent-safety bug,
// and a global cap could silently evict another couple's limits). The bare
// "boundaries" key is retained ONLY as a read-time legacy fallback and as a
// seed for the first per-workspace write; new writes never touch it.
const LEGACY_STORE_KEY = "boundaries";
// Exported so the E2EE migration routes (status/reencrypt) mutate the SAME
// per-workspace key the handlers do, instead of the dead legacy global key.
export function boundariesKey(workspaceId) { return `boundaries:${workspaceId}`; }
const MAX_BOUNDARIES = 200;
const MAX_TEXT_LENGTH = 160;

const VALID_TYPES = new Set(["Hard No", "Soft No", "Not Yet", "Maybe", "Talk First", "Soft Limit", "Yes With Conditions"]);

function boundaryStore(env) {
  return getStore(env, STORE_NAME);
}

function cleanBoundaryText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
}

function cleanType(value) {
  return VALID_TYPES.has(value) ? value : "Hard No";
}

// Read-only legacy fallback: the bare global key from before per-workspacing.
async function readLegacyBoundaries(env) {
  try {
    const boundaries = await boundaryStore(env).get(LEGACY_STORE_KEY, {
      type: "json"
    });
    return Array.isArray(boundaries) ? boundaries : [];
  } catch {
    return [];
  }
}

async function readWorkspaceBoundariesRaw(env, workspaceId) {
  try {
    const boundaries = await boundaryStore(env).get(boundariesKey(workspaceId), {
      type: "json"
    });
    return Array.isArray(boundaries) ? boundaries : [];
  } catch {
    return [];
  }
}

// Read every boundary visible to a set of workspace ids: union of the
// per-workspace keys PLUS a read-only fallback to the legacy global key
// (filtered to the same ids) so nothing disappears before the migration runs.
// De-duped by id with the per-workspace key winning over a stale legacy row.
async function readBoundariesForIds(env, workspaceIds) {
  const ids = workspaceIdSet(workspaceIds);
  const seen = new Set();
  const out = [];
  const lists = await Promise.all([...ids].map((id) => readWorkspaceBoundariesRaw(env, id)));
  for (const list of lists) {
    for (const boundary of list) {
      if (boundary && boundary.id && !seen.has(boundary.id)) { seen.add(boundary.id); out.push(boundary); }
    }
  }
  const legacy = await readLegacyBoundaries(env);
  for (const boundary of legacy) {
    const wsId = boundary?.workspaceId || LEGACY_WORKSPACE_ID;
    if (ids.has(wsId) && boundary?.id && !seen.has(boundary.id)) { seen.add(boundary.id); out.push(boundary); }
  }
  return out;
}

// Atomic read-modify-write of ONE workspace's boundaries list (the Hard No
// list). The compare-and-set coordinator serializes this across isolates so a
// partner adding/removing a different boundary can no longer clobber a
// concurrent edit — a lost Hard No is a consent-safety bug; the cap + version
// are now scoped to a single workspace key. `mutateFreshList` receives the
// current (migrated) list for THIS workspace and returns the new list, or null
// for "no change". All validation/async work must happen BEFORE this call: the
// transform is synchronous and may run more than once on a version retry, so it
// re-derives the fresh list and must re-locate any target by id inside the
// closure. When the per-workspace key is still empty (pre-migration), the fresh
// list is seeded read-only from the legacy global key (filtered to this
// workspace) so edits/deletes compose and the first write adopts legacy rows;
// the legacy key itself is never written.
async function writeWorkspaceBoundariesAtomic(env, workspaceId, mutateFreshList, options = {}) {
  const legacyPeople = options.legacyPeople || await legacyPeopleForEnv(env);
  const legacySeed = options.legacySeed
    || (await readLegacyBoundaries(env))
      .filter((boundary) => (boundary?.workspaceId || LEGACY_WORKSPACE_ID) === workspaceId);
  return mutateKey(env, STORE_NAME, boundariesKey(workspaceId), (raw) => {
    const base = Array.isArray(raw) && raw.length ? raw : legacySeed;
    const fresh = base.map((boundary) => migrate(boundary, legacyPeople));
    const next = mutateFreshList(fresh);
    if (next == null) return { write: false, result: fresh };
    const capped = next.slice(0, MAX_BOUNDARIES);
    return { value: capped, result: capped };
  });
}

function migrate(boundary, legacyPeople = {}) {
  const addedByEmail = boundary.addedByEmail
    || legacyEmailForName(boundary.addedBy, legacyPeople);
  const encryptedText = cleanRoomEncryptedBox(boundary.encryptedText, 12000);

  const { category: _droppedCategory, ...rest } = boundary;
  const migrated = {
    ...rest,
    workspaceId: boundary.workspaceId || LEGACY_WORKSPACE_ID,
    text: cleanBoundaryText(boundary.text),
    type: cleanType(boundary.type),
    addedByEmail: normalizeEmail(addedByEmail),
    addedByName: boundary.addedByName || boundary.addedBy || legacyNameForEmail(addedByEmail, legacyPeople) || "",
    createdAt: boundary.createdAt || new Date().toISOString(),
    updatedAt: boundary.updatedAt || boundary.createdAt || new Date().toISOString()
  };
  if (encryptedText) migrated.encryptedText = encryptedText;
  else delete migrated.encryptedText;
  return migrated;
}

function workspaceIdSet(workspaceIds) {
  return new Set((Array.isArray(workspaceIds) ? workspaceIds : [workspaceIds]).filter(Boolean));
}

function forWorkspace(boundaries, workspaceIds) {
  const ids = workspaceIdSet(workspaceIds);
  return boundaries.filter((boundary) => ids.has(boundary.workspaceId));
}

// A per-workspace write only returns the written workspace's rows. Recombine
// them with the rest of the data-access set (e.g. legacy-couple rows under a
// different key) so the API response still reflects everything visible.
function recombineForResponse(allRows, writtenWorkspaceId, writtenRows, workspaceIds) {
  return forWorkspace(
    [...allRows.filter((boundary) => boundary.workspaceId !== writtenWorkspaceId), ...writtenRows],
    workspaceIds
  );
}

export async function readBoundariesForWorkspace(env, workspaceId, options = {}) {
  const legacyPeople = options.legacyPeople || await legacyPeopleForEnv(env);
  const workspaceIds = options.workspaceIds || workspaceId;
  const all = (await readBoundariesForIds(env, workspaceIds)).map((boundary) => migrate(boundary, legacyPeople));
  return {
    workspaceId,
    boundaries: forWorkspace(all, workspaceIds)
  };
}

function partnerEmails(workspace, excludeEmail) {
  const exclude = normalizeEmail(excludeEmail);
  return (workspace.members || [])
    .filter((member) => member.status === "active" && normalizeEmail(member.email) !== exclude)
    .map((member) => member.email);
}

function ownsBoundary(boundary, actorEmail) {
  const owner = normalizeEmail(boundary?.addedByEmail);
  return Boolean(owner) && owner === normalizeEmail(actorEmail);
}

function roomE2eeRequired(workspace) {
  return Boolean(workspace?.settings?.roomE2eeEnabled);
}

export async function onRequest(context) {
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;

  const env = context.env;
  const legacyPeople = await legacyPeopleForEnv(env);
  const request = context.request;
  const method = request.method.toUpperCase();
  const queryWorkspace = workspaceIdFromRequest(request);

  if (method === "GET") {
    const access = await authorizeWorkspaceAccess(context, identity, queryWorkspace);
    if (!access.ok) return access.response;
    const dataWorkspaceIds = access.dataWorkspaceIds;
    const all = (await readBoundariesForIds(env, dataWorkspaceIds)).map((boundary) => migrate(boundary, legacyPeople));
    return jsonResponse(200, {
      workspaceId: access.workspace.id,
      boundaries: forWorkspace(all, dataWorkspaceIds)
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
  const all = (await readBoundariesForIds(env, dataWorkspaceIds)).map((boundary) => migrate(boundary, legacyPeople));
  const now = new Date().toISOString();

  async function notifyChange() {
    const recipients = partnerEmails(workspace, actorEmail);
    if (!recipients.length) return;
    await Promise.all(recipients.map((email) => sendBoundaryChangeEmail(env, {
      to: email,
      fromName: actorName,
      dashboardUrl: trustedOrigin(env, request) || "/",
      workspaceDisplayName: workspace.displayName
    }))).catch(() => {});
  }

  if (method === "POST") {
    const encryptedText = cleanRoomEncryptedBox(payload.encryptedText, 12000);
    if (roomE2eeRequired(workspace) && !encryptedText) {
      return jsonResponse(400, { error: "Room Encryption requires encrypted Limits." });
    }
    const text = encryptedText ? "Encrypted limit" : cleanBoundaryText(payload.text);
    const type = cleanType(payload.type);
    if (!text) return jsonResponse(400, { error: "Boundary text is required" });

    const duplicate = all.find((boundary) => {
      if (encryptedText || boundary.encryptedText) return false;
      return dataWorkspaceIds.includes(boundary.workspaceId)
        && boundary.text.toLowerCase() === text.toLowerCase()
        && boundary.type === type;
    });

    if (duplicate) {
      return jsonResponse(200, {
        boundary: duplicate,
        boundaries: forWorkspace(all, dataWorkspaceIds),
        workspaceId: workspace.id
      });
    }

    const boundary = {
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      text,
      type,
      addedByEmail: actorEmail,
      addedByName: actorName,
      createdAt: now,
      updatedAt: now
    };
    if (encryptedText) boundary.encryptedText = encryptedText;

    const nextWorkspaceBoundaries = await writeWorkspaceBoundariesAtomic(env, workspace.id, (fresh) => {
      // Idempotent on a CAS retry: only prepend if this id isn't already present.
      if (fresh.some((item) => item.id === boundary.id)) return null;
      return [boundary, ...fresh];
    }, { legacyPeople });
    const next = recombineForResponse(all, workspace.id, nextWorkspaceBoundaries, dataWorkspaceIds);
    await appendAudit(env, workspace.id, {
      type: "boundary_created",
      actorEmail,
      actorName,
      entityType: "boundary",
      entityId: boundary.id,
      metadata: { boundaryType: type }
    });
    await notifyChange();

    return jsonResponse(201, {
    boundary,
    boundaries: forWorkspace(next, dataWorkspaceIds),
    workspaceId: workspace.id
  });
}

  const id = cleanText(payload.id, 64);
  const index = all.findIndex((boundary) => boundary.id === id && dataWorkspaceIds.includes(boundary.workspaceId));
  if (index === -1) return jsonResponse(404, { error: "Boundary not found" });

  const existing = all[index];
  if (!ownsBoundary(existing, actorEmail)) {
    return jsonResponse(403, { error: "Only the person who added this limit can change it." });
  }

  if (method === "PATCH") {
    const hasText = Object.prototype.hasOwnProperty.call(payload, "text");
    const encryptedText = cleanRoomEncryptedBox(payload.encryptedText, 12000);
    if (roomE2eeRequired(workspace) && hasText && !encryptedText) {
      return jsonResponse(400, { error: "Room Encryption requires encrypted Limits." });
    }
    const text = encryptedText ? "Encrypted limit" : cleanBoundaryText(hasText ? payload.text : existing.text);
    const type = cleanType(payload.type || existing.type);
    if (!text) return jsonResponse(400, { error: "Boundary text is required" });

    const { category: _droppedCategory, ...existingRest } = existing;
    const next = {
      ...existingRest,
      text,
      type,
      updatedAt: now,
      updatedByEmail: actorEmail,
      updatedByName: actorName
    };
    if (encryptedText) next.encryptedText = encryptedText;
    else if (hasText) delete next.encryptedText;

    // Re-locate by id inside the fresh list so a partner editing a different
    // boundary composes instead of being clobbered. No-op if it vanished.
    const nextWorkspaceBoundaries = await writeWorkspaceBoundariesAtomic(env, existing.workspaceId, (fresh) => {
      if (!fresh.some((item) => item.id === existing.id)) return null;
      return fresh.map((item) => item.id === existing.id ? next : item);
    }, { legacyPeople });
    const nextAll = recombineForResponse(all, existing.workspaceId, nextWorkspaceBoundaries, dataWorkspaceIds);
    await appendAudit(env, workspace.id, {
      type: "boundary_updated",
      actorEmail,
      actorName,
      entityType: "boundary",
      entityId: next.id,
      metadata: { boundaryType: type }
    });
    await notifyChange();

    return jsonResponse(200, {
      boundary: next,
      boundaries: forWorkspace(nextAll, dataWorkspaceIds),
      workspaceId: workspace.id
    });
  }

  // DELETE — filter by id inside the fresh list so it survives concurrent
  // edits to other boundaries.
  const nextWorkspaceBoundaries = await writeWorkspaceBoundariesAtomic(env, existing.workspaceId, (fresh) => fresh.filter((item) => item.id !== existing.id), { legacyPeople });
  const nextAll = recombineForResponse(all, existing.workspaceId, nextWorkspaceBoundaries, dataWorkspaceIds);
  await appendAudit(env, workspace.id, {
    type: "boundary_deleted",
    actorEmail,
    actorName,
    entityType: "boundary",
    entityId: existing.id,
    metadata: { boundaryType: existing.type }
  });
  await notifyChange();

  return jsonResponse(200, {
    boundaries: forWorkspace(nextAll, dataWorkspaceIds),
    workspaceId: workspace.id
  });
}
