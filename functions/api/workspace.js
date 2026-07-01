import { getStore } from "./_kv.js";
import { mutateKey } from "./_state.js";
import {
  APP_NAME,
  LEGACY_WORKSPACE_ID,
  getAuthenticatedIdentity,
  isMemberOfWorkspace,
  jsonResponse,
  normalizeEmail
} from "./_auth.js";
import {
  cleanText,
  findWorkspace,
  mutatePlatformState
} from "./_workspaces.js";
import { appendAudit, auditStore } from "./_audit.js";
import { sendDeletionScheduledEmail } from "./_email.js";
import { trustedOrigin } from "./_origin.js";
import { closeLiveRoomActor, closeLiveRoomWorkspace } from "./_live_room.js";
import { revokeReviewerTokens, revokeWorkspaceTokens } from "./_tokens.js";
import { deleteVaultForWorkspace } from "./_vault.js";

const DELETION_GRACE_DAYS = 7;

// C3 — these stores moved from a single global key to one key per workspace.
// `key` is the legacy global key (still filtered on purge for pre-migration
// rows); `perKey(workspaceId)` is the new per-workspace key (deleted directly).
const SCOPED_STORES = [
  { name: "sexualsync-request-board", key: "requests", perKey: (w) => `requests:${w}` },
  { name: "sexualsync-boundaries", key: "boundaries", perKey: (w) => `boundaries:${w}` },
  { name: "sexualsync-approved-acts", key: "acts", perKey: (w) => `acts:${w}` },
  { name: "sexualsync-ideas", key: "ideas", perKey: (w) => `ideas:${w}` },
  { name: "sexualsync-ideas", key: "graveyard", perKey: (w) => `graveyard:${w}` },
  { name: "sexualsync-ideas", key: "blindReveals", perKey: (w) => `blindReveals:${w}` }
];

const DIRECT_WORKSPACE_STORES = [
  { name: "sexualsync-ideas", key: (workspaceId) => `kink-nudges:${workspaceId}` },
  { name: "sexualsync-shelf", key: (workspaceId) => `shelf:${workspaceId}` },
  { name: "sexualsync-vault", key: (workspaceId) => `vault:${workspaceId}` },
  { name: "sexualsync-pile", key: (workspaceId) => `pile:${workspaceId}:active` },
  { name: "sexualsync-pile", key: (workspaceId) => `pile:${workspaceId}:sessions` },
  { name: "sexualsync-sex-quiz", key: (workspaceId) => `sexQuiz:${workspaceId}` },
  { name: "sexualsync-green-lights", key: (workspaceId) => `greenLights:${workspaceId}` },
  { name: "sexualsync-activity", key: (workspaceId) => `events:${workspaceId}` },
  { name: "sexualsync-activity", key: (workspaceId) => `read:${workspaceId}` },
  { name: "sexualsync-feedback", key: (workspaceId) => `feedback:${workspaceId}` },
  { name: "sexualsync-presence", key: (workspaceId) => `presence:${workspaceId}` },
  { name: "sexualsync-push-stats", key: (workspaceId) => `last-delivered:${workspaceId}` },
  { name: "sexualsync-approved-acts", key: (workspaceId) => `emoji-backfill:${workspaceId}` },
  { name: "sexualsync-prompt-cache", key: (workspaceId) => `prompts:pool:v1:${workspaceId}:confidence` },
  { name: "sexualsync-prompt-cache", key: (workspaceId) => `prompts:pool:v1:${workspaceId}:curiosity` },
  { name: "sexualsync-push-body-cache", key: (workspaceId) => `pushbody:v1:${workspaceId}:request-sent` },
  { name: "sexualsync-push-body-cache", key: (workspaceId) => `pushbody:v1:${workspaceId}:request-reviewed` },
  { name: "sexualsync-push-body-cache", key: (workspaceId) => `pushbody:v1:${workspaceId}:fantasy-shared` },
  { name: "sexualsync-push-body-cache", key: (workspaceId) => `pushbody:v1:${workspaceId}:fantasy-reaction` },
  { name: "sexualsync-push-body-cache", key: (workspaceId) => `pushbody:v1:${workspaceId}:fantasy-comment` }
];

