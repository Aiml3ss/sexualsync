// POST /api/narrate
//
// Turns structured request/pile state into one sensual one-liner.
// Routes to a self-hosted, OpenAI-compatible LLM endpoint (e.g. what Ollama
// exposes at /v1/chat/completions).
//
// Required config (env / Pages secrets):
//   LLM_BASE_URL  e.g. https://your-llm-host.example/v1
//   LLM_API_KEY   shared bearer token — your LLM proxy validates this
//   LLM_MODEL     model name, e.g. "llama3" or "mistral"
//
// Response cache: results are deterministic per (acts ∥ you ∥ partner ∥
// timing ∥ filming). We keep a small KV cache so re-renders don't re-generate
// the same sentence — saves both latency and the LLM host's electricity.

import { getAuthenticatedIdentity, jsonResponse, normalizeEmail } from "./_auth.js";
import { checkRateLimit, rateLimitResponse } from "./_rate_limit.js";
import { fetchLLMChat, llmModel } from "./_llm.js";
import {
  readNarrationCache,
  stripNarrationEmoji,
  writeNarrationCache
} from "./_narration_cache.js";

const SYSTEM_PROMPT = `You are Sexualsync's narrator: horny, direct, sex-obsessed, and specific about two consenting adult partners. Your job is to write ONE sentence that sounds like a filthy thought crossing someone's mind, using their real first names.

VOICE:
- Hungry, cocky, physical, a little obsessive.
- Acts are ingredients, not a checklist. Fuse them into a scene; do not name every act.
- Prefer one hot angle over a complete summary.
- Translate labels into body language. "Pussy Eating" can become mouth, thighs, tongue, knees, hips, or coming.
- Use crude sex words when they fit. Never sound clinical, generic, or like a task list.

HARD RULES (non-negotiable):
- Exactly one sentence. Under 18 words. No exceptions.
- Present tense, active voice.
- Use their actual first names.
- Concrete verbs only — say what physically happens.
- If filming is true, mention it offhand ("camera on", "on film").
- Output the sentence ONLY. No quotes around it. No preamble. No "Tonight," or "Here's" wrapper.
- Do not simply rewrite the input labels.

BANNED WORDS (do not use any of these — they are AI tells):
passion, ignite/igniting, embrace, submit/submits, ecstasy, intimacy, intimate, share, explore/exploring, connection, unfold, tender, tenderly, sensual evening, blissful, desire(s), journey, dance, give in, surrender, melts, savor, deeply, profoundly.

GOOD EXAMPLES (copy this hunger and compression, not the exact words):

INPUT: {"you":"Alex","partner":"Jordan","acts":["Penetration","Slow positions","Cum in mouth"]}
OUTPUT: Alex keeps Jordan pinned under him, slow and filthy, until Jordan opens for his finish.

INPUT: {"you":"Alex","partner":"Jordan","acts":["Standing blowie","Multiple Os"]}
OUTPUT: Jordan drops to their knees, and Alex gets greedy about how many times they come.

INPUT: {"you":"Jordan","partner":"Alex","acts":["Mutual oral","Slow buildup","Dirty talk"]}
OUTPUT: Jordan and Alex take turns with their mouths, talking dirtier every time one of them shakes.

INPUT: {"you":"Alex","partner":"Jordan","acts":["From behind","Hair-pulling","Cum in mouth"],"filming":true}
OUTPUT: Alex gets behind Jordan, fist in their hair, then feeds them the ending on camera.

INPUT: {"you":"Alex","partner":"Jordan","acts":["Couch","Cowgirl","Dirty talk"]}
OUTPUT: Jordan rides Alex on the couch and talks like they have been thinking about it all day.

INPUT: {"you":"Jordan","partner":"Alex","acts":["Toys or accessories","Mutual Masturbation"]}
OUTPUT: Jordan and Alex watch each other get shameless, toys close enough to make it worse.

INPUT: {"you":"Alex","partner":"Jordan","acts":["Sensual massage","Slow buildup","Penetration"]}
OUTPUT: Alex uses his hands until Jordan is impatient, then makes the wait worth it.

INPUT: {"you":"Jordan","partner":"Alex","acts":["Standing or wall","Kink","Light restraint"]}
OUTPUT: Alex pins Jordan to the wall, ties them up just enough, and gets possessive.

INPUT: {"you":"Avery","partner":"Rowan","acts":["Pussy Eating","Multiple Os"]}
OUTPUT: Avery buries his mouth between Rowan's thighs until Rowan loses count.

BAD EXAMPLES (never write like these):

WRONG: "Avery and Rowan agree to Pussy Eating and Multiple Os."
WHY:   Checklist. Verbatim labels. No heat.

WRONG: "Avery eats Rowan's pussy and gives her multiple orgasms."
WHY:   Too literal. It explains the inputs instead of turning them into a scene.

WRONG: "Tonight, passion ignites as Alex and Jordan share an intimate evening."
WHY:   Banned words. Vague. Sounds like a novel.

WRONG: "Jordan submits to Alex standing over them, their passion igniting."
WHY:   "Submits" + "passion igniting" — both banned. No concrete act.

WRONG: "The night unfolds with Alex and Jordan exploring each other's desires."
WHY:   "Unfolds," "exploring," "desires" — all AI tells. Says nothing.

Now write one sentence for the next input. Output ONLY the sentence.`;

