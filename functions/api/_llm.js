import { getStore } from "./_kv.js";
import { checkRateLimit } from "./_rate_limit.js";

const LOG_STORE = "STORE";
const RECENT_KEY = "llm:recent:v1";
const RECENT_LIMIT = 60;
const DAY_TTL_S = 60 * 60 * 24 * 45;
const HOUR_TTL_S = 60 * 60 * 24 * 7;
const DEFAULT_PER_MINUTE = 4;
const DEFAULT_PER_HOUR = 60;

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", "disabled"]);
const SENSITIVE_FEATURES = new Set([
  "narrate",
  "request-match-narration",
  "pile-narration",
  "refine",
  "reaction-suggest",
  "gentle-no"
]);

export const LLM_ROUTES = [
  { id: "prompts", label: "Prompt pools", flag: "LLM_ENABLE_PROMPTS", defaultEnabled: true },
  { id: "pile-narration", label: "Pile narration", flag: "LLM_ENABLE_PILE_NARRATION", defaultEnabled: true },
  { id: "refine", label: "Refine helper", flag: "LLM_ENABLE_REFINE", defaultEnabled: false },
  { id: "narrate", label: "Standalone narrator", flag: "LLM_ENABLE_NARRATE", defaultEnabled: true },
  { id: "reaction-suggest", label: "Reaction notes", flag: "LLM_ENABLE_REACTION_SUGGESTIONS", defaultEnabled: false },
  { id: "gentle-no", label: "Gentle no notes", flag: "LLM_ENABLE_GENTLE_NO", defaultEnabled: false },
  { id: "push-bodies", label: "Push body copy", flag: "LLM_ENABLE_PUSH_BODIES", defaultEnabled: false },
];

export class LLMUnavailableError extends Error {
  constructor(reason, message = reason) {
    super(message);
    this.name = "LLMUnavailableError";
    this.reason = reason;
  }
}

function cleanFeature(value) {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9:_-]+/g, "-").slice(0, 60) || "unknown";
}

function envFlag(env, name, fallback = false) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = String(raw).trim().toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  return fallback;
}

function intEnv(env, name, fallback) {
  const value = Number.parseInt(String(env?.[name] ?? ""), 10);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function timeParts(now = new Date()) {
  const iso = now.toISOString();
  return {
    at: iso,
    day: iso.slice(0, 10),
    hour: iso.slice(0, 13),
  };
}

function llmStore(env) {
  if (!env?.STORE) return null;
  try { return getStore(env, LOG_STORE); }
  catch { return null; }
}

function aggregateKey(kind, id) {
  return `llm:stats:v1:${kind}:${id}`;
}

function emptyAggregate(id = "") {
  return {
    id,
    total: 0,
    ok: 0,
    error: 0,
    blocked: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    lastAt: "",
    byFeature: {},
    reasons: {},
  };
}

function bumpCounter(obj, key, amount = 1) {
  if (!key) return;
  obj[key] = (Number(obj[key]) || 0) + amount;
}

function applyEvent(aggregate, event) {
  const next = aggregate && typeof aggregate === "object" ? aggregate : emptyAggregate();
  const outcome = ["ok", "error", "blocked"].includes(event.outcome) ? event.outcome : "error";
  const latencyMs = Math.max(0, Math.round(Number(event.latencyMs) || 0));
  const feature = cleanFeature(event.feature);

  next.total = (Number(next.total) || 0) + 1;
  next[outcome] = (Number(next[outcome]) || 0) + 1;
  next.totalLatencyMs = (Number(next.totalLatencyMs) || 0) + latencyMs;
  next.maxLatencyMs = Math.max(Number(next.maxLatencyMs) || 0, latencyMs);
  next.lastAt = event.at || next.lastAt || "";
  next.byFeature = next.byFeature && typeof next.byFeature === "object" ? next.byFeature : {};
  next.reasons = next.reasons && typeof next.reasons === "object" ? next.reasons : {};
  bumpCounter(next.reasons, event.reason || outcome);

  const featureStats = next.byFeature[feature] || emptyAggregate(feature);
  featureStats.id = feature;
  featureStats.total = (Number(featureStats.total) || 0) + 1;
  featureStats[outcome] = (Number(featureStats[outcome]) || 0) + 1;
  featureStats.totalLatencyMs = (Number(featureStats.totalLatencyMs) || 0) + latencyMs;
  featureStats.maxLatencyMs = Math.max(Number(featureStats.maxLatencyMs) || 0, latencyMs);
  featureStats.lastAt = event.at || featureStats.lastAt || "";
  featureStats.reasons = featureStats.reasons && typeof featureStats.reasons === "object" ? featureStats.reasons : {};
  bumpCounter(featureStats.reasons, event.reason || outcome);
  delete featureStats.byFeature;
  next.byFeature[feature] = featureStats;

  return next;
}

function publicAggregate(raw, id = "") {
  const source = raw && typeof raw === "object" ? raw : {};
  const base = {
    id,
    total: Math.max(0, Number(source.total) || 0),
    ok: Math.max(0, Number(source.ok) || 0),
    error: Math.max(0, Number(source.error) || 0),
    blocked: Math.max(0, Number(source.blocked) || 0),
    totalLatencyMs: Math.max(0, Number(source.totalLatencyMs) || 0),
    maxLatencyMs: Math.max(0, Number(source.maxLatencyMs) || 0),
    lastAt: String(source.lastAt || ""),
    reasons: source.reasons && typeof source.reasons === "object" ? source.reasons : {},
    features: [],
  };
  base.avgLatencyMs = base.total ? Math.round(base.totalLatencyMs / base.total) : 0;
  base.features = Object.entries(source.byFeature && typeof source.byFeature === "object" ? source.byFeature : {})
    .map(([feature, stats]) => {
      const item = publicAggregate(stats, feature);
      item.id = feature;
      return item;
    })
    .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id))
    .slice(0, 12);
  return base;
}

