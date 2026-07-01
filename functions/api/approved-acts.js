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
import { checkRateLimit, rateLimitResponse } from "./_rate_limit.js";
import { cleanRoomEncryptedBox } from "./_e2ee.js";
import { mutateKey } from "./_state.js";

// Strip a leading emoji + whitespace from a label so we can match
// "🌶️ Pegging" against an existing "Pegging" entry for dedup purposes.
const LEADING_EMOJI_RE = /^[\p{Extended_Pictographic}\p{Emoji_Presentation}](?:️)?(?:‍[\p{Extended_Pictographic}\p{Emoji_Presentation}](?:️)?)*\s*/u;
function stripLeadingEmoji(label) {
  return String(label || "").replace(LEADING_EMOJI_RE, "");
}

const STORE_NAME = "sexualsync-approved-acts";
// C3 — acts are now keyed per workspace so the MAX_ACTS cap and the CAS version
// are scoped to one couple. The bare "acts" key is retained ONLY as a read-time
// legacy fallback (pre-migration data) and as a seed for the first per-workspace
// write; new writes never touch it. See scripts/migrate-store-keys.mjs.
const LEGACY_STORE_KEY = "acts";
// Exported so the E2EE migration routes (status/reencrypt) mutate the SAME
// per-workspace key the handlers do, instead of the dead legacy global key.
export function actsKey(workspaceId) { return `acts:${workspaceId}`; }
const MAX_ACTS = 400;
const MAX_LABEL_LENGTH = 100;
const MAX_TAGS = 8;
const MAX_ICON_LENGTH = 8;

const VALID_TAGS = new Set([
  "soft", "rough", "oral", "penetration", "massage", "toy", "roleplay",
  "quick", "slow", "talk-first", "kink", "position", "experimental", "romantic"
]);

const VALID_COMFORT = new Set(["favorite", "curious", "maybe", "no", "needs_prep"]);

function actStore(env) {
  return getStore(env, STORE_NAME);
}

function cleanLabel(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);
}

function cleanIcon(value) {
  // No default fallback. Custom Acts render from their label unless the user
  // explicitly supplies an icon.
  const cleaned = String(value || "").trim().slice(0, MAX_ICON_LENGTH);
  return cleaned;
}

function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((tag) => String(tag || "").toLowerCase().trim()).filter((tag) => VALID_TAGS.has(tag)))].slice(0, MAX_TAGS);
}

function cleanComfort(value) {
  if (!value || typeof value !== "object") return {};
  const result = {};
  Object.entries(value).forEach(([email, level]) => {
    const cleanEmail = normalizeEmail(email);
    if (cleanEmail && VALID_COMFORT.has(level)) {
      result[cleanEmail] = level;
    }
  });
  return result;
}

function roomE2eeRequired(workspace) {
  return Boolean(workspace?.settings?.roomE2eeEnabled);
}

// Read-only legacy fallback: the bare global key from before per-workspacing.
async function readLegacyActs(env) {
  try {
    const acts = await actStore(env).get(LEGACY_STORE_KEY, { type: "json" });
    return Array.isArray(acts) ? acts : [];
  } catch {
    return [];
  }
}

async function readWorkspaceActsRaw(env, workspaceId) {
  try {
    const acts = await actStore(env).get(actsKey(workspaceId), { type: "json" });
    return Array.isArray(acts) ? acts : [];
  } catch {
    return [];
  }
}

// Read every act visible to a set of workspace ids: union of the per-workspace
// keys PLUS a read-only fallback to the legacy global key (filtered to the same
// ids) so nothing disappears before the migration runs. De-duped by act id with
// the per-workspace key winning over a stale legacy row.
async function readActsForIds(env, workspaceIds) {
  const ids = workspaceIdSet(workspaceIds);
  const seen = new Set();
  const out = [];
  const lists = await Promise.all([...ids].map((id) => readWorkspaceActsRaw(env, id)));
  for (const list of lists) {
    for (const act of list) {
      if (act && act.id && !seen.has(act.id)) { seen.add(act.id); out.push(act); }
    }
  }
  const legacy = await readLegacyActs(env);
  for (const act of legacy) {
    const wsId = act?.workspaceId || LEGACY_WORKSPACE_ID;
    if (ids.has(wsId) && act?.id && !seen.has(act.id)) { seen.add(act.id); out.push(act); }
  }
  return out;
}

