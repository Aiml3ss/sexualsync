import { getStore } from "./_kv.js";
import { mutateKey } from "./_state.js";

const AUDIT_STORE = "sexualsync-audit";
const AUDIT_LIMIT = 500;
const AUDIT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const AUDIT_METADATA_ALLOWLIST = new Set([
  "acceptedCount",
  "actPoolCount",
  "boundaryType",
  "chatCount",
  "claimable",
  "counterCount",
  "delivery",
  "fromStatus",
  "graceDays",
  "itemCount",
  "maybeCount",
  "mediaSize",
  "memberCount",
  "noCount",
  "nudgeCount",
  "overlapCount",
  "reauthOnLaunch",
  "reason",
  "reminderCount",
  "revealed",
  "roomE2eeEnabled",
  "roomE2eeVerifier",
  "source",
  "tagCount",
  "targetDropCount",
  "targetMaxDropCount",
  "waitingCount",
  "yesCount"
]);
const AUDIT_METADATA_STRING_KEYS = new Set([
  "boundaryType",
  "delivery",
  "fromStatus",
  "reason",
  "source"
]);
const AUDIT_METADATA_NUMBER_KEYS = new Set([
  "acceptedCount",
  "actPoolCount",
  "chatCount",
  "counterCount",
  "graceDays",
  "itemCount",
  "maybeCount",
  "mediaSize",
  "memberCount",
  "noCount",
  "nudgeCount",
  "overlapCount",
  "reminderCount",
  "tagCount",
  "targetDropCount",
  "targetMaxDropCount",
  "waitingCount",
  "yesCount"
]);
const AUDIT_METADATA_BOOLEAN_KEYS = new Set([
  "claimable",
  "reauthOnLaunch",
  "revealed",
  "roomE2eeEnabled",
  "roomE2eeVerifier"
]);
const UNSAFE_METADATA_KEY_PATTERN = /email|name|title|text|note|label|prompt|content|token|timing|recipient|startedby|lockedby|id|url|path|key|secret|pass/i;

const ALLOWED_TYPES = new Set([
  "workspace_created",
  "workspace_renamed",
  "workspace_settings_updated",
  "workspace_deletion_scheduled",
  "workspace_deletion_canceled",
  "workspace_deleted",
  "workspace_auto_closed",
  "member_invited",
  "member_joined",
  "member_removed",
  "invite_revoked",
  "invite_resent",
  "boundary_created",
  "boundary_updated",
  "boundary_deleted",
  "request_sent",
  "request_reviewed",
  "request_reminder_sent",
  "request_on_deck",
  "request_archived",
  "request_revoked",
  "request_counter_accepted",
  "request_promoted_from_counter",
  "request_promoted_from_fantasy",
  "act_created",
  "act_updated",
  "act_deleted",
  "fantasy_created",
  "fantasy_updated",
  "fantasy_deleted",
  "fantasy_restored",
  "fantasy_nudge_sent",
  "blind_reveal_created",
  "blind_reveal_submitted",
  "blind_reveal_archived",
  "blind_reveal_promoted",
  "shelf_added",
  "shelf_updated",
  "shelf_deleted",
  "vault_added",
  "vault_title_updated",
  "vault_moment_added",
  "vault_moment_title_updated",
  "vault_moment_deleted",
  "vault_reacted",
  "vault_commented",
  "vault_deleted",
  "pile_started",
  "pile_ended",
  "pile_declined",
  "pile_locked",
  "pile_session_removed",
  "review_token_consumed",
  "review_token_expired"
]);

export function auditStore(env) {
  return getStore(env, AUDIT_STORE);
}

function workspaceKey(workspaceId) {
  return `workspace-${workspaceId}`;
}

function unsafeMetadataKeys(key) {
  return UNSAFE_METADATA_KEY_PATTERN.test(String(key || ""));
}

function cleanMetadataString(value) {
  return String(value || "").trim().replace(/[^\w .:-]/g, "").slice(0, 60);
}

function retainedAuditEvents(events, nowMs = Date.now()) {
  const cutoff = nowMs - AUDIT_RETENTION_MS;
  return (Array.isArray(events) ? events : []).filter((event) => {
    const createdMs = new Date(event?.createdAt || "").getTime();
    return Number.isFinite(createdMs) && createdMs >= cutoff;
  });
}

function safeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return {};
  const safe = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!AUDIT_METADATA_ALLOWLIST.has(key) || unsafeMetadataKeys(key)) continue;
    if (AUDIT_METADATA_NUMBER_KEYS.has(key) && typeof value === "number" && Number.isFinite(value)) {
      safe[key] = value;
    } else if (AUDIT_METADATA_BOOLEAN_KEYS.has(key) && typeof value === "boolean") {
      safe[key] = value;
    } else if (AUDIT_METADATA_STRING_KEYS.has(key) && typeof value === "string") {
      const cleaned = cleanMetadataString(value);
      if (cleaned) safe[key] = cleaned;
    }
  }
  return safe;
}

export async function appendAudit(env, workspaceId, event) {
  if (!workspaceId || !event || !event.type || !ALLOWED_TYPES.has(event.type)) return;
  try {
    const key = workspaceKey(workspaceId);
    // Build the sanitized record once, OUTSIDE the transform: it carries a fresh
    // id + createdAt, and the transform may run more than once on a CAS retry.
    const sanitized = {
      id: crypto.randomUUID(),
      workspaceId,
      type: event.type,
      actorEmail: event.actorEmail || "",
      actorName: event.actorName || "",
      entityType: event.entityType || "",
      entityId: event.entityId || "",
      metadata: safeMetadata(event.metadata),
      createdAt: new Date().toISOString()
    };
    // Atomic compare-and-set so two concurrent audit appends to the same
    // workspace can no longer drop each other's event (the get->unshift->set
    // race). Retention pruning + the cap stay inside the transform: they're pure
    // and safe to re-run on a version retry.
    await mutateKey(env, AUDIT_STORE, key, (current) => {
      const next = [sanitized, ...retainedAuditEvents(current)].slice(0, AUDIT_LIMIT);
      return { value: next, result: next };
    });
  } catch {
    // Audit log writes are best-effort and must never break a primary action.
  }
}
