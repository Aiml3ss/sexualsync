// POST /api/reactions/gentle-no
//
// Returns gentle note suggestions for pause/no reactions on a partner's idea.
// Uses the same Mac-mini OpenAI-compatible LLM tunnel as refine/prompts, with
// deterministic local fallbacks so saying no never blocks on model availability.

import { getStore } from "../_kv.js";
import { mutateKey } from "../_state.js";
import { ideasKey } from "../fantasy-backlog.js";
import {
  getAuthenticatedIdentity,
  jsonResponse,
  normalizeEmail,
} from "../_auth.js";
import {
  authorizeWorkspaceAccess,
  workspaceIdsForDataAccess,
  workspaceIdFromPayload,
  workspaceIdFromRequest,
} from "../_workspaces.js";
import { checkRateLimit, rateLimitResponse } from "../_rate_limit.js";
import { fetchLLMChat, llmModel } from "../_llm.js";

const FANTASY_STORE = "sexualsync-ideas";
// C3 — ideas are keyed per workspace. The bare "ideas" key is retained ONLY as a
// read-time legacy fallback and as a seed for the first per-workspace write; the
// cache write targets ideasKey(idea.workspaceId). Never written back. See
// scripts/migrate-store-keys.mjs.
const LEGACY_IDEAS_KEY = "ideas";

const VALID_LABELS = new Set([
  "Give me a minute.",
  "Not for me — thank you for telling me.",
]);

const FALLBACKS = {
  "Give me a minute.": [
    "I want to sit with this before I answer too fast.",
    "I’m not dismissing it — I just need a minute with it.",
    "I’m glad you told me. I want to think before I respond.",
  ],
  "Not for me — thank you for telling me.": [
    "This one isn’t for me, but I’m glad you trusted me with it.",
    "I don’t think I want this, but I don’t want you to feel bad for saying it.",
    "No for me on this one — and yes to you telling me the truth.",
  ],
};

const SYSTEM_PROMPT = `You write gentle "pause" and "no" notes for a private sexual intimacy app between partners.

The receiver is responding to a fantasy their partner shared. Your job is to make a pause or no land with care, not shame. These notes must protect the author's courage while staying honest.

HARD RULES:
- Return exactly 3 options.
- Each option is ONE sentence, under 20 words.
- No therapy language. No moralizing. No "safe space", "vulnerability", "journey", "explore", "desire", "deepest".
- Do not say yes when the answer is no.
- Do not repeat the fantasy text.
- Do not over-apologize.
- The note should sound like a real partner, not an app.
- Output JSON only: {"suggestions":["...", "...", "..."]}`;

