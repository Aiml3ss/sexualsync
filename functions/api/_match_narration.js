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

HARD RULES:
- Exactly one sentence. Under 18 words.
- Present tense, active voice.
- Use their actual first names.
- Concrete verbs only.
- If filming is true, mention it offhand ("camera on", "on film").
- Output the sentence ONLY. No quotes, no preamble, no "Tonight," wrapper.
- Do not simply rewrite the input labels.

BANNED WORDS:
passion, ignite, igniting, embrace, submit, submits, ecstasy, intimacy, intimate, share, explore, exploring, connection, unfold, tender, tenderly, sensual evening, blissful, desire, desires, journey, dance, give in, surrender, melts, savor, deeply, profoundly.

GOOD EXAMPLES:
INPUT: {"you":"Alex","partner":"Jordan","acts":["Penetration","Slow positions","Cum in mouth"]}
OUTPUT: Alex keeps Jordan pinned under him, slow and filthy, until Jordan opens for his finish.

INPUT: {"you":"Alex","partner":"Jordan","acts":["Standing blowie","Multiple Os"]}
OUTPUT: Jordan drops to their knees, and Alex gets greedy about how many times they come.

INPUT: {"you":"Jordan","partner":"Alex","acts":["Mutual oral","Slow buildup","Dirty talk"]}
OUTPUT: Jordan and Alex take turns with their mouths, talking dirtier every time one of them shakes.

INPUT: {"you":"Avery","partner":"Rowan","acts":["Pussy Eating","Multiple Os"]}
OUTPUT: Avery buries his mouth between Rowan's thighs until Rowan loses count.

BAD:
WRONG: "Avery and Rowan agree to Pussy Eating and Multiple Os."
WHY: Checklist. Verbatim labels. No heat.

WRONG: "Avery eats Rowan's pussy and gives her multiple orgasms."
WHY: Too literal. It explains the inputs instead of turning them into a scene.

Now write one sentence for the next input.`;

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

export function fallbackMatchNarration(input) {
  return `${input.you} & ${input.partner}: ${(input.acts || []).map(stripNarrationEmoji).join(", ")}.`;
}

function cleanNarrationInput(input) {
  return {
    you: String(input.you || "").trim().slice(0, 80),
    partner: String(input.partner || "").trim().slice(0, 80),
    acts: Array.isArray(input.acts) ? input.acts.slice(0, 12).map((label) => String(label).slice(0, 120)) : [],
    timing: String(input.timing || "Tonight").trim().slice(0, 80),
    filming: !!input.filming,
  };
}

function hasBannedWord(value) {
  return BANNED_PATTERNS.some((pattern) => pattern.test(value));
}

async function callLLMOnce(env, input, options, attempt = 0) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        you: input.you,
        partner: input.partner,
        acts: (input.acts || []).map(stripNarrationEmoji),
        timing: input.timing || "Tonight",
        filming: !!input.filming,
      }),
    },
  ];
  if (attempt > 0) {
    messages.push({
      role: "user",
      content: "Your last reply broke the rules. Stop listing acts. Pick the hottest angle, make it physical and hungry. ONE sentence under 18 words.",
    });
  }

  const res = await fetchLLMChat(env, {
    feature: options.feature || "narrate",
    routeFlag: options.routeFlag || "LLM_ENABLE_NARRATE",
    defaultEnabled: options.defaultEnabled ?? true,
    body: {
      model: llmModel(env, "llama3.1"),
      messages,
      max_tokens: options.maxTokens || 50,
      temperature: attempt === 0 ? 0.88 : 0.74,
      top_p: 0.92,
      presence_penalty: 0.85,
      frequency_penalty: 0.65,
      stream: false,
      keep_alive: "24h",
    },
    timeoutMs: options.timeoutMs || 20000,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LLM returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("LLM returned no content.");
  return text
    .replace(/^["'`]\s*/, "")
    .replace(/\s*["'`]$/, "")
    .replace(/^(here( i)?s? )?(your )?(narration|sentence)[\s:—-]+/i, "")
    .trim();
}

async function callLLM(env, input, options) {
  const first = await callLLMOnce(env, input, options, 0);
  if (!hasBannedWord(first)) return first;
  try {
    return await callLLMOnce(env, input, options, 1);
  } catch {
    return first;
  }
}

export async function narrateMatch(env, input, options = {}) {
  const cleanInput = cleanNarrationInput(input);
  if (!cleanInput.you || !cleanInput.partner || !cleanInput.acts.length) {
    return { text: "", source: "empty" };
  }

  const cached = await readNarrationCache(env, cleanInput);
  if (cached) return { text: cached, source: "cache" };

  const text = await callLLM(env, cleanInput, options);
  await writeNarrationCache(env, cleanInput, text);
  return { text, source: "llm" };
}

export async function readCachedMatchNarration(env, input) {
  const cleanInput = cleanNarrationInput(input);
  if (!cleanInput.you || !cleanInput.partner || !cleanInput.acts.length) {
    return { text: "", source: "empty" };
  }
  const cached = await readNarrationCache(env, cleanInput);
  return cached ? { text: cached, source: "cache" } : { text: "", source: "miss" };
}