async function readJSON(store, key, fallback) {
  if (!store) return fallback;
  try {
    const value = await store.get(key, { type: "json" });
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

async function writeAggregate(store, key, ttl, event) {
  const current = await readJSON(store, key, emptyAggregate(key));
  const next = applyEvent({ ...emptyAggregate(key), ...(current || {}) }, event);
  await store.put(key, JSON.stringify(next), { expirationTtl: ttl });
}

export function llmConfigured(env) {
  return Boolean(String(env?.LLM_BASE_URL || "").trim() && String(env?.LLM_API_KEY || "").trim());
}

export function llmGlobalEnabled(env) {
  return envFlag(env, "LLM_ENABLED", false) && !envFlag(env, "LLM_DISABLED", false);
}

export function llmSensitiveContentAllowed(env) {
  return envFlag(env, "LLM_SENSITIVE_CONTENT_ALLOWED", false);
}

export function llmFeatureEnabled(env, { flag, defaultEnabled = true } = {}) {
  if (!flag) return defaultEnabled;
  return envFlag(env, flag, defaultEnabled);
}

export function llmRouteIsUsable(env, options = {}) {
  return llmConfigured(env) && llmGlobalEnabled(env) && llmFeatureEnabled(env, options);
}

export function llmLimits(env) {
  return {
    perMinute: intEnv(env, "LLM_GLOBAL_PER_MINUTE", DEFAULT_PER_MINUTE),
    perHour: intEnv(env, "LLM_GLOBAL_PER_HOUR", DEFAULT_PER_HOUR),
  };
}

export function llmModel(env, fallback = "mistral:7b-instruct") {
  return String(env?.LLM_MODEL || fallback).trim() || fallback;
}

function llmBaseHost(env) {
  try {
    return new URL(String(env?.LLM_BASE_URL || "")).host;
  } catch {
    return "";
  }
}

export async function recordLLMEvent(env, event) {
  const store = llmStore(env);
  if (!store) return;
  const parts = timeParts();
  const entry = {
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    at: parts.at,
    feature: cleanFeature(event.feature),
    outcome: ["ok", "error", "blocked"].includes(event.outcome) ? event.outcome : "error",
    reason: String(event.reason || "").slice(0, 80),
    status: Number(event.status || 0) || 0,
    latencyMs: Math.max(0, Math.round(Number(event.latencyMs) || 0)),
    model: String(event.model || env?.LLM_MODEL || "").slice(0, 80),
  };

  try {
    const recent = await readJSON(store, RECENT_KEY, []);
    const nextRecent = [entry, ...(Array.isArray(recent) ? recent : [])].slice(0, RECENT_LIMIT);
    await Promise.all([
      store.put(RECENT_KEY, JSON.stringify(nextRecent), { expirationTtl: DAY_TTL_S }),
      writeAggregate(store, aggregateKey("day", parts.day), DAY_TTL_S, entry),
      writeAggregate(store, aggregateKey("hour", parts.hour), HOUR_TTL_S, entry),
    ]);
  } catch {}
}

async function blockLLM(env, feature, reason, model) {
  await recordLLMEvent(env, { feature, outcome: "blocked", reason, model });
  throw new LLMUnavailableError(reason, `LLM unavailable: ${reason}`);
}

export async function fetchLLMChat(env, {
  feature,
  routeFlag,
  defaultEnabled = true,
  body,
  timeoutMs = 20000,
}) {
  const featureId = cleanFeature(feature);
  const model = body?.model || llmModel(env);
  if (!llmConfigured(env)) await blockLLM(env, featureId, "not-configured", model);
  if (!llmGlobalEnabled(env)) await blockLLM(env, featureId, "disabled", model);
  if (SENSITIVE_FEATURES.has(featureId) && !llmSensitiveContentAllowed(env)) {
    await blockLLM(env, featureId, "sensitive-content-disabled", model);
  }
  if (!llmFeatureEnabled(env, { flag: routeFlag, defaultEnabled })) {
    await blockLLM(env, featureId, "feature-disabled", model);
  }
  if (!env?.STORE) await blockLLM(env, featureId, "metering-unavailable", model);

  const limits = llmLimits(env);
  if (limits.perMinute <= 0 || limits.perHour <= 0) {
    await blockLLM(env, featureId, "global-limit-zero", model);
  }

  const minuteLimit = await checkRateLimit(env, {
    bucket: "llm-global-minute",
    key: "all",
    limit: limits.perMinute,
    windowSeconds: 60,
    failClosed: true,
  });
  if (!minuteLimit.ok) await blockLLM(env, featureId, "global-minute-limit", model);

  const hourLimit = await checkRateLimit(env, {
    bucket: "llm-global-hour",
    key: "all",
    limit: limits.perHour,
    windowSeconds: 60 * 60,
    failClosed: true,
  });
  if (!hourLimit.ok) await blockLLM(env, featureId, "global-hour-limit", model);

  const started = Date.now();
  const url = String(env.LLM_BASE_URL || "").replace(/\/+$/, "") + "/chat/completions";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.LLM_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await recordLLMEvent(env, {
      feature: featureId,
      outcome: response.ok ? "ok" : "error",
      reason: response.ok ? "ok" : `http-${response.status}`,
      status: response.status,
      latencyMs: Date.now() - started,
      model,
    });
    return response;
  } catch (error) {
    await recordLLMEvent(env, {
      feature: featureId,
      outcome: "error",
      reason: shortReason(error),
      latencyMs: Date.now() - started,
      model,
    });
    throw error;
  }
}

function shortReason(error) {
  const message = String(error?.message || error || "fetch-error").toLowerCase();
  if (message.includes("timeout")) return "timeout";
  if (message.includes("abort")) return "timeout";
  if (message.includes("network")) return "network";
  return message.replace(/[^a-z0-9:_-]+/g, "-").slice(0, 80) || "fetch-error";
}

export async function readLLMAdminStats(env) {
  const store = llmStore(env);
  const parts = timeParts();
  const [todayRaw, hourRaw, recentRaw] = await Promise.all([
    readJSON(store, aggregateKey("day", parts.day), emptyAggregate(parts.day)),
    readJSON(store, aggregateKey("hour", parts.hour), emptyAggregate(parts.hour)),
    readJSON(store, RECENT_KEY, []),
  ]);
  return {
    enabled: llmGlobalEnabled(env),
    configured: llmConfigured(env),
    model: String(env?.LLM_MODEL || "").slice(0, 80),
    baseHost: llmBaseHost(env),
    limits: llmLimits(env),
    routes: LLM_ROUTES.map((route) => ({
      id: route.id,
      label: route.label,
      enabled: llmRouteIsUsable(env, route),
      flag: route.flag,
      defaultEnabled: route.defaultEnabled,
    })),
    today: publicAggregate(todayRaw, parts.day),
    currentHour: publicAggregate(hourRaw, parts.hour),
    recent: (Array.isArray(recentRaw) ? recentRaw : []).slice(0, RECENT_LIMIT).map((item) => ({
      at: String(item?.at || ""),
      feature: cleanFeature(item?.feature),
      outcome: ["ok", "error", "blocked"].includes(item?.outcome) ? item.outcome : "error",
      reason: String(item?.reason || "").slice(0, 80),
      status: Number(item?.status || 0) || 0,
      latencyMs: Math.max(0, Math.round(Number(item?.latencyMs) || 0)),
      model: String(item?.model || "").slice(0, 80),
    })),
  };
}