// Atomic read-modify-write of ONE workspace's acts list. The compare-and-set
// coordinator serializes this across isolates so concurrent partner edits to
// different acts compose instead of clobbering each other (see _state.js); the
// cap + version are now scoped to a single workspace key. `mutateFreshList`
// receives the current (migrated) list for THIS workspace and returns the new
// list, or null for "no change". All validation/async work must happen BEFORE
// this call: the transform is synchronous and may run more than once on a
// version retry, so it re-derives the fresh list and must re-locate any target
// by id inside it. When the per-workspace key is still empty (pre-migration),
// the fresh list is seeded from the legacy global key (filtered to this
// workspace) so edits/deletes compose against legacy rows and the first write
// adopts them.
//
// Writes target ONLY the per-workspace key. The legacy global key is never
// written by the runtime — it is a read-only fallback (readActsForIds de-dupes
// with the per-ws row winning) plus a one-time seed for the first per-workspace
// write, and is retired by the offline migration (scripts/migrate-store-keys.mjs).
async function writeWorkspaceActsAtomic(env, workspaceId, mutateFreshList, options = {}) {
  const legacyPeople = options.legacyPeople || await legacyPeopleForEnv(env);
  const legacySeed = options.legacySeed
    || (await readLegacyActs(env))
      .filter((act) => (act?.workspaceId || LEGACY_WORKSPACE_ID) === workspaceId);
  const written = await mutateKey(env, STORE_NAME, actsKey(workspaceId), (raw) => {
    const base = Array.isArray(raw) && raw.length ? raw : legacySeed;
    const fresh = base.map((act) => migrate(act, legacyPeople));
    const next = mutateFreshList(fresh);
    if (next == null) return { write: false, result: fresh };
    const capped = next.slice(0, MAX_ACTS);
    return { value: capped, result: capped };
  });
  return written;
}

function migrate(act, legacyPeople = {}) {
  const addedByEmail = act.addedByEmail
    || legacyEmailForName(act.addedBy, legacyPeople);
  const approvedByEmail = act.approvedByEmail
    || legacyEmailForName(act.approvedBy, legacyPeople);

  const encryptedPayload = cleanRoomEncryptedBox(act.encryptedPayload, 12000);
  const migrated = {
    ...act,
    workspaceId: act.workspaceId || LEGACY_WORKSPACE_ID,
    label: encryptedPayload ? "Encrypted act" : cleanLabel(act.label),
    icon: cleanIcon(act.icon),
    tags: encryptedPayload ? [] : cleanTags(act.tags),
    comfort: cleanComfort(act.comfort),
    addedByEmail: normalizeEmail(addedByEmail),
    addedByName: act.addedByName || act.addedBy || legacyNameForEmail(addedByEmail, legacyPeople) || "",
    approvedByEmail: normalizeEmail(approvedByEmail),
    approvedByName: act.approvedByName || act.approvedBy || legacyNameForEmail(approvedByEmail, legacyPeople) || "",
    source: act.source || "custom",
    createdAt: act.createdAt || new Date().toISOString(),
    updatedAt: act.updatedAt || act.createdAt || new Date().toISOString()
  };
  if (encryptedPayload) migrated.encryptedPayload = encryptedPayload;
  else delete migrated.encryptedPayload;
  return migrated;
}

function sortByLabel(acts) {
  return [...acts].sort((a, b) => (a.label || "").localeCompare(b.label || ""));
}

function workspaceIdSet(workspaceIds) {
  return new Set((Array.isArray(workspaceIds) ? workspaceIds : [workspaceIds]).filter(Boolean));
}

function forWorkspace(acts, workspaceIds) {
  const ids = workspaceIdSet(workspaceIds);
  return sortByLabel(acts.filter((act) => ids.has(act.workspaceId)));
}

// A per-workspace write only returns the written workspace's rows. Recombine
// them with the rest of the data-access set (e.g. legacy-couple rows that live
// under a different key) so the API response still reflects everything visible.
function recombineForResponse(allRows, writtenWorkspaceId, writtenRows, workspaceIds) {
  return forWorkspace(
    [...allRows.filter((act) => act.workspaceId !== writtenWorkspaceId), ...writtenRows],
    workspaceIds
  );
}

