// LLM-varied push notification bodies.
//
// Pre-generates a pool of ~40 body variations per (workspaceId, kind). Each
// push pulls the next un-used one from the pool — ZERO latency cost on the
// send path. Refills in background once the pool drops below threshold.
//
// kinds:
//   "request-sent"     — partner just sent a new request
//   "request-reviewed" — partner just sent back a review with yes(es)
//   "fantasy-shared"   — partner just shared a fantasy
//   "fantasy-reaction" — partner reacted to your fantasy
//   "fantasy-comment"  — partner commented on a shared fantasy
//
// Each generated body should NOT include the partner's name (the caller
// can prepend it) and NOT include the glyph (caller appends glyph for
// positive reactions to preserve the suspense rule from the brief).

import { getStore } from "./_kv.js";
import { fetchLLMChat, llmModel } from "./_llm.js";

const CACHE_STORE  = "sexualsync-push-body-cache";
const POOL_PREFIX  = "pushbody:v1:";
const POOL_SIZE    = 30;
const REFILL_AT    = 6;
const POOL_TTL_S   = 60 * 60 * 24 * 60;

const SYSTEMS = {
  "request-sent": `You write SHORT push notification body lines. Each is one line a partner sees on their lock screen telling them their partner just sent a sexual request.

RULES:
- Each: ONE line, under 9 words.
- Past or present tense, never future.
- Do NOT include any partner name (caller adds the name as a prefix).
- Sensual but not crude. Brand voice: direct, never coy.
- No emoji. No preamble. No quotes around individual lines.
- Vary phrasing — never two that are too similar.

GOOD EXAMPLES:
- sent you something. open it tonight.
- wants something. yours to say yes to.
- left a request waiting for you.
- has plans. ask her what.
- dropped a request — go look.

Output a JSON array of N short bodies. JSON only. No markdown.`,

  "request-reviewed": `You write SHORT push notification body lines. Each tells a partner that their request just came back with at least one Yes.

RULES:
- Each: ONE line, under 9 words.
- Implies "she said yes" without being literal — variety matters.
- Do NOT include a partner name; caller will prefix.
- No emoji. No preamble. No quotes.
- Brand voice.

GOOD EXAMPLES:
- said yes. tonight got sharper.
- said yes — go see.
- sent her review. you're going to like it.
- her answer's in. check it.
- said yes to one thing. maybe more.

Output a JSON array of N short bodies. JSON only.`,

  "fantasy-shared": `You write SHORT push body lines for: partner just shared a new fantasy in the app.

RULES:
- Each: ONE line, under 9 words.
- The partner SHARED something — that's the news.
- No partner name; caller prefixes.
- No emoji. No preamble. No quotes.
- Brand voice.

GOOD EXAMPLES:
- shared a fantasy with you.
- planted something. go read it.
- said the thing. you'll want to see.
- left a fantasy waiting for a reaction.
- told you the secret one.

Output a JSON array of N short bodies. JSON only.`,

  "fantasy-reaction": `You write SHORT push body lines for: partner reacted to a fantasy you shared. Their labeled reaction is part of the product contract, so use the provided label/caption plainly.

RULES:
- Each: ONE line, under 9 words.
- No partner name; caller prefixes.
- Include the label/caption meaning. Never reduce the response to a glyph.
- No preamble. No quotes.
- Brand voice.

GOOD EXAMPLES:
- said hell yeah.
- said me too.
- wants to hear more.
- reacted. ↗
- felt something when she read it. ★

Output a JSON array of N short bodies. JSON only.`,

  "fantasy-comment": `You write SHORT push body lines for: partner just commented on a fantasy in the shared room.

RULES:
- Each: ONE line, under 9 words.
- The comment is the news — invites the recipient to come read.
- No partner name; caller prefixes.
- No emoji. No preamble. No quotes.

GOOD EXAMPLES:
- commented. go see what she said.
- added to the idea. take a look.
- left a thought on it.
- said something on the fantasy. open it.
- replied on the idea.

Output a JSON array of N short bodies. JSON only.`,
};