async function purgeScopedStore(env, storeName, key, perKey, workspaceId) {
  // C3 — with per-workspace keys, this workspace's rows live entirely under its
  // own key, so the purge is now a direct key delete (cheap, no CAS contention).
  try {
    await getStore(env, storeName).delete(perKey(workspaceId));
  } catch {
    // Best effort.
  }

  // Also filter the LEGACY global key for any pre-migration rows still tagged to
  // this workspace. CAS this filter-write through the coordinator (see
  // _state.js) so a best-effort purge can't clobber a concurrent edit to another
  // workspace's rows in the same legacy list — otherwise a delete racing a live
  // write could resurrect intimate data we just removed (right-to-deletion gap).
  // The transform is synchronous and may re-run on a version retry, so keep it
  // pure. Once the legacy key is empty, this is a cheap no-op.
  const filterOut = (items) => items.filter((item) => (item.workspaceId || LEGACY_WORKSPACE_ID) !== workspaceId);
  try {
    await mutateKey(env, storeName, key, (raw) => {
      const items = Array.isArray(raw) ? raw : [];
      const remaining = filterOut(items);
      return remaining.length !== items.length ? { value: remaining } : { write: false };
    });
  } catch {
    // Best effort. Partial purges don't block the workspace deletion record.
  }
}

async function purgeAuditForWorkspace(env, workspaceId) {
  try {
    const store = auditStore(env);
    await store.delete(`workspace-${workspaceId}`);
  } catch {
    // Best effort.
  }
}

async function deleteStoreKey(env, storeName, key) {
  try {
    const store = getStore(env, storeName);
    await store.delete(key);
  } catch {
    // Best effort.
  }
}

async function deleteRawStoreKey(env, key) {
  try {
    await env?.STORE?.delete(key);
  } catch {
    // Best effort.
  }
}

function workspaceEmails(workspace) {
  return [...new Set((workspace?.members || []).map((member) => normalizeEmail(member.email)).filter(Boolean))];
}

async function purgeWorkspaceData(env, workspace) {
  const workspaceId = typeof workspace === "string" ? workspace : workspace?.id;
  if (!workspaceId) return;
  await Promise.all(SCOPED_STORES.map((entry) => purgeScopedStore(env, entry.name, entry.key, entry.perKey, workspaceId)));
  await deleteVaultForWorkspace(env, workspaceId);
  await Promise.all(DIRECT_WORKSPACE_STORES.map((entry) => deleteStoreKey(env, entry.name, entry.key(workspaceId))));
  await deleteRawStoreKey(env, `push:subscriptions:${workspaceId}`);
  await Promise.all(workspaceEmails(workspace).map((email) => {
    return deleteStoreKey(env, "sexualsync-push-stats", `last-test:${workspaceId}:${email}`);
  }));
  await revokeWorkspaceTokens(env, workspaceId);
  await purgeAuditForWorkspace(env, workspaceId);
}

function isOwner(workspace, email) {
  const normalized = normalizeEmail(email);
  return (workspace?.members || []).some((member) => {
    return normalizeEmail(member.email) === normalized && member.status === "active" && member.role === "owner";
  });
}

function isLastActiveMember(workspace, email) {
  const normalized = normalizeEmail(email);
  const active = (workspace?.members || []).filter((member) => member.status === "active");
  return active.length === 1 && normalizeEmail(active[0].email) === normalized;
}

function workspacePartnerEmails(workspace, excludeEmail) {
  const exclude = normalizeEmail(excludeEmail);
  return (workspace.members || [])
    .filter((member) => normalizeEmail(member.email) !== exclude && member.status === "active")
    .map((member) => member.email);
}