function stripEmoji(s) {
  // Remove leading emoji + space ("🍑 From behind" → "From behind").
  return stripNarrationEmoji(s);
}

async function callLLMOnce(env, input, attempt = 0) {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY) {
    throw new Error("LLM not configured.");
  }
  const model = llmModel(env, "llama3.1");
  const userPayload = JSON.stringify({
    you: input.you, partner: input.partner,
    acts: (input.acts || []).map(stripEmoji),
    timing: input.timing || "Tonight",
    filming: !!input.filming,
  });
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user",   content: userPayload },
  ];
  // On retry, push the model harder away from purple language by injecting
  // a stern reminder right before the next turn.
  if (attempt > 0) {
    messages.push({
      role: "user",
      content: "Your last reply broke the rules. Stop listing acts. Pick the hottest angle, make it physical and hungry. ONE sentence under 18 words.",
    });
  }
  const body = {
    model,
    messages,
    max_tokens: 50,
    temperature: attempt === 0 ? 0.88 : 0.74,
    top_p: 0.92,
    presence_penalty: 0.85,
    frequency_penalty: 0.65,
    stream: false,
    // Ollama-specific: keep the model loaded in RAM forever so we never pay
    // the multi-second cold-load tax. Other OpenAI-compatible servers ignore.
    keep_alive: "24h",
  };

  let res;
  try {
    res = await fetchLLMChat(env, {
      feature: "narrate",
      routeFlag: "LLM_ENABLE_NARRATE",
      defaultEnabled: true,
      body,
      timeoutMs: 20000,
    });
  } catch (err) {
    throw new Error(`LLM unreachable: ${err.message || err}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("LLM returned no content.");
  // Strip stray wrappers some models add.
  return text
    .replace(/^["'`]\s*/, "")
    .replace(/\s*["'`]$/, "")
    .replace(/^(here( i)?s? )?(your )?(narration|sentence)[\s:—-]+/i, "")
    .trim();
}

// Words / phrases that mark a generation as too purple / too AI.
// If a generation hits any, we retry once with a stricter prompt push.
const BANNED_PATTERNS = [
  /\bpassion\b/i,
  /\bignit/i,
  /\bembrace\b/i,
  /\bsubmits?\b/i,
  /\becstas/i,
  /\bintimac/i,
  /\btender(?:ly)?\b/i,
  /\bsensual\s+(?:evening|night)\b/i,
  /\bunfold/i,
  /\bexplor/i,
  /\bjourney\b/i,
  /\bdesires?\b/i,
  /\bblissful/i,
  /\bdeep(?:ly|er)?\b/i,
  /\bsurrender/i,
  /\bsavor/i,
  /\bmelt/i,
  /\bconnection\b/i,
];

function hasBannedWord(s) {
  return BANNED_PATTERNS.some((re) => re.test(s));
}

async function callLLM(env, input) {
  const first = await callLLMOnce(env, input, 0);
  if (!hasBannedWord(first)) return first;
  // One retry with a stronger nudge. If the retry still uses banned words,
  // return it anyway — better than nothing — but the filter will catch it
  // next time too.
  try {
    const second = await callLLMOnce(env, input, 1);
    return hasBannedWord(second) ? second : second;
  } catch {
    return first;
  }
}

export async function onRequest(context) {
  if (context.request.method.toUpperCase() !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;

  const limited = await checkRateLimit(context.env, {
    bucket: "ai-narrate",
    key: normalizeEmail(identity.email),
    limit: 60,
    windowSeconds: 10 * 60
  });
  if (!limited.ok) return rateLimitResponse(limited.retryAfter);

  let payload = {};
  try { payload = await context.request.json(); }
  catch { return jsonResponse(400, { error: "Invalid JSON." }); }

  const input = {
    you:     String(payload.you || "").trim().slice(0, 80),
    partner: String(payload.partner || "").trim().slice(0, 80),
    acts:    Array.isArray(payload.acts) ? payload.acts.slice(0, 12).map((s) => String(s).slice(0, 120)) : [],
    timing:  String(payload.timing || "Tonight").trim().slice(0, 80),
    filming: !!payload.filming,
  };
  if (!input.you || !input.partner) {
    return jsonResponse(400, { error: "you and partner names are required." });
  }
  if (!input.acts.length) {
    return jsonResponse(400, { error: "At least one act is required." });
  }

  const cached = await readNarrationCache(context.env, input);
  if (cached) {
    return jsonResponse(200, { text: cached, source: "cache" });
  }

  try {
    const text = await callLLM(context.env, input);
    await writeNarrationCache(context.env, input, text);
    return jsonResponse(200, { text, source: "llm" });
  } catch {
    // Don't break the UI — return a minimal fallback so the surface that asked
    // for narration can still render *something*. Caller can show the chip
    // list if the text is empty.
    return jsonResponse(503, {
      error: "Narrator unavailable.",
      fallback: `${input.you} & ${input.partner}: ${input.acts.map(stripEmoji).join(", ")}.`,
    });
  }
}
