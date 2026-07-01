import { getStore } from "../_kv.js";
import {
  getAuthenticatedIdentity,
  jsonResponse,
  normalizeEmail,
} from "../_auth.js";
import { readPlatformState } from "../_workspaces.js";
import { readLLMAdminStats } from "../_llm.js";

const ADMIN_EMAIL_ENV = "SEXUALSYNC_ADMIN_EMAIL";
const FEEDBACK_STORE_NAME = "sexualsync-feedback";
const RECENT_FEEDBACK_LIMIT = 50;
const RECENT_PROFILE_LIMIT = 12;
const WORKSPACE_LIMIT = 12;
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const STATUS_TIMEOUT_MS = 1500;
const STATUS_PROBE_TTL_S = 60;

function getAdminEmail(env) {
  return normalizeEmail(env?.[ADMIN_EMAIL_ENV]);
}

function isAdmin(email, env) {
  const adminEmail = getAdminEmail(env);
  return !!adminEmail && normalizeEmail(email) === adminEmail;
}

function feedbackKey(workspaceId) {
  return `feedback:${workspaceId}`;
}

function statusItem(id, label, status, detail, critical = false) {
  return { id, label, status, detail, critical };
}

function timeoutAfter(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}-timeout`)), ms))
  ]);
}

function shortError(error, fallback) {
  return String(error?.message || fallback).slice(0, 80);
}

function safeDate(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function inWindow(value, cutoff) {
  const time = safeDate(value);
  return time > 0 && time >= cutoff;
}

function memberCounts(workspace) {
  const members = Array.isArray(workspace?.members) ? workspace.members : [];
  return {
    active: members.filter((member) => member.status === "active").length,
    invited: members.filter((member) => member.status === "invited").length,
    removed: members.filter((member) => member.status === "removed").length,
  };
}

function profileWorkspaceNames(workspaces) {
  const byEmail = new Map();
  workspaces.forEach((workspace) => {
    const workspaceName = workspace.displayName || workspace.name || workspace.id;
    (workspace.members || []).forEach((member) => {
      const email = normalizeEmail(member.email);
      if (!email) return;
      const names = byEmail.get(email) || [];
      if (!names.includes(workspaceName)) names.push(workspaceName);
      byEmail.set(email, names);
    });
  });
  return byEmail;
}

async function readFeedbackForWorkspace(env, workspace) {
  const items = await getStore(env, FEEDBACK_STORE_NAME)
    .get(feedbackKey(workspace.id), { type: "json" })
    .catch(() => []);
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    id: String(item.id || ""),
    at: String(item.at || ""),
    workspaceId: workspace.id,
    workspaceName: workspace.displayName || workspace.name || workspace.id,
    email: normalizeEmail(item.email),
    name: String(item.name || ""),
    sentiment: ["positive", "negative", "neutral"].includes(item.sentiment) ? item.sentiment : "neutral",
    message: String(item.message || ""),
    route: String(item.route || ""),
    surface: String(item.surface || ""),
    mayContact: item.mayContact === true,
  }));
}

async function deleteFeedbackItem(env, workspaces, payload) {
  const workspaceId = String(payload?.workspaceId || "").trim();
  const feedbackId = String(payload?.feedbackId || payload?.id || "").trim();
  if (!workspaceId || !feedbackId) {
    return jsonResponse(400, { error: "workspaceId and feedbackId are required." });
  }
  if (!workspaces.some((workspace) => workspace.id === workspaceId)) {
    return jsonResponse(404, { error: "Feedback workspace was not found." });
  }

  const store = getStore(env, FEEDBACK_STORE_NAME);
  const key = feedbackKey(workspaceId);
  const items = await store.get(key, { type: "json" }).catch(() => []);
  const current = Array.isArray(items) ? items : [];
  const next = current.filter((item) => String(item?.id || "") !== feedbackId);
  if (next.length === current.length) {
    return jsonResponse(404, { error: "Feedback item was not found." });
  }

  if (next.length) await store.setJSON(key, next);
  else await store.delete(key);

  return jsonResponse(200, {
    ok: true,
    workspaceId,
    deletedFeedbackId: feedbackId,
    remainingFeedback: next.length
  });
}

async function probeKv(env) {
  const namespace = env?.STORE;
  if (!namespace) return statusItem("kv", "Cloudflare KV", "down", "STORE binding missing.", true);
  const stamp = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const key = "admin:status:probe";
  try {
    await timeoutAfter(namespace.put(key, stamp, { expirationTtl: STATUS_PROBE_TTL_S }), STATUS_TIMEOUT_MS, "kv-put");
    const echoed = await timeoutAfter(namespace.get(key, "text"), STATUS_TIMEOUT_MS, "kv-get");
    if (echoed === stamp) return statusItem("kv", "Cloudflare KV", "ok", "App data reads and writes are healthy.", true);
    return statusItem("kv", "Cloudflare KV", "down", "Probe write did not read back.", true);
  } catch (error) {
    return statusItem("kv", "Cloudflare KV", "down", shortError(error, "KV probe failed."), true);
  }
}

async function probeRooms(env) {
  const ns = env?.ROOMS;
  if (!ns || typeof ns.idFromName !== "function") {
    return statusItem("rooms", "Live rooms", "down", "Durable Object binding missing.", true);
  }
  try {
    const stub = ns.get(ns.idFromName("workspace:__admin_health__"));
    const response = await timeoutAfter(
      stub.fetch("https://room.sexualsync.internal/events?after=0"),
      STATUS_TIMEOUT_MS,
      "rooms-fetch"
    );
    return response.ok
      ? statusItem("rooms", "Live rooms", "ok", "Durable Object room spine is responding.", true)
      : statusItem("rooms", "Live rooms", "down", `Room probe returned ${response.status}.`, true);
  } catch (error) {
    return statusItem("rooms", "Live rooms", "down", shortError(error, "Room probe failed."), true);
  }
}

async function probeState(env) {
  const ns = env?.STATE;
  if (!ns || typeof ns.idFromName !== "function") {
    return statusItem("state", "State coordinator", "warning", "CAS coordinator missing; app falls back to KV writes.");
  }
  try {
    const stub = ns.get(ns.idFromName("state:__admin_health__"));
    const response = await timeoutAfter(
      stub.fetch("https://state.sexualsync.internal/state/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "__admin_health__" })
      }),
      STATUS_TIMEOUT_MS,
      "state-fetch"
    );
    return response.ok
      ? statusItem("state", "State coordinator", "ok", "Atomic write coordinator is responding.")
      : statusItem("state", "State coordinator", "warning", `Coordinator returned ${response.status}.`);
  } catch (error) {
    return statusItem("state", "State coordinator", "warning", shortError(error, "State probe failed."));
  }
}

async function probeVault(env) {
  const bucket = env?.VAULT_MEDIA;
  if (!bucket || typeof bucket.list !== "function") {
    return statusItem("vault", "Vault media", "down", "R2 bucket binding missing.", true);
  }
  try {
    await timeoutAfter(bucket.list({ limit: 1 }), STATUS_TIMEOUT_MS, "r2-list");
    return statusItem("vault", "Vault media", "ok", "Encrypted media bucket is reachable.", true);
  } catch (error) {
    return statusItem("vault", "Vault media", "down", shortError(error, "R2 probe failed."), true);
  }
}

async function probeGoogle(env) {
  if (!env?.GOOGLE_CLIENT_ID || !env?.GOOGLE_CLIENT_SECRET || !env?.APP_SESSION_SECRET) {
    return statusItem("google", "Google sign-in", "down", "OAuth or session secret is not configured.", true);
  }
  try {
    const response = await timeoutAfter(
      fetch("https://accounts.google.com/.well-known/openid-configuration", {
        method: "GET",
        headers: { accept: "application/json" }
      }),
      STATUS_TIMEOUT_MS,
      "google-oauth"
    );
    return response.ok
      ? statusItem("google", "Google sign-in", "ok", "OAuth discovery is reachable.", true)
      : statusItem("google", "Google sign-in", "warning", `OAuth discovery returned ${response.status}.`, true);
  } catch (error) {
    return statusItem("google", "Google sign-in", "warning", shortError(error, "Google OAuth probe failed."), true);
  }
}

function aiStatusItem(ai) {
  if (!ai?.configured) {
    return statusItem("ai", "AI helpers", "disabled", "No LLM provider is configured.");
  }
  if (!ai.enabled) {
    return statusItem("ai", "AI helpers", "disabled", `Configured for ${ai.baseHost || "provider"}, but LLM_ENABLED is off.`);
  }
  const hour = ai.currentHour || {};
  const limits = ai.limits || {};
  const detail = `${ai.model || "Default model"} via ${ai.baseHost || "provider"}; ${hour.total || 0} calls this hour, cap ${limits.perMinute || 0}/min ${limits.perHour || 0}/hr.`;
  if ((hour.blocked || 0) > 0 || (hour.error || 0) > 0) {
    return statusItem("ai", "AI helpers", "warning", detail);
  }
  return statusItem("ai", "AI helpers", "ok", detail);
}

function configStatus(env, ai) {
  const backend = String(env?.DATA_BACKEND || "kv").trim().toLowerCase();
  const supabaseEnabled = ["supabase", "postgres", "db", "dual"].includes(backend);
  return [
    statusItem("pages", "Pages Functions", "ok", env?.CF_PAGES_COMMIT_SHA ? `Commit ${String(env.CF_PAGES_COMMIT_SHA).slice(0, 7)} is serving.` : "Admin API is serving.", true),
    env?.VAPID_PUBLIC_KEY && env?.VAPID_PRIVATE_KEY
      ? statusItem("push", "Web Push", "ok", "VAPID keys are configured.")
      : statusItem("push", "Web Push", "warning", "Push keys are incomplete."),
    env?.RESEND_API_KEY
      ? statusItem("email", "Resend email", "ok", "Email provider key is configured.")
      : statusItem("email", "Resend email", "disabled", "Email sending is not configured."),
    supabaseEnabled
      ? (env?.SUPABASE_URL && env?.SUPABASE_SERVICE_KEY
          ? statusItem("supabase", "Supabase backend", "ok", `${backend} mode is configured.`)
          : statusItem("supabase", "Supabase backend", "warning", `${backend} mode is missing config.`))
      : statusItem("supabase", "Supabase backend", "disabled", "KV is the active data backend."),
    aiStatusItem(ai),
    env?.SENTRY_DSN_PUBLIC
      ? statusItem("sentry", "Sentry", "ok", "Client monitoring DSN is configured.")
      : statusItem("sentry", "Sentry", "disabled", "Client monitoring is not configured.")
  ];
}

async function systemStatus(env, ai) {
  const liveServices = await Promise.all([
    probeKv(env),
    probeRooms(env),
    probeState(env),
    probeVault(env),
    probeGoogle(env)
  ]);
  const services = [...configStatus(env, ai), ...liveServices];
  const summary = services.reduce((counts, item) => {
    counts[item.status] = (counts[item.status] || 0) + 1;
    return counts;
  }, { ok: 0, warning: 0, down: 0, disabled: 0 });
  const criticalDown = services.some((item) => item.critical && item.status === "down");
  return {
    ok: !criticalDown,
    summary,
    services
  };
}

function sentimentCounts(feedback) {
  return feedback.reduce((counts, item) => {
    counts[item.sentiment] = (counts[item.sentiment] || 0) + 1;
    return counts;
  }, { positive: 0, neutral: 0, negative: 0 });
}

function statusCounts(items, fallback = "unknown") {
  return items.reduce((counts, item) => {
    const status = String(item.status || fallback);
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}

function memberStatusCounts(workspaces) {
  return workspaces.reduce((counts, workspace) => {
    (workspace.members || []).forEach((member) => {
      const status = String(member.status || "unknown");
      counts[status] = (counts[status] || 0) + 1;
    });
    return counts;
  }, {});
}

function topFeedbackRoutes(feedback) {
  const counts = feedback.reduce((acc, item) => {
    const key = item.route || item.surface || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([route, count]) => ({ route, count }));
}

function percentage(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

export async function onRequest(context) {
  const method = context.request.method.toUpperCase();
  if (!["GET", "DELETE"].includes(method)) return jsonResponse(405, { error: "Method not allowed." });

  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;
  if (!isAdmin(identity.email, context.env)) return jsonResponse(403, { error: "Admin access is restricted." });

  const { profiles, workspaces, invites } = await readPlatformState(context.env);
  if (method === "DELETE") {
    const payload = await context.request.json().catch(() => ({}));
    return deleteFeedbackItem(context.env, workspaces, payload);
  }

  const activeWorkspaces = workspaces.filter((workspace) => workspace.status === "active");
  const now = Date.now();
  const recentCutoff = now - RECENT_WINDOW_MS;
  const activeMemberEmails = new Set();
  let invitedMembers = 0;
  let removedMembers = 0;

  activeWorkspaces.forEach((workspace) => {
    (workspace.members || []).forEach((member) => {
      const email = normalizeEmail(member.email);
      if (member.status === "active" && email) activeMemberEmails.add(email);
      if (member.status === "invited") invitedMembers += 1;
      if (member.status === "removed") removedMembers += 1;
    });
  });

  const feedback = (await Promise.all(workspaces.map((workspace) => readFeedbackForWorkspace(context.env, workspace))))
    .flat()
    .sort((a, b) => safeDate(b.at) - safeDate(a.at));
  const feedbackBySentiment = sentimentCounts(feedback);
  const workspacesByProfileEmail = profileWorkspaceNames(workspaces);
  const activeMemberCount = activeMemberEmails.size;

  const ai = await readLLMAdminStats(context.env);

  return jsonResponse(200, {
    generatedAt: new Date().toISOString(),
    adminAccess: getAdminEmail(context.env) ? "Configured owner" : "Not configured",
    systemStatus: await systemStatus(context.env, ai),
    ai,
    stats: {
      profilesTotal: profiles.length,
      workspacesTotal: workspaces.length,
      activeWorkspaces: activeWorkspaces.length,
      deletionPendingWorkspaces: workspaces.filter((workspace) => workspace.status === "deletion_pending").length,
      activeMembers: activeMemberCount,
      invitedMembers,
      removedMembers,
      pendingInvites: (invites || []).filter((invite) => invite.status !== "accepted").length,
      feedbackTotal: feedback.length,
      mayContactFeedback: feedback.filter((item) => item.mayContact).length,
      latestFeedbackAt: feedback[0]?.at || "",
      feedbackBySentiment,
      profilesLast7d: profiles.filter((profile) => inWindow(profile.createdAt, recentCutoff)).length,
      workspacesLast7d: workspaces.filter((workspace) => inWindow(workspace.createdAt, recentCutoff)).length,
      feedbackLast7d: feedback.filter((item) => inWindow(item.at, recentCutoff)).length,
      workspaceActivationRate: percentage(activeWorkspaces.length, workspaces.length),
      contactableFeedbackRate: percentage(feedback.filter((item) => item.mayContact).length, feedback.length),
      issueFeedbackRate: percentage(feedbackBySentiment.negative, feedback.length),
      workspaceStatusCounts: statusCounts(workspaces),
      memberStatusCounts: memberStatusCounts(activeWorkspaces),
      topFeedbackRoutes: topFeedbackRoutes(feedback),
    },
    feedback: feedback.slice(0, RECENT_FEEDBACK_LIMIT),
    recentProfiles: [...profiles]
      .sort((a, b) => safeDate(b.createdAt) - safeDate(a.createdAt))
      .slice(0, RECENT_PROFILE_LIMIT)
      .map((profile) => {
        const email = normalizeEmail(profile.email);
        return {
          id: String(profile.id || ""),
          email,
          displayName: String(profile.displayName || ""),
          createdAt: String(profile.createdAt || ""),
          updatedAt: String(profile.updatedAt || ""),
          workspaceNames: workspacesByProfileEmail.get(email) || [],
        };
      }),
    workspaces: [...workspaces]
      .sort((a, b) => safeDate(b.updatedAt || b.createdAt) - safeDate(a.updatedAt || a.createdAt))
      .slice(0, WORKSPACE_LIMIT)
      .map((workspace) => ({
        id: String(workspace.id || ""),
        name: String(workspace.displayName || workspace.name || workspace.id),
        status: String(workspace.status || ""),
        createdAt: String(workspace.createdAt || ""),
        updatedAt: String(workspace.updatedAt || ""),
        members: memberCounts(workspace),
      })),
  });
}
