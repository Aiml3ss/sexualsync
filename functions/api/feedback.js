import { mutateKey } from "./_state.js";
import { checkRateLimit, rateLimitResponse } from "./_rate_limit.js";
import {
  getAuthenticatedIdentity,
  jsonResponse,
  normalizeEmail,
} from "./_auth.js";
import {
  authorizeWorkspaceAccess,
  cleanLongText,
  cleanText,
  workspaceIdFromPayload,
  workspaceIdFromRequest,
} from "./_workspaces.js";

const FEEDBACK_STORE_NAME = "sexualsync-feedback";
const MAX_FEEDBACK_ITEMS = 200;
const MAX_FEEDBACK_MESSAGE_LENGTH = 1200;
const FEEDBACK_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const SENTIMENTS = new Set(["positive", "neutral", "negative"]);

function feedbackKey(workspaceId) {
  return `feedback:${workspaceId}`;
}

function cleanRoute(value) {
  const route = cleanText(value, 240);
  if (!route || !route.startsWith("/") || route.startsWith("//")) return "";
  return route;
}

function cleanSentiment(value) {
  const sentiment = cleanText(value, 24).toLowerCase();
  return SENTIMENTS.has(sentiment) ? sentiment : "neutral";
}

function retainedFeedbackItems(items, nowMs = Date.now()) {
  const cutoff = nowMs - FEEDBACK_RETENTION_MS;
  return (Array.isArray(items) ? items : []).filter((item) => {
    const atMs = new Date(item?.at || "").getTime();
    return Number.isFinite(atMs) && atMs >= cutoff;
  });
}

export async function onRequest(context) {
  const method = context.request.method.toUpperCase();
  if (method !== "POST") return jsonResponse(405, { error: "Method not allowed." });

  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;

  let payload = {};
  try { payload = await context.request.json(); }
  catch { return jsonResponse(400, { error: "Expected JSON body." }); }

  const workspaceId = workspaceIdFromRequest(context.request) || workspaceIdFromPayload(payload);
  const access = await authorizeWorkspaceAccess(context, identity, workspaceId);
  if (!access.ok) return access.response;

  const message = cleanLongText(payload.message, MAX_FEEDBACK_MESSAGE_LENGTH);
  if (!message) return jsonResponse(400, { error: "Feedback message is required." });

  // Throttle per identity: without this a single user can loop large messages
  // to churn the 200-item ring buffer (evicting everyone else's feedback) and
  // amplify KV writes. Best-effort bucket — a KV blip shouldn't block feedback.
  const limited = await checkRateLimit(context.env, {
    bucket: "feedback",
    key: identity.email,
    limit: 10,
    windowSeconds: 3600
  });
  if (!limited.ok) return rateLimitResponse(limited.retryAfter);

  const now = new Date().toISOString();
  const item = {
    id: crypto.randomUUID(),
    at: now,
    workspaceId: access.workspace.id,
    email: normalizeEmail(identity.email),
    name: access.actorName || "",
    sentiment: cleanSentiment(payload.sentiment),
    message,
    route: cleanRoute(payload.route),
    surface: cleanText(payload.surface, 80) || "space",
    mayContact: payload.mayContact === true,
  };

  await mutateKey(context.env, FEEDBACK_STORE_NAME, feedbackKey(access.workspace.id), (current) => {
    const items = retainedFeedbackItems(current);
    return {
      value: [item, ...items].slice(0, MAX_FEEDBACK_ITEMS),
      result: item,
    };
  });

  return jsonResponse(200, {
    ok: true,
    item: {
      id: item.id,
      at: item.at,
    },
  });
}
