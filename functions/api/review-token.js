import { getStore } from "./_kv.js";
import { mutateKey } from "./_state.js";
import { requestsKey } from "./request-board.js";
import {
  LEGACY_WORKSPACE_ID,
  getAuthenticatedIdentity,
  jsonResponse,
  normalizeEmail
} from "./_auth.js";
import {
  authorizeWorkspaceAccess,
  cleanText
} from "./_workspaces.js";
import {
  consumeReviewToken,
  findReviewToken,
  isTokenActive
} from "./_tokens.js";
import { appendAudit } from "./_audit.js";
import { cleanRoomEncryptedBox } from "./_e2ee.js";
import { checkRateLimit, rateLimitResponse } from "./_rate_limit.js";
import { sendReviewEmail } from "./_email.js";
import { trustedOrigin } from "./_origin.js";
import { isNotificationSatisfied, notifyWorkspaceEvent } from "./_notification_policy.js";
import { broadcastRoomEvent } from "./_live_room.js";
import { narrateMatch } from "./_match_narration.js";

const REQUEST_STORE = "sexualsync-request-board";
// C3 — review replies read/write the PER-WORKSPACE requests key (the token
// carries the workspaceId), mirroring request-board.js. The bare "requests" key
// is retained ONLY as a read-time legacy fallback and as a seed for the first
// per-workspace write; new writes never touch it. The key shape comes from
// request-board.js's exported requestsKey() so the migration
// (scripts/migrate-store-keys.mjs) and the E2EE status/reencrypt counters stay
// consistent.
const LEGACY_STORE_KEY = "requests";
const MAX_REQUESTS = 500;
const MAX_DECISIONS = 60;
const MAX_TEXT_LENGTH = 260;
const MAX_LONG_TEXT_LENGTH = 1800;
export const VALID_DECISIONS = new Set(["Yes", "Maybe", "Let's chat", "Counter", "No"]);
const VALID_TARGET_TYPES = new Set(["act", "timing", "filming", "general"]);
const STATUS_ALIASES = new Map([
  ["pending review", "pending"],
  ["pending", "pending"],
  ["sent", "sent"],
  ["reviewed", "reviewed"],
  ["on deck", "on_deck"],
  ["on_deck", "on_deck"],
  ["completed", "completed"],
  ["archived", "archived"],
  ["expired", "expired"],
  ["draft", "draft"]
]);
const REPLYABLE_STATUSES = new Set(["pending", "sent"]);

function cleanShortText(value, max = MAX_TEXT_LENGTH) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeReviewStatus(value) {
  const compact = String(value || "pending")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, " ");
  return STATUS_ALIASES.get(compact) || "pending";
}

export function cleanDecisions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      label: cleanShortText(item.label, 160),
      decision: VALID_DECISIONS.has(item.decision) ? item.decision : "",
      counter: cleanShortText(item.counter, 220),
      counterActId: cleanShortText(item.counterActId, 64),
      note: cleanShortText(item.note, 220),
      targetType: VALID_TARGET_TYPES.has(item.targetType) ? item.targetType : "act",
      actId: cleanShortText(item.actId, 64)
    }))
    .filter((item) => item.label && (item.decision || item.counter || item.note))
    .slice(0, MAX_DECISIONS);
}

