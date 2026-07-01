// GET /api/prompts?kind=confidence|curiosity
//
// Pool-based rotating prompts.
//
//   • Maintains a server-side pool of ~30 pre-generated prompts per workspace
//     per kind.
//   • Each request returns the next un-used prompt from the pool and
//     increments the index — instant, no LLM call on the hot path.
//   • When the pool is running low (< REFILL_THRESHOLD remaining), kicks off
//     a background refill via context.waitUntil so the user never waits.
//   • When the pool is empty or missing (first request ever), serves a local
//     fallback immediately and only kicks off batch generation in the
//     background when AI is explicitly enabled.
//
// Why this matters: a launch spike should never turn the LLM host into the
// critical path. Batch generation is strictly optional garnish.

import { getStore } from "./_kv.js";
import {
  getAuthenticatedIdentity,
  jsonResponse,
  normalizeEmail,
} from "./_auth.js";
import {
  authorizeWorkspaceAccess,
  workspaceIdFromRequest,
} from "./_workspaces.js";
import { checkRateLimit, rateLimitResponse } from "./_rate_limit.js";
import { fetchLLMChat, llmModel, llmRouteIsUsable } from "./_llm.js";

// The AI prompt pool is partner-personalized, so it lives in a dedicated store
// that's encrypted at rest (audit L2) and is written with setJSON (below), not
// the bare STORE + raw .put() which wrote plaintext.
const CACHE_STORE      = "sexualsync-prompt-cache";
const POOL_PREFIX      = "prompts:pool:v1:";
const POOL_SIZE        = 30;          // generations per refill
const REFILL_THRESHOLD = 6;           // kick refill when this many remain
const POOL_TTL_S       = 60 * 60 * 24 * 60; // 60 days

const SYSTEM_PROMPTS = {
  confidence: `You write short, sharp prompts for a sexual intimacy app. The viewer is carrying a kink, fantasy, or secret want they've never said out loud — to anyone. Your job: nudge them to NAME that thing and bring it to their partner. Not to imagine a scenario. Not to plan a date. Just to confess what's been hiding inside.

CORE FRAMING (always lean here):
- This is about REVEALING something carried in silence.
- The kink itself is the secret. Saying it IS the act.
- They've been editing it in their head for weeks/months/years. This prompt is permission to put it down.
- The fantasy doesn't have to happen — just being said is enough.
- The depth of the hidden thing is the point.

DO NOT WRITE scenario prompts. Off-limits:
- "What's a place you've never had sex?"
- "Hotel room. Curtains open. Who's where?"
- "Where do you most want to be touched?"
- Anything that asks them to IMAGINE a scene rather than CONFESS a kink.

HARD RULES (every prompt must obey):
- ONE sentence. Under 18 words. No exceptions.
- Second person ("you"), warm and direct.
- Point at something HIDDEN — a kink unspoken, a fantasy unconfessed, a want never asked for.
- No moralizing, no "it's ok," no caveats, no quotes around the output.
- No emoji.
- Use the partner's first name ({partner}) when it lands naturally.

BANNED WORDS: passion, intimacy, journey, embrace, explore, desire, connection, vulnerability, safe space, brave, vulnerable, deepest, judgment, shame, scenario, imagine, picture, envision.

VOICE EXAMPLES (study the rhythm — every one is a confession invitation):
- What's a kink you've never said out loud — not even to yourself?
- Tell {partner} the fantasy you've been editing in your head for years.
- Say the kink you'd whisper to {partner} in the dark if she asked.
- What's the secret one? The one you only think when she's not looking?
- Name the thing you've been waiting to be asked about.
- Tell {partner} the kink you've been carrying like a stone. Put it down.
- What's a fantasy you've never told anyone — not even {partner}?
- Confess the thing. The saying is the whole point.
- What's a part of you you've never let {partner} see in bed?
- Tell {partner} the kink you've been pretending you don't have.
- What's the thought you Google at 1am and then close the tab on?
- Say the dirty thing. You don't have to do it — just let her hear it.
- Name the maybe. Tell {partner} you're not sure — that's the confession.

ANTI-EXAMPLES (never write like these):
WRONG: "Where do you most want her hands tonight?"
WRONG: "Imagine a hotel room with her — what happens?"
WRONG: "Embrace your passions and tell her what you want."
WRONG: "Be brave and share something deep."`,

  curiosity: `You write short, sharp prompts for a sexual intimacy app's Ideas page. Both partners see this prompt. Your job: pull a hidden kink or fantasy out of EACH of them — something they've been holding silently. The output is both partners CONFESSING, not imagining. Naming what's been hidden is the whole arc — they don't have to act on it.

CORE FRAMING:
- This is about each of them REVEALING a secret kink to the other.
- Both are carrying unsaid wants. This prompt is the invitation to put one down.
- Discussion IS the fulfillment. Action is optional.
- Depth is the goal — the kink that's never been spoken, not the date that's never been booked.

DO NOT WRITE scenario prompts. Off-limits:
- "What's a place you've never had sex?"
- "Hotel room. Curtains open. Who's where?"
- "What's a sound you each want to hear?"
- Anything that asks them to PICTURE a scene instead of NAME a hidden kink.

HARD RULES (every prompt must obey):
- ONE sentence. Under 18 words.
- Address both partners ("each of you," "you both," "we").
- Point at something CARRIED IN SILENCE.
- No moralizing, no caveats, no quotes around the output.
- No emoji.

BANNED WORDS: passion, intimacy, journey, embrace, explore, desire, connection, vulnerability, deepest, judgment, shame, scenario, imagine, picture, envision.

VOICE EXAMPLES:
- Each of you: name a kink you've been holding back.
- What's a fantasy you've each been carrying that you haven't told each other?
- What's a secret one of you has that the other might not know yet?
- Tell each other the kink you've been pretending you don't have.
- What's a fantasy you'd each be relieved to finally have on the table?
- What did you each Google last week that you've never said?
- Name a fantasy you've never told anyone — not even each other.
- What's the kink each of you has been waiting to be asked about?
- Each of you, say the thing. The confession is the whole prompt.
- What's a want one of you has that you've been quiet about for years?
- Tell each other one secret your body has been holding.
- What's the kink each of you has been editing into something safer?

ANTI-EXAMPLES:
WRONG: "What's a place you've never had sex but keep imagining?"
WRONG: "Hotel room. Curtains open. Who's where?"
WRONG: "Explore your passions together."
WRONG: "Picture your ideal night — what does it look like?"`,
};

