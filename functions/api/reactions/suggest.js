// GET /api/reactions/suggest?workspaceId=…&ideaId=…
//
// Returns three short reaction-note draft phrasings for EACH of the 6
// reaction labels for the given fantasy. Cached on the fantasy record so
// the heavy work happens once per fantasy lifetime.
//
//   { suggestions: { "Hell yeah.": ["...", "...", "..."], "Curious.": [...], ... } }
//
// On the hot path: read cached suggestions, return immediately.
// On first call: one LLM call (JSON mode) generates all 18 strings,
// writes back to the fantasy record, returns.

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

const REACTION_LABELS = [
  "Curious.",
  "Hell yeah.",
  "Tell me more.",
  "Me too.",
  "Give me a minute.",
  "Not for me — thank you for telling me.",
];

const SYSTEM_PROMPT = `You are drafting optional notes for a sexual intimacy app. The partner is about to react to a fantasy the OTHER person shared. For each of 6 reaction labels, write 3 short candidate notes the reactor could send alongside that reaction. The note should land warmly, sit alongside the reaction, and feel like the reactor is talking — not the AI.

VOICE: direct, sensual, brand-on. Brand voice — "sexy and aggressive, never crude." Match the rhythm of the fantasy when possible.

HARD RULES:
- Each note: ONE sentence. Under 18 words.
- Match the reaction's tone:
    • "Curious." → warm intrigue, inviting more.
    • "Hell yeah." → enthusiastic, immediate, turned on.
    • "Me too." → enthusiastic, immediate, mirroring the partner's vulnerability.
    • "Tell me more." → curious, invite more from the author.
    • "Give me a minute." → honest pause, not a no.
    • "Not for me — thank you for telling me." → soft, generous, no.
- Never repeat the fantasy text verbatim.
- No emoji, no preamble, no quotes around individual lines.
- Vary phrasing across the three options for each reaction.

BANNED WORDS: passion, intimacy, journey, embrace, explore, desire, connection, vulnerability, deepest, ecstasy.

OUTPUT FORMAT: Return a single JSON object whose keys are the 6 reaction labels (EXACT spelling below) and values are arrays of 3 short note strings. Return ONLY the JSON. No markdown fences. No extra commentary.

Keys (use exactly these):
"Curious."
"Hell yeah."
"Tell me more."
"Me too."
"Give me a minute."
"Not for me — thank you for telling me."`;

async function callLLM(env, fantasyText, partnerName) {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY) throw new Error("LLM not configured.");
  const res = await fetchLLMChat(env, {
    feature: "reaction-suggest",
    routeFlag: "LLM_ENABLE_REACTION_SUGGESTIONS",
    defaultEnabled: false,
    body: {
      model: llmModel(env),
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: JSON.stringify({
            fantasy: String(fantasyText).slice(0, 800),
            authorName: partnerName || "your partner",
          }) },
      ],
      max_tokens: 700,
      temperature: 0.95,
      top_p: 0.92,
      presence_penalty: 0.6,
      frequency_penalty: 0.5,
      stream: false,
      keep_alive: "24h",
      format: "json",
    },
    timeoutMs: 30000,
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || "";
  return parseSuggestions(raw);
}

function parseSuggestions(raw) {
  let txt = String(raw).trim();
  txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const obj = JSON.parse(txt);
    if (obj && typeof obj === "object") {
      const out = {};
      REACTION_LABELS.forEach((label) => {
        const arr = obj[label];
        if (Array.isArray(arr)) {
          out[label] = arr
            .map((s) => String(s || "").replace(/^["'`]\s*/, "").replace(/\s*["'`]$/, "").trim())
            .filter(Boolean)
            .slice(0, 3);
        }
      });
      return out;
    }
  } catch {}
  return {};
}

async function readList(env, key) {
  try {
    const v = await getStore(env, FANTASY_STORE).get(key, { type: "json" });
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// C3 — read ideas across the data-access set from the per-workspace keys, unioned
// with the read-only legacy global key (filtered to the same ids), de-duped by id
// with the per-workspace row winning. Mirrors fantasy-backlog.js's reader; rows
// stay RAW (this route only needs the cached reactionSuggestions field — no
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

export async function onRequest(context) {
  if (context.request.method.toUpperCase() !== "GET") {
    return jsonResponse(405, { error: "Method not allowed." });
  }
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;
  const env = context.env;
  const url = new URL(context.request.url);
  const ideaId = (url.searchParams.get("ideaId") || "").trim();
  if (!ideaId) return jsonResponse(400, { error: "ideaId is required." });

  const workspaceId = workspaceIdFromRequest(context.request);
  const access = await authorizeWorkspaceAccess(context, identity, workspaceId);
  if (!access.ok) return access.response;
  const ws = access.workspace;
  const actorEmail = normalizeEmail(identity.email);
  const limited = await checkRateLimit(env, {
    bucket: "ai-reaction-suggest",
    key: `${actorEmail}:${ws.id}`,
    limit: 30,
    windowSeconds: 60 * 60
  });
  if (!limited.ok) return rateLimitResponse(limited.retryAfter);

  const dataWorkspaceIds = access.dataWorkspaceIds;
  const ideas = await readIdeasForIds(env, dataWorkspaceIds);
  const idx = ideas.findIndex((i) => i.id === ideaId && dataWorkspaceIds.includes(i.workspaceId || "legacy-couple"));
  if (idx < 0) return jsonResponse(404, { error: "Idea not found." });
  const idea = ideas[idx];

  // Reactor must NOT be the author — suggestions are for the partner.
  if (normalizeEmail(idea.addedByEmail) === actorEmail) {
    return jsonResponse(200, { suggestions: {} });
  }

  // Cached path.
  if (idea.reactionSuggestions && Object.keys(idea.reactionSuggestions).length) {
    return jsonResponse(200, { suggestions: idea.reactionSuggestions, source: "cache" });
  }

  // First-time generation.
  try {
    const suggestions = await callLLM(env, idea.text || "", idea.addedByName || "");
    if (Object.keys(suggestions).length) {
      // Cache atomically on the idea's OWN per-workspace key, seeded from the
      // legacy global key when still empty (pre-migration), so a concurrent PATCH
      // reaction/comment isn't clobbered and the legacy global key is never
      // written. Mirrors fantasy-backlog.js's adopt-on-first-write.
      const at = new Date().toISOString();
      const ideaWorkspaceId = idea.workspaceId || "legacy-couple";
      context.waitUntil((async () => {
        const seed = await legacyIdeasSeedFor(env, ideaWorkspaceId);
        await mutateKey(env, FANTASY_STORE, ideasKey(ideaWorkspaceId), (current) => {
          const list = Array.isArray(current) && current.length ? current : seed;
          const i = list.findIndex((it) => it.id === ideaId && dataWorkspaceIds.includes(it.workspaceId || "legacy-couple"));
          if (i === -1) return { write: false };
          const next = list.map((it, j) => j === i
            ? { ...it, reactionSuggestions: suggestions, updatedAt: at }
            : it);
          return { value: next };
        });
      })());
      return jsonResponse(200, { suggestions, source: "llm" });
    }
  } catch {}
  return jsonResponse(200, { suggestions: {}, source: "fallback" });
}
