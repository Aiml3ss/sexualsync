// POST /api/refine
//
// Refines user-authored draft text in one of three modes:
//   expand   — flesh out a short draft into a fuller sentence or two
//   soften   — same kink/want, gentler phrasing
//   sharper  — same kink/want, more direct/visceral phrasing
//
// Returns { text } (and { fallback } if the model failed and we returned
// the original unchanged).
//
// Speed: relies on the LLM host's keep_alive-warmed model. With mistral 7B
// resident, warm requests are ~300-500ms. No KV cache because each input
// is unique per user; instead the client adds a short sessionStorage cache
// to avoid re-refining identical text.

import { getAuthenticatedIdentity, jsonResponse } from "./_auth.js";
import { checkRateLimit, rateLimitResponse } from "./_rate_limit.js";
import { fetchLLMChat, llmModel } from "./_llm.js";

const SYSTEMS = {
  expand: `You take a short, half-formed sexual draft and unfold it into a fuller sentence or two. Keep the writer's voice. Don't invent new acts or kinks — only add sensory specificity to what's already there. Brand voice: direct, sensual, never crude or clinical.

HARD RULES:
- 1-3 sentences. Under 50 words total.
- Preserve every act, kink, or want the user mentioned.
- Add sensory detail (touch, breath, place, time), not new acts.
- Match the writer's energy and POV.
- No emoji. No preamble. No quotes around the output. Output the refined text only.

BANNED WORDS: passion, journey, embrace, explore, desire, connection, vulnerability, deepest, intimate, intimacy, ecstasy, blissful, tender(ly).

EXAMPLES:
INPUT: "I want her on top"
OUTPUT: I want her on top, taking what she wants, my hands pinned, watching her face.

INPUT: "the hotel thing"
OUTPUT: The hotel thing. Curtains open, lights on, knowing someone in the building across could be watching.

INPUT: "morning sex but slow"
OUTPUT: Morning sex but slow — half-asleep, before either of us has said a word, just hands.

Now write the expansion for the next input.`,
  soften: `You rewrite a sexual line in gentler phrasing while keeping the EXACT same kink, act, or want. Make it land more tenderly without losing what was actually said.

HARD RULES:
- Same act/kink — do not subtract content.
- Replace harsh verbs with warmer ones; keep specificity.
- 1-2 sentences. Under 30 words.
- Match the writer's POV.
- No emoji. No preamble. No quotes. Output the refined text only.

EXAMPLES:
INPUT: "fuck me from behind"
OUTPUT: take me from behind, slow at first.

INPUT: "I want to cum on her face"
OUTPUT: I want to finish on her, somewhere she'll feel it on her skin.

INPUT: "pin me down and use me"
OUTPUT: hold me down and let me be yours for a while.

Now rewrite the next input, softer but unchanged in meaning.`,
  sharper: `You rewrite a sexual line in more direct, visceral phrasing. Same act, same want — just sharper. Less hedge, more body.

HARD RULES:
- Same kink/act — do not add new content.
- Use concrete physical verbs.
- Cut hedges: "maybe", "kind of", "I think", "I want to try".
- 1-2 sentences. Under 30 words.
- Match the writer's POV.
- No emoji. No preamble. No quotes. Output the refined text only.

EXAMPLES:
INPUT: "I think I'd like it if you were on top"
OUTPUT: I want you on top.

INPUT: "Maybe we could try something with restraints"
OUTPUT: Tie me down.

INPUT: "It would be nice to be loud sometimes"
OUTPUT: I want to be loud — and I want you to make me.

Now rewrite the next input, sharper but unchanged in meaning.`,
};

const BANNED = [
  /\bpassion\b/i, /\bjourney\b/i, /\bembrace\b/i, /\bexplor/i,
  /\bdesires?\b/i, /\bconnection\b/i, /\bvulnerab/i,
  /\bintimac/i, /\bdeepest\b/i, /\becstas/i, /\bblissful/i, /\btender(?:ly)?\b/i,
];
const hasBanned = (s) => BANNED.some((re) => re.test(s));

function cleanReply(s) {
  return String(s)
    .replace(/^["'`]\s*/, "")
    .replace(/\s*["'`]$/, "")
    .replace(/^(here( i)?s? )?(your |a )?(refined |expanded |softer |sharper )?(version|text|line|sentence)[\s:—-]+/i, "")
    .trim();
}

async function callLLM(env, mode, text) {
  if (!env.LLM_BASE_URL || !env.LLM_API_KEY) throw new Error("LLM not configured.");
  const body = {
    model: llmModel(env),
    messages: [
      { role: "system", content: SYSTEMS[mode] },
      { role: "user",   content: String(text).slice(0, 800) },
    ],
    max_tokens: mode === "expand" ? 90 : 55,
    temperature: mode === "expand" ? 0.85 : 0.7,
    top_p: 0.9,
    presence_penalty: 0.5,
    frequency_penalty: 0.4,
    stream: false,
    keep_alive: "24h",
  };
  const res = await fetchLLMChat(env, {
    feature: "refine",
    routeFlag: "LLM_ENABLE_REFINE",
    defaultEnabled: false,
    body,
    // Short timeout: refine is interactive, so fall back quickly.
    timeoutMs: 7000,
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content;
  if (!out) throw new Error("Empty reply.");
  return cleanReply(out);
}

export async function onRequest(context) {
  if (context.request.method.toUpperCase() !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;

  const limited = await checkRateLimit(context.env, {
    bucket: "ai-refine",
    key: identity.email,
    limit: 40,
    windowSeconds: 10 * 60
  });
  if (!limited.ok) return rateLimitResponse(limited.retryAfter);

  let payload = {};
  try { payload = await context.request.json(); }
  catch { return jsonResponse(400, { error: "Invalid JSON." }); }

  const text = String(payload.text || "").trim();
  const mode = String(payload.mode || "expand").toLowerCase();
  if (!text) return jsonResponse(400, { error: "text is required." });
  if (!Object.prototype.hasOwnProperty.call(SYSTEMS, mode)) return jsonResponse(400, { error: "mode must be expand, soften, or sharper." });

  try {
    let refined = await callLLM(context.env, mode, text);
    // If the model produced banned-word output, retry ONCE with a stern nudge.
    if (hasBanned(refined)) {
      try { refined = await callLLM(context.env, mode, text + "\n\n(no romance-novel words.)"); } catch {}
    }
    if (!refined) return jsonResponse(200, { text, fallback: true });
    return jsonResponse(200, { text: refined, mode });
  } catch {
    return jsonResponse(200, { text, fallback: true, error: "Refine helper unavailable." });
  }
}
