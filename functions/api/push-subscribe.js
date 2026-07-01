// POST /api/push-subscribe — register a Web Push subscription for the
// current user, scoped to their active workspace.
// DELETE /api/push-subscribe?endpoint=... — unsubscribe.
//
// Body shape on POST:
//   { workspaceId, subscription: { endpoint, keys: { p256dh, auth } }, preferences }

import { getAuthenticatedIdentity, jsonResponse, normalizeEmail } from "./_auth.js";
import { platformStore, readList, WORKSPACES_KEY } from "./_workspaces.js";
import { addPushSubscription, removePushSubscription, isAllowedPushEndpoint } from "./_push.js";
import { checkRateLimit, rateLimitResponse } from "./_rate_limit.js";

async function authorize(env, workspaceId, actorEmail) {
  const all = await readList(platformStore(env), WORKSPACES_KEY);
  const ws = all.find((w) => w.id === workspaceId);
  if (!ws) return null;
  const isMember = (ws.members || []).some(
    (m) => normalizeEmail(m.email) === normalizeEmail(actorEmail) && m.status === "active"
  );
  return isMember ? ws : null;
}

export async function onRequest(context) {
  const { request, env } = context;
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;
  const actorEmail = normalizeEmail(identity.email);
  const method = request.method.toUpperCase();
  const limited = await checkRateLimit(env, {
    bucket: `push-subscribe-${method}`,
    key: actorEmail,
    // 60/hour per user: the client dedups background re-saves (push-subscription
    // .ts), so this only needs headroom for manual enable + a burst of pref
    // toggles + multi-device, not a re-save on every launch.
    limit: 60,
    windowSeconds: 60 * 60
  });
  if (!limited.ok) return rateLimitResponse(limited.retryAfter);

  if (method === "POST") {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse(400, { error: "Invalid JSON" });
    }
    const workspaceId = (payload?.workspaceId || "").trim();
    const subscription = payload?.subscription;
    const preferences = payload?.preferences;
    if (!workspaceId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return jsonResponse(400, { error: "workspaceId + subscription required" });
    }
    if (!isAllowedPushEndpoint(subscription.endpoint)) {
      return jsonResponse(400, { error: "Unsupported push endpoint" });
    }
    const ws = await authorize(env, workspaceId, actorEmail);
    if (!ws) return jsonResponse(403, { error: "Not a member of that workspace" });
    await addPushSubscription(env, workspaceId, actorEmail, subscription, preferences);
    return jsonResponse(200, { ok: true });
  }

  if (method === "DELETE") {
    const url = new URL(request.url);
    const workspaceId = (url.searchParams.get("workspaceId") || "").trim();
    const endpoint = (url.searchParams.get("endpoint") || "").trim();
    if (!workspaceId || !endpoint) {
      return jsonResponse(400, { error: "workspaceId + endpoint required" });
    }
    const ws = await authorize(env, workspaceId, actorEmail);
    if (!ws) return jsonResponse(403, { error: "Not a member of that workspace" });
    await removePushSubscription(env, workspaceId, endpoint, actorEmail);
    return jsonResponse(200, { ok: true });
  }

  return jsonResponse(405, { error: "Method not allowed" });
}