const FALLBACKS = {
  confidence: [
    "What's a kink you've never said out loud — not even to yourself?",
    "Tell her the fantasy you've been editing in your head for years.",
    "Say the kink you'd whisper in the dark if she asked.",
    "What's the secret one — the one you only think when she's not looking?",
    "Name the kink you've been pretending you don't have.",
    "Confess the thing. The saying is the whole point.",
    "Tell her the kink you've been waiting to be asked about.",
    "What's a fantasy you've never told anyone — not even her?",
  ],
  curiosity: [
    "Each of you: name a kink you've been holding back.",
    "What's a fantasy you've each been carrying that you haven't told each other?",
    "Tell each other the kink you've been pretending you don't have.",
    "What's the kink each of you has been waiting to be asked about?",
    "Each of you, say the thing. The confession is the whole prompt.",
    "What's a want one of you has that you've been quiet about for years?",
    "Name a fantasy you've never told anyone — not even each other.",
  ],
};

// Words that mark output as too AI / too purple. Used to filter the LLM's
// batch output BEFORE it goes into the pool.
const BANNED_PATTERNS = [
  /\bpassion\b/i, /\bignit/i, /\bembrace\b/i, /\bsubmits?\b/i,
  /\becstas/i, /\bintimac/i, /\btender(?:ly)?\b/i,
  /\bunfold/i, /\bexplor/i, /\bjourney\b/i,
  /\bdesires?\b/i, /\bblissful/i, /\bdeep(?:ly|er|est)?\b/i,
  /\bsurrender/i, /\bsavor/i, /\bmelt/i,
  /\bconnection\b/i, /\bvulnerab/i, /\bjudgment\b/i, /\bshame\b/i,
  /\bscenario\b/i, /\bimagin/i, /\bpicture\b/i, /\benvision\b/i,
  /\bsafe space\b/i, /\bbrave\b/i,
];
function isClean(s) {
  return BANNED_PATTERNS.every((re) => !re.test(s));
}

// ---------- Pool plumbing ------------------------------------------------