export async function readActsForWorkspace(env, workspaceId, options = {}) {
  const legacyPeople = options.legacyPeople || await legacyPeopleForEnv(env);
  const workspaceIds = options.workspaceIds || workspaceId;
  const all = (await readActsForIds(env, workspaceIds)).map((act) => migrate(act, legacyPeople));
  return {
    workspaceId,
    acts: forWorkspace(all, workspaceIds)
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

  if (method === "GET") {
    const access = await authorizeWorkspaceAccess(context, identity, queryWorkspace);
    if (!access.ok) return access.response;

    const dataWorkspaceIds = access.dataWorkspaceIds;
    const all = (await readActsForIds(env, dataWorkspaceIds)).map((act) => migrate(act, legacyPeople));
    const workspaceActs = forWorkspace(all, dataWorkspaceIds);

    return jsonResponse(200, {
      workspaceId: access.workspace.id,
      acts: workspaceActs
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
  const all = (await readActsForIds(env, dataWorkspaceIds)).map((act) => migrate(act, legacyPeople));
  const now = new Date().toISOString();
  const limited = await checkRateLimit(env, {
    bucket: `approved-acts-${method}`,
    key: `${actorEmail}:${workspace.id}`,
    limit: 60,
    windowSeconds: 10 * 60
  });
  if (!limited.ok) return rateLimitResponse(limited.retryAfter);

  if (method === "POST") {
    const encryptedPayload = cleanRoomEncryptedBox(payload.encryptedPayload, 12000);
    if (roomE2eeRequired(workspace) && !encryptedPayload) {
      return jsonResponse(400, { error: "Room Encryption requires encrypted Acts." });
    }
    const rawLabel = encryptedPayload ? "Encrypted act" : cleanLabel(payload.label || payload.text);
    if (!rawLabel) return jsonResponse(400, { error: "Act label is required" });
    const label = rawLabel;

    const existing = encryptedPayload ? null : all.find((act) => {
      // Match by normalised text (emoji-stripped) so "Pegging" and
      // "🌶️ Pegging" don't both end up in the library.
      return dataWorkspaceIds.includes(act.workspaceId)
        && stripLeadingEmoji(act.label).toLowerCase() === stripLeadingEmoji(label).toLowerCase();
    });

    if (existing) {
      return jsonResponse(200, {
        act: existing,
        acts: forWorkspace(all, dataWorkspaceIds),
        workspaceId: workspace.id
      });
    }

    const act = {
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      label,
      icon: cleanIcon(payload.icon),
      tags: encryptedPayload ? [] : cleanTags(payload.tags),
      comfort: typeof payload.myComfort === "string" && VALID_COMFORT.has(payload.myComfort)
        ? { [actorEmail]: payload.myComfort }
        : {},
      source: ["custom", "approved_counter", "fantasy_promoted"].includes(payload.source) ? payload.source : "custom",
      addedByEmail: actorEmail,
      addedByName: actorName,
      approvedByEmail: ["approved_counter", "fantasy_promoted"].includes(payload.source) ? actorEmail : "",
      approvedByName: ["approved_counter", "fantasy_promoted"].includes(payload.source) ? actorName : "",
      createdAt: now,
      updatedAt: now
    };
    if (encryptedPayload) act.encryptedPayload = encryptedPayload;

    const nextWorkspaceActs = await writeWorkspaceActsAtomic(env, workspace.id, (fresh) => {
      // Idempotent on a CAS retry: only append if this id isn't already present.
      if (fresh.some((item) => item.id === act.id)) return null;
      return [...fresh, act];
    }, { legacyPeople });
    const next = recombineForResponse(all, workspace.id, nextWorkspaceActs, dataWorkspaceIds);
    await appendAudit(env, workspace.id, {
      type: "act_created",
      actorEmail,
      actorName,
      entityType: "act",
      entityId: act.id,
      metadata: { source: act.source }
    });

    return jsonResponse(201, {
      act,
      acts: forWorkspace(next, dataWorkspaceIds),
      workspaceId: workspace.id
    });
  }

  const id = cleanText(payload.id, 64);
  const index = all.findIndex((act) => act.id === id && dataWorkspaceIds.includes(act.workspaceId));
  if (index === -1) return jsonResponse(404, { error: "Act not found" });

  if (method === "PATCH") {
    const existing = all[index];
    const next = { ...existing, updatedAt: now };

    if (Object.prototype.hasOwnProperty.call(payload, "label")) {
      const encryptedPayload = cleanRoomEncryptedBox(payload.encryptedPayload, 12000);
      if (roomE2eeRequired(workspace) && !encryptedPayload) {
        return jsonResponse(400, { error: "Room Encryption requires encrypted Acts." });
      }
      const label = encryptedPayload ? "Encrypted act" : cleanLabel(payload.label);
      if (!label) return jsonResponse(400, { error: "Act label is required" });
      const duplicate = encryptedPayload ? null : all.find((act) => {
        return act.id !== id
          && dataWorkspaceIds.includes(act.workspaceId)
          && stripLeadingEmoji(act.label).toLowerCase() === stripLeadingEmoji(label).toLowerCase();
      });
      if (duplicate) return jsonResponse(409, { error: "Another act already uses that label" });
      next.label = label;
      if (encryptedPayload) {
        next.tags = [];
        next.encryptedPayload = encryptedPayload;
      } else {
        delete next.encryptedPayload;
      }
    }

    if (Object.prototype.hasOwnProperty.call(payload, "icon")) {
      next.icon = cleanIcon(payload.icon);
    }

    if (Object.prototype.hasOwnProperty.call(payload, "tags")) {
      const encryptedPayload = cleanRoomEncryptedBox(payload.encryptedPayload, 12000);
      if (roomE2eeRequired(workspace) && !encryptedPayload) {
        return jsonResponse(400, { error: "Room Encryption requires encrypted Acts." });
      }
      if (encryptedPayload) {
        next.label = "Encrypted act";
        next.tags = [];
        next.encryptedPayload = encryptedPayload;
      } else {
        next.tags = cleanTags(payload.tags);
      }
    }

    if (Object.prototype.hasOwnProperty.call(payload, "comfort")) {
      return jsonResponse(400, { error: "Use myComfort to update only your own comfort level." });
    }

    // comfort is the one PATCH field that MERGES with prior state (it's a
    // per-partner map). Don't bake the actor's merge against the stale snapshot
    // into `next` — that would clobber a partner who concurrently changed THEIR
    // own comfort on this same act. Instead capture the actor-scoped delta and
    // apply it against the fresh act inside the transform below.
    let comfortPatch = null; // null = leave comfort untouched
    if (typeof payload.myComfort === "string" && VALID_COMFORT.has(payload.myComfort)) {
      comfortPatch = { op: "set", value: payload.myComfort };
    } else if (typeof payload.myComfort === "string" && payload.myComfort === "clear") {
      comfortPatch = { op: "clear" };
    }
    // Carry the snapshot comfort through for fields-only patches; the transform
    // overrides this with the fresh+delta value when comfortPatch is set.
    next.comfort = existing.comfort || {};

    next.updatedByEmail = actorEmail;
    next.updatedByName = actorName;

    const nextWorkspaceActs = await writeWorkspaceActsAtomic(env, existing.workspaceId, (fresh) => {
      if (!fresh.some((act) => act.id === existing.id)) return null;
      return fresh.map((act) => {
        if (act.id !== existing.id) return act;
        if (!comfortPatch) return next;
        // Apply the actor's comfort delta onto the FRESH act's comfort map so a
        // concurrent partner comfort edit on this act is preserved.
        const merged = { ...(act.comfort || {}) };
        if (comfortPatch.op === "set") merged[actorEmail] = comfortPatch.value;
        else delete merged[actorEmail];
        return { ...next, comfort: merged };
      });
    }, { legacyPeople });
    const nextAll = recombineForResponse(all, existing.workspaceId, nextWorkspaceActs, dataWorkspaceIds);
    const updatedAct = nextAll.find((act) => act.id === existing.id) || next;
    await appendAudit(env, workspace.id, {
      type: "act_updated",
      actorEmail,
      actorName,
      entityType: "act",
      entityId: updatedAct.id
    });

    return jsonResponse(200, {
      act: updatedAct,
      acts: forWorkspace(nextAll, dataWorkspaceIds),
      workspaceId: workspace.id
    });
  }

  // DELETE — filter by id inside the fresh list so it survives concurrent
  // edits to other acts.
  const existing = all[index];
  const nextWorkspaceActs = await writeWorkspaceActsAtomic(env, existing.workspaceId, (fresh) => fresh.filter((act) => act.id !== existing.id), { legacyPeople });
  const nextAll = recombineForResponse(all, existing.workspaceId, nextWorkspaceActs, dataWorkspaceIds);
  await appendAudit(env, workspace.id, {
    type: "act_deleted",
    actorEmail,
    actorName,
    entityType: "act",
    entityId: existing.id
  });

  return jsonResponse(200, {
    acts: forWorkspace(nextAll, dataWorkspaceIds),
    workspaceId: workspace.id
  });
}