function cleanNote(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^["'`]\s*/, "")
    .replace(/\s*["'`]$/, "")
    .trim()
    .slice(0, 180);
}

function cleanSuggestions(value, label) {
  const fallback = FALLBACKS[label] || FALLBACKS["Give me a minute."];
  const input = Array.isArray(value) ? value : [];
  const cleaned = input.map(cleanNote).filter(Boolean).filter((text) => text.length <= 180);
  return [...new Set([...cleaned, ...fallback])].slice(0, 3);
}

async function readList(env, key) {
  try {
    const value = await getStore(env, FANTASY_STORE).get(key, { type: "json" });
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

// C3 — read ideas across the data-access set from the per-workspace keys, unioned
// with the read-only legacy global key (filtered to the same ids), de-duped by id
// with the per-workspace row winning. Mirrors fantasy-backlog.js's reader; rows
// stay RAW (this route only needs the cached gentleNoSuggestions field — no
// migrate).
async function readIdeasForIds(env, workspaceIds) {
  const ids = new Set((Array.isArray(workspaceIds) ? workspaceIds : [workspaceIds]).filter(Boolean));
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    for (const row of await readList(env, ideasKey(id))) {
      if (row && row.id && !seen.has(row.id)) { seen.add(row.id); out.push(row); }
    }
  }
  for (const row of await readList(env, LEGACY_IDEAS_KEY)) {
    if (ids.has(row?.workspaceId || "legacy-couple") && row?.id && !seen.has(row.id)) { seen.add(row.id); out.push(row); }
  }
  return out;
}

// Seed the first per-workspace write from the legacy global key (filtered to this
// workspace) while it still holds the rows (pre-migration). Never written back.
async function legacyIdeasSeedFor(env, workspaceId) {
  return (await readList(env, LEGACY_IDEAS_KEY)).filter((idea) => (idea?.workspaceId || "legacy-couple") === workspaceId);
}

async function callLLM(env, { label, fantasyText, authorName }) {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY) throw new Error("LLM not configured.");
  const res = await fetchLLMChat(env, {
    feature: "gentle-no",
    routeFlag: "LLM_ENABLE_GENTLE_NO",
    defaultEnabled: false,
    body: {
      model: llmModel(env),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({
          reaction: label,
          authorName: authorName || "your partner",
          fantasy: String(fantasyText || "").slice(0, 800),
        }) },
      ],
      max_tokens: 220,
      temperature: 0.72,
      top_p: 0.9,
      stream: false,
      keep_alive: "24h",
      format: "json",
    },
    timeoutMs: 9000,
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const data = await res.json();
  const raw = String(data?.choices?.[0]?.message?.content || "").trim();
  const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim());
  return cleanSuggestions(parsed?.suggestions, label);
}

export async function onRequest(context) {
  if (context.request.method.toUpperCase() !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;

  let payload = {};
  try { payload = await context.request.json(); }
  catch { return jsonResponse(400, { error: "Invalid JSON." }); }

  const label = String(payload.label || "").trim();
  const ideaId = String(payload.ideaId || "").trim();
  if (!ideaId) return jsonResponse(400, { error: "ideaId is required." });
  if (!VALID_LABELS.has(label)) return jsonResponse(400, { error: "Unsupported gentle response." });

  const workspaceId = workspaceIdFromPayload(payload, workspaceIdFromRequest(context.request));
  const access = await authorizeWorkspaceAccess(context, identity, workspaceId);
  if (!access.ok) return access.response;
  const actorEmail = normalizeEmail(identity.email);
  const limited = await checkRateLimit(context.env, {
    bucket: "ai-gentle-no",
    key: `${actorEmail}:${access.workspace.id}`,
    limit: 30,
    windowSeconds: 60 * 60
  });
  if (!limited.ok) return rateLimitResponse(limited.retryAfter);

  const dataWorkspaceIds = access.dataWorkspaceIds;
  const ideas = await readIdeasForIds(context.env, dataWorkspaceIds);
  const idx = ideas.findIndex((idea) => idea.id === ideaId && dataWorkspaceIds.includes(idea.workspaceId || "legacy-couple"));
  if (idx === -1) return jsonResponse(404, { error: "Idea not found." });

  const idea = ideas[idx];
  if (normalizeEmail(idea.addedByEmail) === actorEmail) {
    return jsonResponse(200, { suggestions: [], source: "author" });
  }

  const cache = idea.gentleNoSuggestions || {};
  if (Array.isArray(cache[label]) && cache[label].length) {
    return jsonResponse(200, { suggestions: cleanSuggestions(cache[label], label), source: "cache" });
  }

  let suggestions = FALLBACKS[label];
  let source = "fallback";
  try {
    suggestions = await callLLM(context.env, {
      label,
      fantasyText: idea.text || "",
      authorName: idea.addedByName || "",
    });
    source = "llm";
  } catch {}

  // Never cache the static fallback: the cache hit above short-circuits all
  // future LLM attempts for this label, so persisting FALLBACKS during one LLM
  // outage would poison the suggestions for this idea+label forever. Serve the
  // fallback for this response and let the next request try the LLM again.
  if (source !== "llm") {
    return jsonResponse(200, { suggestions, source });
  }

  // Cache atomically on the idea's OWN per-workspace key, seeded from the legacy
  // global key when still empty (pre-migration), so a concurrent PATCH reaction/
  // comment isn't clobbered and the legacy global key is never written. Mirrors
  // fantasy-backlog.js's adopt-on-first-write.
  const at = new Date().toISOString();
  const ideaWorkspaceId = idea.workspaceId || "legacy-couple";
  context.waitUntil?.((async () => {
    const seed = await legacyIdeasSeedFor(context.env, ideaWorkspaceId);
    await mutateKey(context.env, FANTASY_STORE, ideasKey(ideaWorkspaceId), (current) => {
      const list = Array.isArray(current) && current.length ? current : seed;
      const i = list.findIndex((item) => item.id === ideaId && dataWorkspaceIds.includes(item.workspaceId || "legacy-couple"));
      if (i === -1) return { write: false };
      const next = list.map((item, j) => j === i
        ? {
            ...item,
            gentleNoSuggestions: {
              ...(item.gentleNoSuggestions || {}),
              [label]: suggestions,
            },
            updatedAt: at,
          }
        : item);
      return { value: next };
    });
  })());

  return jsonResponse(200, { suggestions, source });
}