function poolKey(workspaceId, kind) {
  return `${POOL_PREFIX}${workspaceId}:${kind}`;
}

async function readPool(env, workspaceId, kind) {
  try {
    const data = await getStore(env, CACHE_STORE).get(poolKey(workspaceId, kind), { type: "json" });
    if (!data || !Array.isArray(data.items)) return null;
    return data;
  } catch { return null; }
}

async function writePool(env, workspaceId, kind, pool) {
  await getStore(env, CACHE_STORE).setJSON(
    poolKey(workspaceId, kind),
    pool,
    { expirationTtl: POOL_TTL_S }
  );
}

// ---------- LLM calls ----------------------------------------------------

function buildSystemPrompt(kind, partnerName) {
  return (SYSTEM_PROMPTS[kind] || SYSTEM_PROMPTS.confidence)
    .replaceAll("{partner}", partnerName || "your partner");
}

// Batch call — asks the LLM for N prompts in one round trip. This is what
// populates the pool. It's slower than a single call (~10-30s) but happens
// in background via waitUntil, so the user never waits for it.
async function callLLMBatch(env, { kind, partnerName, n = POOL_SIZE }) {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY) throw new Error("LLM not configured.");

  const system = buildSystemPrompt(kind, partnerName) + `

NOW WRITE A BATCH.

Output a single JSON array of exactly ${n} prompts. Each prompt is a string. Each prompt must:
- Obey every HARD RULE above.
- Be UNIQUE — distinct verbs, distinct angles, distinct rhythms.
- Match the VOICE EXAMPLES, not the ANTI-EXAMPLES.
- Use NO banned words.

Return ONLY the JSON array. No markdown fences. No commentary. No keys. Example shape:
["prompt one.", "prompt two.", "prompt three.", ...]`;

  const body = {
    model: llmModel(env),
    messages: [
      { role: "system", content: system },
      { role: "user",   content: `Generate ${n} prompts. JSON array only.` },
    ],
    max_tokens: Math.max(1200, n * 35),
    temperature: 1.05,           // high for variety across the batch
    top_p: 0.95,
    presence_penalty: 0.9,
    frequency_penalty: 0.7,
    stream: false,
    keep_alive: "24h",
    format: "json",              // Ollama JSON mode
  };
  const res = await fetchLLMChat(env, {
    feature: "prompts",
    routeFlag: "LLM_ENABLE_PROMPTS",
    defaultEnabled: true,
    body,
    timeoutMs: 120000,
  });
  if (!res.ok) throw new Error(`LLM batch ${res.status}`);
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || "";
  return parseBatchOutput(raw);
}

// ---------- Parsing + cleanup --------------------------------------------