export async function onRequest(context) {
  const auth = await getAuthenticatedIdentity(context);
  if (!auth.ok) return auth.response;

  const env = context.env;
  const request = context.request;
  const method = request.method.toUpperCase();

  if (!["POST", "PATCH", "DELETE"].includes(method)) {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  let payload = {};
  try { payload = await request.json(); }
  catch { return jsonResponse(400, { error: "Expected JSON body" }); }

  const workspaceId = cleanText(payload.workspaceId, 64);
  if (!workspaceId) return jsonResponse(400, { error: "workspaceId is required." });

	  const now = new Date().toISOString();
	  const action = String(payload.action || "");

  const mutation = await mutatePlatformState(env, ({ workspaces, invites }) => {
	    const workspace = findWorkspace(workspaces, workspaceId);
	    if (!workspace) return { abort: jsonResponse(404, { error: "Workspace not found." }) };
	    if (!isMemberOfWorkspace(workspace, auth.email)) return { abort: jsonResponse(403, { error: "This workspace is not yours." }) };
	    const replace = (next) => workspaces.map((item) => item.id === workspace.id ? next : item);
	    const actorMember = (workspace.members || []).find((member) => normalizeEmail(member.email) === normalizeEmail(auth.email));
	    const actorName = actorMember?.displayName || "";

    if (action === "schedule_deletion") {
      if (!isOwner(workspace, auth.email)) return { abort: jsonResponse(403, { error: "Only an owner can schedule deletion." }) };
      const expectedName = workspace.displayName || workspace.name;
      if (cleanText(payload.confirmation || "", 200) !== expectedName) {
        return { abort: jsonResponse(400, { error: `Type the workspace name to confirm: ${expectedName}` }) };
      }
      const completeAt = new Date(new Date(now).getTime() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);
      const next = {
        ...workspace,
        status: "deletion_pending",
        updatedAt: now,
        deletion: {
          scheduledAt: now,
          scheduledByEmail: auth.email,
          scheduledByName: actorName,
          completeAt: completeAt.toISOString()
        }
      };
	      return {
	        workspaces: replace(next),
	        result: { action, workspace: next, partnerEmails: workspacePartnerEmails(workspace, auth.email), completeAt: completeAt.toISOString(), actorName }
	      };
	    }

    if (action === "cancel_deletion") {
      if (!isOwner(workspace, auth.email)) return { abort: jsonResponse(403, { error: "Only an owner can cancel deletion." }) };
      if (workspace.status !== "deletion_pending") return { abort: jsonResponse(400, { error: "This workspace is not pending deletion." }) };
      const next = { ...workspace, status: "active", updatedAt: now, deletion: null };
	      return { workspaces: replace(next), result: { action, workspace: next, actorName } };
    }

    if (action === "finalize_deletion") {
      if (!isOwner(workspace, auth.email)) return { abort: jsonResponse(403, { error: "Only an owner can finalize deletion." }) };
      if (workspace.status !== "deletion_pending") return { abort: jsonResponse(400, { error: "This workspace is not pending deletion." }) };
      const completeAt = new Date(workspace.deletion?.completeAt || 0).getTime();
      if (!Number.isFinite(completeAt) || completeAt > Date.now()) {
        return { abort: jsonResponse(400, { error: "The grace period has not passed yet.", completeAt: workspace.deletion?.completeAt }) };
      }
      return {
        workspaces: workspaces.filter((item) => item.id !== workspace.id),
        invites: (invites || []).filter((invite) => invite.workspaceId !== workspace.id),
	        result: { action, workspace, actorName }
	      };
    }

    if (action === "leave") {
      if (isLastActiveMember(workspace, auth.email)) {
        return { abort: jsonResponse(400, { error: "You're the last member. Schedule deletion instead of leaving." }) };
      }
      const next = {
        ...workspace,
        updatedAt: now,
        members: (workspace.members || []).map((member) => {
          if (normalizeEmail(member.email) !== normalizeEmail(auth.email)) return member;
          return { ...member, status: "removed", removedAt: now };
        })
      };
	      return { workspaces: replace(next), result: { action, workspace: next, actorName } };
    }

    return { abort: jsonResponse(400, { error: "Unsupported workspace action." }) };
  });

  if (!mutation.ok) return mutation.abort;
  const r = mutation.result;

  if (r.action === "schedule_deletion") {
    await appendAudit(env, r.workspace.id, {
	      type: "workspace_deletion_scheduled",
	      actorEmail: auth.email,
	      actorName: r.actorName,
      entityType: "workspace",
      entityId: r.workspace.id,
      metadata: { graceDays: DELETION_GRACE_DAYS }
    });
    const origin = trustedOrigin(env, request);
    await Promise.all(r.partnerEmails.map((email) => sendDeletionScheduledEmail(env, {
	      to: email,
	      fromName: r.actorName,
      workspaceDisplayName: r.workspace.displayName,
      completeAt: r.completeAt.slice(0, 10),
      dashboardUrl: origin
    }))).catch(() => {});
    return jsonResponse(200, { workspace: r.workspace });
  }

  if (r.action === "cancel_deletion") {
    await appendAudit(env, r.workspace.id, {
	      type: "workspace_deletion_canceled",
	      actorEmail: auth.email,
	      actorName: r.actorName,
      entityType: "workspace",
      entityId: r.workspace.id
    });
    return jsonResponse(200, { workspace: r.workspace });
  }

  if (r.action === "finalize_deletion") {
    closeLiveRoomWorkspace(context, r.workspace.id, "workspace_deleted");
    await purgeWorkspaceData(env, r.workspace);
    return jsonResponse(200, { ok: true, deletedWorkspaceId: r.workspace.id });
  }

  // leave
  // Revoke the leaver's outstanding review tokens now that they're "removed".
  // The workspace survives, so scope the revoke to this reviewer (not the whole
  // workspace). Best-effort: a token-store hiccup must not fail the leave — the
  // live membership re-check in review-token.js still blocks a stale token.
  await revokeReviewerTokens(env, r.workspace.id, auth.email).catch(() => {});
  closeLiveRoomActor(context, r.workspace.id, auth.email, "member_removed");
  await appendAudit(env, r.workspace.id, {
	    type: "member_removed",
	    actorEmail: auth.email,
	    actorName: r.actorName,
    entityType: "member",
    entityId: auth.email,
    metadata: { reason: "left" }
  });
  return jsonResponse(200, { workspace: r.workspace });
}