function poolKey(workspaceId, kind) {
  return `${POOL_PREFIX}${workspaceId}:${kind}`;
}
async function readPool(env, workspaceId, kind) {
  try { return await getStore(env, CACHE_STORE).get(poolKey(workspaceId, kind), { type: "json" }); }
  catch { return null; }
}
async function writePool(env, workspaceId, kind, pool) {
  await getStore(env, CACHE_STORE).setJSON(poolKey(workspaceId, kind), pool, { expirationTtl: POOL_TTL_S });
}

function parseBatch(raw) {
  let txt = String(raw).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const v = JSON.parse(txt);
    if (Array.isArray(v)) return v.filter((s) => typeof s === "string");
    if (v && typeof v === "object") {
      for (const k of ["prompts","items","array","list","bodies","data"]) {
        if (Array.isArray(v[k])) return v[k].filter((s) => typeof s === "string");
      }
    }
  } catch {}
  return txt.split(/\r?\n/)
    .map((l) => l.replace(/^[\s\-*•\d.)"'`]+/, "").replace(/["'`,]+\s*$/, "").trim())
    .filter(Boolean);
}

function cleanBody(s) {
  return String(s)
    .replace(/^["'`]\s*/, "").replace(/\s*["'`]$/, "")
    .replace(/\.+$/, ".")
    .trim()
    .slice(0, 80);
}

async function generateBatch(env, kind, n = POOL_SIZE) {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY) return [];
  const sys = SYSTEMS[kind];
  if (!sys) return [];
  try {
    const res = await fetchLLMChat(env, {
      feature: "push-bodies",
      routeFlag: "LLM_ENABLE_PUSH_BODIES",
      defaultEnabled: false,
      body: {
        model: llmModel(env),
        messages: [
          { role: "system", content: sys },
          { role: "user", content: `Generate ${n} unique push body lines. JSON array only.` },
        ],
        max_tokens: 700,
        temperature: 1.0,
        top_p: 0.95,
        presence_penalty: 0.8,
        frequency_penalty: 0.6,
        stream: false,
        keep_alive: "24h",
        format: "json",
      },
      timeoutMs: 60000,
    });
    if (!res.ok) return [];
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || "";
    const arr = parseBatch(raw).map(cleanBody).filter((s) => s.length >= 6 && s.length <= 80);
    const seen = new Set();
    return arr.filter((s) => { const k = s.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  } catch { return []; }
}

async function refillPool(env, workspaceId, kind) {
  try {
    const fresh = await generateBatch(env, kind, POOL_SIZE);
    if (!fresh.length) return;
    const existing = await readPool(env, workspaceId, kind);
    const remaining = existing?.items?.slice(existing.nextIndex || 0) || [];
    const seen = new Set();
    const combined = [];
    for (const it of [...remaining, ...fresh]) {
      const k = it.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      combined.push(it);
      if (combined.length >= POOL_SIZE) break;
    }
    await writePool(env, workspaceId, kind, {
      items: combined,
      nextIndex: 0,
      generatedAt: new Date().toISOString(),
      kind,
    });
  } catch {}
}

// Public — fast path. Returns a string OR null (caller falls back to static
// template). Never blocks past the in-memory pool read; refill happens in
// background. The caller should treat this as advisory: if it returns null,
// use your static template.
export async function nextPushBody(env, workspaceId, kind, waitUntil) {
  try {
    const pool = await readPool(env, workspaceId, kind);
    if (pool?.items?.length && pool.nextIndex < pool.items.length) {
      const text = pool.items[pool.nextIndex];
      const nextPool = { ...pool, nextIndex: pool.nextIndex + 1 };
      // Don't block on the write — push handler needs to finish fast.
      if (typeof waitUntil === "function") {
        waitUntil(writePool(env, workspaceId, kind, nextPool));
      } else {
        await writePool(env, workspaceId, kind, nextPool);
      }
      // Refill in background when running low.
      if ((nextPool.items.length - nextPool.nextIndex) < REFILL_AT && typeof waitUntil === "function") {
        waitUntil(refillPool(env, workspaceId, kind));
      }
      return text;
    }
    // Empty pool — kick off generation in background, return null so
    // caller uses static fallback for this one push.
    if (typeof waitUntil === "function") waitUntil(refillPool(env, workspaceId, kind));
    return null;
  } catch {
    return null;
  }
}