function cleanReply(s) {
  return String(s)
    .replace(/^["'`]\s*/, "")
    .replace(/^[\s,.;:!?-]+/, "")
    .replace(/\s*["'`]$/, "")
    .replace(/^(here( i)?s? )?(your )?(prompt|sentence)[\s:—-]+/i, "")
    .trim();
}

function parseBatchOutput(raw) {
  let txt = String(raw).trim();
  // Strip markdown fences if the model added them despite asking not to.
  txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // Try direct JSON parse first.
  let arr = null;
  try {
    const parsed = JSON.parse(txt);
    if (Array.isArray(parsed)) arr = parsed;
    else if (parsed && typeof parsed === "object") {
      // Some models wrap in { prompts: [...] }
      for (const key of ["prompts", "items", "array", "list", "data"]) {
        if (Array.isArray(parsed[key])) { arr = parsed[key]; break; }
      }
    }
  } catch {}
  if (!arr) {
    // Last-ditch: split on newlines, strip leading bullets/numbers/quotes.
    arr = txt.split(/\r?\n/)
      .map((l) => l.replace(/^[\s\-*•\d.)"'`]+/, "").replace(/["'`,]+\s*$/, "").trim())
      .filter(Boolean);
  }
  const seen = new Set();
  return arr
    .map(cleanReply)
    .filter((s) => s && s.length >= 12 && s.length <= 180)
    .filter(isClean)
    .filter((s) => { const k = s.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ---------- Pool refill --------------------------------------------------

// Generate a fresh batch and APPEND it to the pool (keeping any unused
// remnants). Trims to POOL_SIZE if the pool overflows.
async function refillPool(env, workspaceId, kind, partnerName) {
  if (!llmRouteIsUsable(env, { flag: "LLM_ENABLE_PROMPTS", defaultEnabled: true })) return;
  try {
    const fresh = await callLLMBatch(env, { kind, partnerName, n: POOL_SIZE });
    if (!fresh.length) return;
    const existing = await readPool(env, workspaceId, kind);
    const remaining = existing ? existing.items.slice(existing.nextIndex || 0) : [];
    // Combine unused remnants + fresh, dedupe, cap at POOL_SIZE.
    const seen = new Set();
    const combined = [];
    for (const item of [...remaining, ...fresh]) {
      const k = item.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      combined.push(item);
      if (combined.length >= POOL_SIZE) break;
    }
    await writePool(env, workspaceId, kind, {
      items: combined,
      nextIndex: 0,
      generatedAt: new Date().toISOString(),
      partnerName: partnerName || null,
      kind,
    });
  } catch (err) {
    // Swallow — the next request will try again.
    console.warn("refillPool failed:", err.message || err);
  }
}

// ---------- Handler ------------------------------------------------------

export async function onRequest(context) {
  const method = context.request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;

  const url   = new URL(context.request.url);
  const kind  = (url.searchParams.get("kind") || "confidence").toLowerCase();
  const force = url.searchParams.get("refresh") === "1";
  if (!Object.prototype.hasOwnProperty.call(SYSTEM_PROMPTS, kind)) return jsonResponse(400, { error: "Unknown kind." });

  const workspaceId = workspaceIdFromRequest(context.request);
  const access = await authorizeWorkspaceAccess(context, identity, workspaceId);
  if (!access.ok) return access.response;

  const actorEmail = normalizeEmail(identity.email);
  const limited = await checkRateLimit(context.env, {
    bucket: force ? "ai-prompts-refresh" : "ai-prompts",
    key: `${actorEmail}:${access.workspace.id}`,
    limit: force ? 5 : 120,
    windowSeconds: force ? 60 * 60 : 10 * 60
  });
  if (!limited.ok) return rateLimitResponse(limited.retryAfter);

  const partner = (access.workspace.members || []).find(
    (m) => m.status === "active" && normalizeEmail(m.email) !== actorEmail
  );
  const partnerName = partner?.displayName?.split(" ")[0] || "";
  const ws = access.workspace;

  // FORCE refresh: drop the pool and trigger a fresh batch synchronously.
  if (force) {
    try {
      const items = await callLLMBatch(context.env, { kind, partnerName, n: POOL_SIZE });
      if (items.length) {
        await writePool(context.env, ws.id, kind, {
          items, nextIndex: 1, generatedAt: new Date().toISOString(), partnerName, kind,
        });
        return jsonResponse(200, { text: items[0], source: "llm-batch-fresh", remaining: items.length - 1 });
      }
    } catch {}
  }

  const pool = await readPool(context.env, ws.id, kind);
  if (pool && Array.isArray(pool.items) && pool.nextIndex < pool.items.length) {
    const text = pool.items[pool.nextIndex];
    const nextIndex = pool.nextIndex + 1;
    const remaining = pool.items.length - nextIndex;
    // Persist the bump.
    context.waitUntil(writePool(context.env, ws.id, kind, { ...pool, nextIndex }));
    // Background refill if we're running low.
    if (remaining < REFILL_THRESHOLD) {
      context.waitUntil(refillPool(context.env, ws.id, kind, partnerName));
    }
    return jsonResponse(200, { text, source: "pool", remaining });
  }

  // Pool empty/missing: serve a local fallback immediately and only refill in
  // the background when AI is explicitly enabled. This keeps launch spikes off
  // the LLM host.
  const canRefill = llmRouteIsUsable(context.env, { flag: "LLM_ENABLE_PROMPTS", defaultEnabled: true });
  if (canRefill) context.waitUntil(refillPool(context.env, ws.id, kind, partnerName));
  const list = FALLBACKS[kind] || FALLBACKS.confidence;
  const text = list[Math.floor(Math.random() * list.length)];
  return jsonResponse(200, {
    text,
    source: canRefill ? "fallback-refilling" : "fallback",
    remaining: 0,
    refilling: canRefill,
    error: canRefill ? "Prompt pool is warming." : "Prompt helper disabled.",
  });
}
