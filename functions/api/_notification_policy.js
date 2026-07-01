import { getStore } from "./_kv.js";
import { normalizeEmail } from "./_auth.js";
import { pushToWorkspace, readPushSubscriptions } from "./_push.js";
import { attentionCountFor } from "./_attention.js";

const PRESENCE_STORE_NAME = "sexualsync-presence";
// "Active" = genuinely looking at the app right now. Kept short so that putting
// the phone down (or a backgrounded tab whose presence stamp is now gated off in
// sexboard.js) lets real-event pushes resume within ~a minute instead of being
// suppressed for a full two minutes. The notification gate seeds the active case
// at `now` and the inactive case at now-10min, so this bound is free to tighten.
const RECIPIENT_ACTIVE_WINDOW_MS = 60 * 1000;

const PUSH_TAGS = new Set([
  "request-sent",
  "request-reviewed",
  "request-reminder",
  "kink-nudge",
  "pile-started",
  "pile-reminder",
  "blind-reveal",
  "chat-message",
  "game-ready",
  "push-test"
]);

const EXTERNAL_DELIVERY_TAGS = new Set([
  "request-sent",
  "request-reminder",
  "push-test"
]);

const ACTIVITY_ONLY_TAGS = new Set([
  "fantasy-shared",
  "idea-comment",
  "fantasy-reaction",
  "shelf-added",
  "shelf-reaction",
  "pile-ended"
]);

function presenceStore(env) {
  return getStore(env, PRESENCE_STORE_NAME);
}

async function readPresence(env, workspaceId) {
  try {
    const value = await presenceStore(env).get(`presence:${workspaceId}`, { type: "json" });
    return value && typeof value === "object" ? value : { byEmail: {} };
  } catch {
    return { byEmail: {} };
  }
}

function uniqueEmails(values) {
  return [...new Set(values.map(normalizeEmail).filter(Boolean))];
}

async function targetEmailsForPayload(env, workspaceId, actorEmail, payload = {}) {
  const onlyEmail = normalizeEmail(payload.onlyEmail);
  if (onlyEmail) return [onlyEmail];

  const actor = normalizeEmail(actorEmail);
  try {
    const subscriptions = await readPushSubscriptions(env, workspaceId);
    return uniqueEmails(
      subscriptions
        .map((subscription) => subscription?.email)
        .filter((email) => normalizeEmail(email) !== actor)
    );
  } catch {
    return [];
  }
}

async function activeRecipientEmails(env, workspaceId, actorEmail, payload = {}, nowMs = Date.now()) {
  const targets = await targetEmailsForPayload(env, workspaceId, actorEmail, payload);
  if (!targets.length) return { targets, active: [] };

  const presence = await readPresence(env, workspaceId);
  const byEmail = presence?.byEmail || {};
  const active = targets.filter((email) => {
    const seen = new Date(byEmail[email] || "").getTime();
    return Number.isFinite(seen) && seen > 0 && nowMs - seen <= RECIPIENT_ACTIVE_WINDOW_MS;
  });
  return { targets, active };
}

// Single chokepoint that scrubs every push payload to lock-screen-safe copy
// regardless of what the originating callsite passed. The Service Worker has
// the same defaults as a fallback; this is the server-side guarantee that
// matches the documented invariant: "lock-screen text stays generic" and
// "Sent privately by Sexualsync. No content is included in the subject line."
// Keep `tag`, `url`, `onlyEmail` so deep links + targeting still work.
export function lockscreenSafePushPayload(payload = {}) {
  const cleaned = { ...payload };
  cleaned.title = "New notification";
  cleaned.body = "Tap to view.";
  if (Array.isArray(payload.actions)) {
    cleaned.actions = payload.actions.slice(0, 2).map((action) => ({
      action: String(action?.action || "").slice(0, 32),
      url: action?.url,
      title: "Open"
    })).filter((action) => action.action && action.url);
  }
  return cleaned;
}

export function notificationPolicyForTag(tag = "") {
  const cleanTag = String(tag || "").trim();
  if (!cleanTag) return "push";
  if (PUSH_TAGS.has(cleanTag)) return "push";
  if (ACTIVITY_ONLY_TAGS.has(cleanTag)) return "activity-only";
  return "activity-only";
}

export function isNotificationSatisfied(results) {
  return Array.isArray(results) && results.some((result) => result?.ok || result?.suppressed);
}

export async function notifyWorkspaceEvent(context, workspaceId, actorEmail, payload = {}, options = {}) {
  const env = context?.env || context;
  const tag = String(payload?.tag || "").trim();
  const policy = notificationPolicyForTag(tag);
  if (policy !== "push") {
    return [{ ok: false, suppressed: true, reason: "activity-only", tag }];
  }

  const preserveExternalDelivery = Boolean(options.preserveExternalDelivery || EXTERNAL_DELIVERY_TAGS.has(tag));
  let recipients = [];
  if (!preserveExternalDelivery) {
    const { targets, active } = await activeRecipientEmails(env, workspaceId, actorEmail, payload);
    recipients = targets;
    if (targets.length > 0 && active.length === targets.length) {
      return [{ ok: false, suppressed: true, reason: "recipient-active", tag, targets: active }];
    }
  }

  // Attach the recipient's "needs you" count so the service worker can set the
  // home-screen app-icon badge while the app is closed. Best-effort: a badge
  // miscount must never block delivery. In a 2-person room there's one recipient.
  let outgoing = payload;
  try {
    const recipient = recipients[0] || (await targetEmailsForPayload(env, workspaceId, actorEmail, payload))[0];
    if (recipient) {
      outgoing = { ...payload, badge: await attentionCountFor(env, workspaceId, recipient) };
    }
  } catch {
    // Keep the original payload; the foreground badge trues the icon on open.
  }

  // Every push payload goes through lockscreenSafePushPayload so even if a
  // future callsite forgets to scrub, the chokepoint here guarantees the
  // notification body never carries product, partner, or intimacy context.
  // (lockscreenSafePushPayload spreads the payload, so the numeric `badge`
  // survives — and a count is never content, so it stays lock-screen-safe.)
  return pushToWorkspace(env, workspaceId, actorEmail, lockscreenSafePushPayload(outgoing));
}