// Read-only legacy fallback: the bare global key from before per-workspacing.
async function readLegacyRequests(env) {
  try {
    const all = await getStore(env, REQUEST_STORE).get(LEGACY_STORE_KEY, { type: "json" });
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
}

async function readWorkspaceRequestsRaw(env, workspaceId) {
  try {
    const all = await getStore(env, REQUEST_STORE).get(requestsKey(workspaceId), { type: "json" });
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
}

// Read ONE workspace's requests: the per-workspace key plus a read-only fallback
// to the legacy global key (filtered to this workspace), de-duped by id with the
// per-workspace row winning. Mirrors request-board.js readRequests, scoped to the
// single workspace the validated review token authorizes.
async function readRequests(env, workspaceId) {
  const seen = new Set();
  const out = [];
  for (const request of await readWorkspaceRequestsRaw(env, workspaceId)) {
    if (request && request.id && !seen.has(request.id)) { seen.add(request.id); out.push(request); }
  }
  for (const request of await readLegacyRequests(env)) {
    const wsId = request?.workspaceId || LEGACY_WORKSPACE_ID;
    if (wsId === workspaceId && request?.id && !seen.has(request.id)) { seen.add(request.id); out.push(request); }
  }
  return out;
}

// Atomic read-modify-write of ONE workspace's requests list (CAS via _state.js).
// `mutateFreshList` receives the current per-workspace list and returns the new
// list, or null for "no change". When the per-workspace key is still empty
// (pre-migration) the list is seeded from the legacy global key (filtered to this
// workspace) so the first write adopts legacy rows. Writes target ONLY the
// per-workspace key; the legacy global key is never written (read-only fallback +
// one-time seed, retired by scripts/migrate-store-keys.mjs). Mirrors
// request-board.js writeRequestsAtomic.
async function writeRequestsAtomic(env, workspaceId, mutateFreshList) {
  const legacySeed = (await readLegacyRequests(env))
    .filter((request) => (request?.workspaceId || LEGACY_WORKSPACE_ID) === workspaceId);
  await mutateKey(env, REQUEST_STORE, requestsKey(workspaceId), (raw) => {
    const base = Array.isArray(raw) && raw.length ? raw : legacySeed;
    const next = mutateFreshList(base);
    if (next == null) return { write: false };
    return { value: next.slice(0, MAX_REQUESTS) };
  });
}

// Atomically replace the reviewed request in the per-workspace list (CAS via
// _state.js) so a concurrent board edit to a different request can't clobber it.
async function commitReviewedRequest(env, workspaceId, requestId, buildReviewed) {
  let outcome = {
    ok: false,
    status: 404,
    error: "The request linked to this token is gone."
  };
  await writeRequestsAtomic(env, workspaceId, (fresh) => {
    const i = fresh.findIndex((item) => item.id === requestId && (item.workspaceId || LEGACY_WORKSPACE_ID) === workspaceId);
    if (i === -1) {
      outcome = {
        ok: false,
        status: 404,
        error: "The request linked to this token is gone."
      };
      return null;
    }
    const current = fresh[i];
    if (!REPLYABLE_STATUSES.has(normalizeReviewStatus(current.status))) {
      outcome = {
        ok: false,
        status: 410,
        error: "This review link is no longer active."
      };
      return null;
    }
    const reviewed = buildReviewed(current);
    outcome = { ok: true, reviewed };
    return fresh.map((item, idx) => idx === i ? reviewed : item);
  });
  return outcome;
}

function runAfterResponse(context, task) {
  const promise = Promise.resolve().then(task).catch(() => null);
  if (typeof context?.waitUntil === "function") {
    context.waitUntil(promise);
  }
}

function uniqueLabels(labels) {
  const seen = new Set();
  return labels
    .map((label) => cleanShortText(label, 160))
    .filter((label) => {
      const key = label.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_DECISIONS);
}

function firstName(value) {
  return String(value || "").trim().split(/\s+/)[0] || "";
}

function timingFromCounter(value) {
  const text = cleanShortText(value, 220).toLowerCase();
  if (!text) return "";
  if (/\btonight\b/.test(text)) return "Tonight";
  if (/\bmid[-\s]?day\b|\bnoon\b|\bafternoon\b/.test(text)) return "Mid-day";
  if (/\btomorrow\b/.test(text)) return "Tomorrow";
  if (/\bnext\s+week\b/.test(text)) return "Next week";
  return "";
}

function filmingFromCounter(value) {
  const text = cleanShortText(value, 220).toLowerCase();
  if (!text) return "";
  if (/\b(no|without|nope)\b/.test(text)) return "No";
  if (/\b(yes|film|record|camera)\b/.test(text)) return "Yes";
  return "";
}

function counterItemsForRequest(request) {
  return cleanDecisions(request?.decisions || [])
    .filter((item) => item.counter || item.counterActId);
}

function counterActLabelsForRequest(request) {
  return counterItemsForRequest(request)
    .filter((item) => item.targetType === "act")
    .map((item) => item.counter || item.label);
}

function matchNarrationInputForRequest(request, options = {}) {
  const yesActs = cleanDecisions(request?.decisions || [])
    .filter((item) => item.decision === "Yes" && item.targetType === "act")
    .map((item) => item.label);
  const acts = uniqueLabels(options.includeCounters ? [...yesActs, ...counterActLabelsForRequest(request)] : yesActs);
  const you = firstName(request?.requesterName || request?.requester || "");
  const partner = firstName(request?.reviewerName || request?.reviewer || "");
  if (!acts.length || !you || !partner) return null;
  return {
    you,
    partner,
    acts,
    timing: request.timing || "Tonight",
    filming: request.filming === "Yes"
  };
}

async function writeMatchNarration(env, workspaceId, requestId, text) {
  await writeRequestsAtomic(env, workspaceId, (fresh) => fresh.map((item) => {
    if (item.id !== requestId || (item.workspaceId || LEGACY_WORKSPACE_ID) !== workspaceId || item.matchNarration) return item;
    return {
      ...item,
      matchNarration: text,
      matchNarrationAt: new Date().toISOString()
    };
  }));
}

function prewarmReviewedMatchNarration(context, workspaceId, request) {
  if (request?.matchNarration) return;
  const input = matchNarrationInputForRequest(request);
  if (!input) return;
  runAfterResponse(context, async () => {
    const limited = await checkRateLimit(context.env, {
      bucket: "ai-match-narration-prewarm",
      key: `${workspaceId}:${request.id}`,
      limit: 12,
      windowSeconds: 60 * 60
    });
    if (!limited.ok) return;
    const generated = await narrateMatch(context.env, input, {
      feature: "request-match-narration",
      routeFlag: "LLM_ENABLE_NARRATE",
      defaultEnabled: true,
      timeoutMs: 20000
    });
    const text = cleanShortText(generated.text, 260);
    if (text) await writeMatchNarration(context.env, workspaceId, request.id, text);
  });
}

function prewarmCounterMatchNarrationCache(context, workspaceId, request) {
  if (request?.matchNarration) return;
  const counterItems = counterItemsForRequest(request);
  const timingCounter = counterItems.find((item) => item.targetType === "timing") || null;
  const filmingCounter = counterItems.find((item) => item.targetType === "filming") || null;
  const candidateRequest = {
    ...request,
    timing: timingFromCounter(timingCounter?.counter || timingCounter?.label || "") || request.timing || "Tonight",
    filming: filmingFromCounter(filmingCounter?.counter || filmingCounter?.label || "") || request.filming || "No"
  };
  const input = matchNarrationInputForRequest(candidateRequest, { includeCounters: true });
  if (!input) return;
  runAfterResponse(context, async () => {
    const limited = await checkRateLimit(context.env, {
      bucket: "ai-match-narration-prewarm",
      key: `${workspaceId}:${request.id}:counter-candidate`,
      limit: 12,
      windowSeconds: 60 * 60
    });
    if (!limited.ok) return;
    await narrateMatch(context.env, input, {
      feature: "request-match-narration",
      routeFlag: "LLM_ENABLE_NARRATE",
      defaultEnabled: true,
      timeoutMs: 20000
    });
  });
}

async function readRequest(env, workspaceId, requestId) {
  const all = await readRequests(env, workspaceId);
  return all.find((item) => item.id === requestId && (item.workspaceId || LEGACY_WORKSPACE_ID) === workspaceId) || null;
}

function resolveMember(workspace, email) {
  const target = normalizeEmail(email);
  return (workspace?.members || []).find((member) => normalizeEmail(member.email) === target) || null;
}

function publicRequest(request) {
  if (!request) return null;
  const encryptedPayload = cleanRoomEncryptedBox(request.encryptedPayload, 60000);
  const encryptedReply = cleanRoomEncryptedBox(request.encryptedReply, 60000);
  const out = {
    id: request.id,
    workspaceId: request.workspaceId,
    requesterEmail: request.requesterEmail || "",
    requesterName: request.requesterName || request.requester || "",
    reviewerEmail: request.reviewerEmail || "",
    reviewerName: request.reviewerName || request.reviewer || "",
    categories: Array.isArray(request.categories) ? request.categories : [],
    timing: request.timing || "Tonight",
    filming: request.filming || "No",
    status: normalizeReviewStatus(request.status),
    note: request.note || "",
    matchNarration: request.matchNarration || "",
    matchNarrationAt: request.matchNarrationAt || "",
    createdAt: request.createdAt || "",
    updatedAt: request.updatedAt || ""
  };
  if (encryptedPayload) out.encryptedPayload = encryptedPayload;
  if (encryptedReply) out.encryptedReply = encryptedReply;
  return out;
}

function roomE2eeRequired(workspace) {
  return Boolean(workspace?.settings?.roomE2eeEnabled);
}

async function resolveReviewToken(context, identity, tokenValue) {
  const env = context.env;
  if (!tokenValue) return jsonResponse(400, { error: "Token is required." });

  const token = await findReviewToken(env, tokenValue);
  if (!token) return jsonResponse(404, { error: "This review link is no longer valid." });
  if (!isTokenActive(token)) {
    return jsonResponse(410, {
      error: token.consumedAt
        ? "This review link has already been used."
        : "This review link has expired.",
      expiredAt: token.expiresAt,
      consumedAt: token.consumedAt
    });
  }
  if (normalizeEmail(token.reviewerEmail) !== normalizeEmail(identity.email)) {
    return jsonResponse(403, {
      error: "This review link is for a different signed-in account."
    });
  }

  const access = await authorizeWorkspaceAccess(context, identity, token.workspaceId);
  if (!access.ok) return access.response;

  const targetRequest = await readRequest(env, token.workspaceId, token.requestId);
  if (!targetRequest) return jsonResponse(404, { error: "The request linked to this token is gone." });
  if (!REPLYABLE_STATUSES.has(normalizeReviewStatus(targetRequest.status))) {
    return jsonResponse(410, { error: "This review link is no longer active." });
  }

  return jsonResponse(200, {
    token: {
      expiresAt: token.expiresAt,
      workspaceId: token.workspaceId,
      requestId: token.requestId
    },
    request: publicRequest(targetRequest),
    workspace: {
      id: access.workspace.id,
      displayName: access.workspace.displayName,
      members: (access.workspace.members || []).map((member) => ({
        email: member.email,
        displayName: member.displayName
      }))
    }
  });
}

export async function onRequest(context) {
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;

  const env = context.env;
  const request = context.request;
  const method = request.method.toUpperCase();
  const limited = await checkRateLimit(env, {
    bucket: `review-token-${method}`,
    key: identity.email,
    limit: method === "GET" ? 40 : 20,
    windowSeconds: 300,
    failClosed: true
  });
  if (!limited.ok) return rateLimitResponse(limited.retryAfter);

  if (method === "GET") {
    return jsonResponse(405, { error: "Use POST to resolve review links." });
  }

  if (method !== "POST") return jsonResponse(405, { error: "Method not allowed" });

  let payload = {};
  try { payload = await request.json(); }
  catch { return jsonResponse(400, { error: "Expected JSON body" }); }

  const consumeTokenId = cleanText(payload.token, 64);
  if (!consumeTokenId) return jsonResponse(400, { error: "Token is required." });
  if (payload.action === "resolve") {
    return resolveReviewToken(context, identity, consumeTokenId);
  }

  const token = await findReviewToken(env, consumeTokenId);
  if (!token) return jsonResponse(404, { error: "Token not found." });
  if (!isTokenActive(token)) return jsonResponse(410, { error: "Token already used or expired." });
  if (normalizeEmail(token.reviewerEmail) !== normalizeEmail(identity.email)) {
    return jsonResponse(403, { error: "Token is for a different signed-in account." });
  }

  const access = await authorizeWorkspaceAccess(context, identity, token.workspaceId);
  if (!access.ok) return access.response;

  const decisions = cleanDecisions(payload.decisions);
  if (!decisions.length) {
    return jsonResponse(400, { error: "Pick a decision for at least one item." });
  }

  const allRequests = await readRequests(env, token.workspaceId);
  const requestIndex = allRequests.findIndex((item) => {
    return item.id === token.requestId && (item.workspaceId || LEGACY_WORKSPACE_ID) === token.workspaceId;
  });
  if (requestIndex === -1) return jsonResponse(404, { error: "The request linked to this token is gone." });

  const existing = allRequests[requestIndex];
  if (normalizeEmail(existing.reviewerEmail) !== normalizeEmail(identity.email)) {
    return jsonResponse(403, { error: "This request is assigned to a different reviewer." });
  }
  if (!REPLYABLE_STATUSES.has(normalizeReviewStatus(existing.status))) {
    return jsonResponse(409, { error: "This request is no longer waiting for review." });
  }

  const now = new Date().toISOString();
  const actorName = access.actorName || resolveMember(access.workspace, identity.email)?.displayName || "Partner";
  const encryptedReply = cleanRoomEncryptedBox(payload.encryptedReply, 60000);
  if (roomE2eeRequired(access.workspace) && !encryptedReply) {
    return jsonResponse(400, { error: "Room Encryption requires encrypted replies." });
  }
  const reviewPatch = {
    status: "reviewed",
    decisions,
    counters: decisions.filter((item) => item.counter || item.counterActId),
    feedback: cleanShortText(payload.note || payload.feedback || existing.feedback, MAX_LONG_TEXT_LENGTH),
    reviewedAt: now,
    reviewedByEmail: identity.email,
    reviewedByName: actorName,
    updatedAt: now
  };
  if (encryptedReply) reviewPatch.encryptedReply = encryptedReply;

  const committed = await commitReviewedRequest(env, token.workspaceId, token.requestId, (fresh) => ({
    ...fresh,
    ...reviewPatch
  }));
  if (!committed.ok) return jsonResponse(committed.status, { error: committed.error });

  const reviewed = committed.reviewed;
  const consumed = await consumeReviewToken(env, token.id).catch(() => null);

  const requesterMember = resolveMember(access.workspace, reviewed.requesterEmail);
  const reviewerMember = resolveMember(access.workspace, reviewed.reviewerEmail);
  const hasYes = decisions.some((item) => item.decision === "Yes");
  if (!encryptedReply && hasYes) prewarmReviewedMatchNarration(context, token.workspaceId, reviewed);
  else if (!encryptedReply && counterActLabelsForRequest(reviewed).length) {
    prewarmCounterMatchNarrationCache(context, token.workspaceId, reviewed);
  }
  let emailResult = { skipped: true };

  if (requesterMember?.email && requesterMember.status === "active") {
    emailResult = { ok: true, queued: true, reason: "delivery-queued" };
    runAfterResponse(context, async () => {
      // Sprint 0.2 — lock-screen-safe generic body.
      const pushResults = await notifyWorkspaceEvent(context, token.workspaceId, identity.email, {
        title: "Sexualsync",
        body: "Something new in your room.",
        tag: "request-reviewed",
        url: "/",
        onlyEmail: normalizeEmail(requesterMember.email)
      }).catch(() => []);
      const pushDelivered = isNotificationSatisfied(pushResults);
      if (pushDelivered) return;

      await sendReviewEmail(env, {
        to: requesterMember.email,
        fromName: reviewerMember?.displayName || actorName,
        toName: requesterMember.displayName,
        dashboardUrl: trustedOrigin(env, request) || "/",
        workspaceDisplayName: access.workspace.displayName,
        hasYes
      }).catch(() => null);
    });
  }

  await appendAudit(env, token.workspaceId, {
    type: "request_reviewed",
    actorEmail: identity.email,
    actorName,
    entityType: "request",
    entityId: reviewed.id,
    metadata: {
      yesCount: decisions.filter((item) => item.decision === "Yes").length,
      maybeCount: decisions.filter((item) => item.decision === "Maybe").length,
      chatCount: decisions.filter((item) => item.decision === "Let's chat").length,
      counterCount: decisions.filter((item) => item.decision === "Counter").length,
      noCount: decisions.filter((item) => item.decision === "No").length
    }
  });

  if (consumed) {
    await appendAudit(env, token.workspaceId, {
      type: "review_token_consumed",
      actorEmail: identity.email,
      actorName,
      entityType: "review_token",
      entityId: token.id
    });
  }
  broadcastRoomEvent(context, token.workspaceId, {
    resource: "request-board",
    action: "reviewed",
    entityId: reviewed.id,
    actorEmail: identity.email,
    actorName,
  });

  return jsonResponse(200, {
    request: publicRequest(reviewed),
    token: {
      expiresAt: consumed?.expiresAt || token.expiresAt,
      consumedAt: consumed?.consumedAt || now
    },
    emailResult
  });
}
