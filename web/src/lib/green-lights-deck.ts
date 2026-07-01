// Green Lights — the comfort & agreements questionnaire deck.
//
// Sibling to the Sex Quiz, but a different axis: not "does this turn me on"
// but "where do we stand on this." Answered double-blind; nothing reveals until
// both finish, then it shows where you AGREE (green lights + agreed limits) and
// the OPPOSITES — where you differ — as a "talk about these" list.
//
// ANSWER SCALES. Not every question is a yes/no. A statement forces the wrong
// frame on a preference ("quick or long?") or a want ("more often?"). So each
// card declares a `scale`, and the runner renders that scale's own buttons:
//
//   comfort — I'm good / Depends / No        (partner does X / a scenario)
//   agree   — Agree / It depends / Disagree   (a principle about how you operate)
//   want    — Yes, want this / Open to it / I'm good without  (more of something)
//   matters — A lot / Somewhat / Not really   (how much it matters to you)
//   prefer  — pole A / Either way / pole B     (this-vs-that, per-question poles)
//   cadence — frequency picker                 (reveal shows the gap, not a verdict)
//
// Option order is meaningful: index 0 is the most positive/yes pole, the last
// index the most negative/no pole (for `prefer`, the two ends are just opposite
// leanings, neither "good" nor "bad"). The reveal engine works on those
// positions, so it never hardcodes "good"/"no". Everything human-facing lives
// here; the server only stores opaque value ids keyed by card id.
//
// - heavy: true -> emotionally heavier (openness / cheating-adjacent); rendered
//   with a "worth talking through" tone and grouped toward the end.

export type GreenLightScale = "comfort" | "agree" | "want" | "matters" | "prefer" | "cadence";

// Kept for back-compat: the comfort scale's value ids.
export type GreenLightValue = "good" | "depends" | "no";

export interface GreenLightOption {
  id: string;
  label: string;
}

export interface GreenLightCard {
  id: string;
  category: string;
  label: string;
  heavy: boolean;
  scale: GreenLightScale;
  // Inline options for per-question scales (prefer, cadence). For the shared
  // scales (comfort/agree/want/matters) options come from SHARED_SCALE_OPTIONS.
  options?: GreenLightOption[];
}

// Shared option sets — ordered most-positive → most-negative.
export const SHARED_SCALE_OPTIONS: Record<"comfort" | "agree" | "want" | "matters", GreenLightOption[]> = {
  comfort: [
    { id: "good", label: "I'm good" },
    { id: "depends", label: "Depends" },
    { id: "no", label: "No" },
  ],
  agree: [
    { id: "agree", label: "Agree" },
    { id: "depends", label: "It depends" },
    { id: "disagree", label: "Disagree" },
  ],
  want: [
    { id: "yes", label: "Yes, want this" },
    { id: "open", label: "Open to it" },
    { id: "good-without", label: "I'm good without" },
  ],
  matters: [
    { id: "a-lot", label: "A lot" },
    { id: "somewhat", label: "Somewhat" },
    { id: "not-really", label: "Not really" },
  ],
};

// Cadence (frequency) options, ordered low → high; the reveal measures the gap
// as the distance between picks.
export const CADENCE_FREQUENCY_OPTIONS: GreenLightOption[] = [
  { id: "whenever", label: "When it happens" },
  { id: "monthly", label: "A few times a month" },
  { id: "weekly", label: "About weekly" },
  { id: "few-week", label: "A few times a week" },
  { id: "daily", label: "Most days" },
];

// Two-pole preference options (generic ids; per-card labels live on the card).
function prefer(poleA: string, poleB: string): GreenLightOption[] {
  return [
    { id: "a", label: poleA },
    { id: "either", label: "Either way" },
    { id: "b", label: poleB },
  ];
}

export interface GreenLightCategory {
  id: string;
  title: string;
}

export const GREEN_LIGHT_CATEGORIES: GreenLightCategory[] = [
  { id: "amount", title: "Amount & cadence" },
  { id: "libido", title: "Desire & libido" },
  { id: "pleasure", title: "Her pleasure & balance" },
  { id: "initiation", title: "Initiation" },
  { id: "affection", title: "Affection beyond sex" },
  { id: "talking", title: "Talking about sex" },
  { id: "novelty", title: "Novelty & growth" },
  { id: "confidence", title: "Confidence & being desired" },
  { id: "solo", title: "Solo & autonomy" },
  { id: "timing", title: "Timing & life" },
  { id: "health", title: "Health & care" },
  { id: "eyes", title: "Eyes on others" },
  { id: "digital", title: "Digital" },
  { id: "trust", title: "Telling & trust" },
  { id: "others", title: "Physical with others" },
  { id: "sharing", title: "Sharing & compersion" },
];

export const GREEN_LIGHT_DECK: GreenLightCard[] = [
  // Amount & cadence
  { id: "am-ideal-freq", category: "amount", label: "Ideally, how often would we have sex?", heavy: false, scale: "cadence", options: CADENCE_FREQUENCY_OPTIONS },
  { id: "am-happy", category: "amount", label: "I'm happy with how often we have sex right now", heavy: false, scale: "agree" },
  { id: "am-more", category: "amount", label: "I'd like sex more often than we do", heavy: false, scale: "want" },
  { id: "am-quality", category: "amount", label: "Quality matters more to me than quantity", heavy: false, scale: "agree" },
  { id: "am-dryspell", category: "amount", label: "A dry spell doesn't mean something's wrong", heavy: false, scale: "agree" },
  { id: "am-maintenance", category: "amount", label: "\"Maintenance sex\" to stay connected — even if not fully in the mood — is okay", heavy: false, scale: "comfort" },
  { id: "am-schedule", category: "amount", label: "Scheduling sex is okay", heavy: false, scale: "comfort" },
  { id: "am-quickvslong", category: "amount", label: "Quick & frequent, or long & occasional?", heavy: false, scale: "prefer", options: prefer("Quick & frequent", "Long & occasional") },
  { id: "am-spontaneous", category: "amount", label: "Spontaneous, or planned?", heavy: false, scale: "prefer", options: prefer("Spontaneous", "Planned") },

  // Desire & libido — different drives are normal; a lower one isn't "broken"
  { id: "li-less-love", category: "libido", label: "Wanting sex less often doesn't mean wanting you any less", heavy: false, scale: "agree" },
  { id: "li-fluctuates", category: "libido", label: "My drive rises and falls with stress, sleep, and life — and that's allowed", heavy: false, scale: "agree" },
  { id: "li-not-owed", category: "libido", label: "Sex should never feel like something we owe each other", heavy: false, scale: "agree" },

  // Her pleasure & balance
  { id: "pl-orgasm-equity", category: "pleasure", label: "Her orgasm matters as much as his", heavy: false, scale: "agree" },
  { id: "pl-her-session", category: "pleasure", label: "A whole session just on her is fair game", heavy: false, scale: "agree" },
  { id: "pl-buildup", category: "pleasure", label: "I want more build-up before we get to penetration", heavy: false, scale: "want" },
  { id: "pl-okay-nofinish", category: "pleasure", label: "Not finishing sometimes is okay — sex is still good without it", heavy: false, scale: "agree" },
  { id: "pl-pressure", category: "pleasure", label: "I feel pressure to orgasm — or to make you orgasm", heavy: false, scale: "agree" },

  // Initiation
  { id: "in-initiate", category: "initiation", label: "I'm comfortable being the one to initiate", heavy: false, scale: "comfort" },
  { id: "in-wantmore", category: "initiation", label: "I want my partner to initiate more", heavy: false, scale: "want" },
  { id: "in-anytime", category: "initiation", label: "Either of us can initiate anytime", heavy: false, scale: "agree" },
  { id: "in-notonight", category: "initiation", label: "\"Not tonight\" isn't rejection", heavy: false, scale: "agree" },
  { id: "in-raincheck", category: "initiation", label: "A rain check is fine, as long as it actually happens", heavy: false, scale: "comfort" },
  { id: "in-no-warmth", category: "initiation", label: "A \"no\" should come with warmth, not a cold shut-down", heavy: false, scale: "agree" },
  { id: "in-how-initiated", category: "initiation", label: "I most like being initiated with — a touch, or words?", heavy: false, scale: "prefer", options: prefer("A touch", "Words") },

  // Affection beyond sex
  { id: "af-daily", category: "affection", label: "Daily kissing & cuddling", heavy: false, scale: "matters" },
  { id: "af-nonsexual", category: "affection", label: "Non-sexual touch that doesn't have to lead to sex", heavy: false, scale: "want" },
  { id: "af-sleep", category: "affection", label: "Falling asleep tangled up", heavy: false, scale: "want" },
  { id: "af-public", category: "affection", label: "Affection in public", heavy: false, scale: "comfort" },

  // Talking about sex
  { id: "tk-inmoment", category: "talking", label: "I'm comfortable saying what I want mid-sex", heavy: false, scale: "comfort" },
  { id: "tk-feedback", category: "talking", label: "More direction / feedback during", heavy: false, scale: "want" },
  { id: "tk-laugh", category: "talking", label: "We can laugh when it gets awkward", heavy: false, scale: "agree" },
  { id: "tk-notworking", category: "talking", label: "I can say what's not working without it becoming a fight", heavy: false, scale: "agree" },
  { id: "tk-outside", category: "talking", label: "Talking about sex outside the bedroom isn't weird", heavy: false, scale: "comfort" },
  { id: "tk-embarrass", category: "talking", label: "I'd share a fantasy even if it feels embarrassing to say", heavy: false, scale: "want" },

  // Novelty & growth
  { id: "nv-new", category: "novelty", label: "Keep trying new things together", heavy: false, scale: "want" },
  { id: "nv-greatesthits", category: "novelty", label: "I'm happy with our greatest hits — novelty optional", heavy: false, scale: "agree" },
  { id: "nv-toys", category: "novelty", label: "More toys / props in the mix", heavy: false, scale: "want" },
  { id: "nv-trip", category: "novelty", label: "A night or trip just for sex", heavy: false, scale: "want" },
  { id: "nv-learn", category: "novelty", label: "Learning together (porn, guides) to get better", heavy: false, scale: "want" },
  { id: "nv-record", category: "novelty", label: "Recording ourselves is fine — it stays with us", heavy: false, scale: "comfort" },
  { id: "nv-power-dynamic", category: "novelty", label: "I'm curious to explore a power dynamic — one leading, one following", heavy: false, scale: "want" },
  { id: "nv-bdsm", category: "novelty", label: "I'd like to try some light BDSM together (restraints, blindfold, impact)", heavy: false, scale: "want" },
  { id: "nv-roleplay", category: "novelty", label: "Open to acting out a roleplay or character together", heavy: false, scale: "want" },

  // Confidence & being desired
  { id: "cf-lightson", category: "confidence", label: "Lights on, fully seen, is fine", heavy: false, scale: "comfort" },
  { id: "cf-reassure", category: "confidence", label: "Reassurance when I feel self-conscious", heavy: false, scale: "want" },
  { id: "cf-praise", category: "confidence", label: "Praise during sex", heavy: false, scale: "matters" },
  { id: "cf-wanted", category: "confidence", label: "Feeling wanted, not just available", heavy: false, scale: "matters" },
  { id: "cf-bodyconscious", category: "confidence", label: "I sometimes feel self-conscious about my body during sex", heavy: false, scale: "agree" },

  // Solo & autonomy
  { id: "sl-masturbate", category: "solo", label: "My partner masturbating whenever", heavy: false, scale: "comfort" },
  { id: "sl-porn", category: "solo", label: "My partner watching porn", heavy: false, scale: "comfort" },
  { id: "sl-toys", category: "solo", label: "My partner using toys solo", heavy: false, scale: "comfort" },
  { id: "sl-fantasize", category: "solo", label: "My partner getting off thinking about someone else", heavy: false, scale: "comfort" },
  { id: "sl-private", category: "solo", label: "Keeping a few fantasies private", heavy: false, scale: "comfort" },
  { id: "sl-show-howto", category: "solo", label: "I'd show you exactly how I get myself off", heavy: false, scale: "want" },
  // Solo pleasure is healthy — guilt-free, takes nothing from us
  { id: "sl-healthy", category: "solo", label: "Masturbation is healthy and normal, even when we're happy and active", heavy: false, scale: "agree" },
  // Getting off side by side — casual, no big deal, totally normal
  { id: "sl-sidebyside", category: "solo", label: "Getting myself off next to you — while you read or scroll — should be totally normal", heavy: false, scale: "agree" },
  // Solo disclosure — a preference, never an obligation (pairs with "keep some private")
  { id: "sl-horny-reach", category: "solo", label: "When I'm horny: reach for you first, or handle it solo?", heavy: false, scale: "prefer", options: prefer("Reach for you", "Handle it solo") },
  { id: "sl-tell-after", category: "solo", label: "I like knowing when you've gotten yourself off", heavy: false, scale: "agree" },
  { id: "sl-no-need-tell", category: "solo", label: "It's totally fine to handle it solo without telling me", heavy: false, scale: "agree" },
  { id: "sl-cam", category: "solo", label: "My partner watching cam models or paying for OnlyFans", heavy: false, scale: "comfort" },

  // Timing & life
  { id: "tm-drinking", category: "timing", label: "Sex while drinking / a little high", heavy: false, scale: "comfort" },
  { id: "tm-stressed", category: "timing", label: "Sex when we're stressed or tired", heavy: false, scale: "comfort" },
  { id: "tm-period", category: "timing", label: "Sex during her period", heavy: false, scale: "comfort" },
  { id: "tm-home", category: "timing", label: "Sex with kids / roommates home (quiet, risky)", heavy: false, scale: "comfort" },
  { id: "tm-apart", category: "timing", label: "Keeping it going when we're apart (phone / video)", heavy: false, scale: "want" },
  { id: "tm-morning", category: "timing", label: "More in the mood: morning, or night?", heavy: false, scale: "prefer", options: prefer("Morning", "Night") },
  { id: "tm-makeup", category: "timing", label: "Make-up sex after a fight", heavy: false, scale: "comfort" },
  { id: "tm-tension", category: "timing", label: "I can't get in the mood when something's unresolved between us", heavy: false, scale: "agree" },

  // Health & care
  { id: "hl-protection", category: "health", label: "We're aligned on protection / birth control", heavy: false, scale: "agree" },
  { id: "hl-testing", category: "health", label: "Regular testing matters — especially if we ever open up", heavy: true, scale: "agree" },
  { id: "hl-aftercare", category: "health", label: "We check in and take care of each other after intense stuff", heavy: false, scale: "agree" },
  { id: "hl-safeword", category: "health", label: "We have a safeword — and it stops everything instantly, no questions", heavy: false, scale: "agree" },
  { id: "hl-hurts-stop", category: "health", label: "If something hurts, I'll say so right away — and we stop", heavy: false, scale: "agree" },
  { id: "hl-showered", category: "health", label: "Freshly showered, or come-as-you-are?", heavy: false, scale: "prefer", options: prefer("Freshly showered", "Come-as-you-are") },
  { id: "hl-grooming", category: "health", label: "We're aligned on grooming / shaving preferences", heavy: false, scale: "agree" },
  { id: "hl-lube", category: "health", label: "Reaching for lube is normal, not a sign anything's wrong", heavy: false, scale: "agree" },

  // Eyes on others
  { id: "ey-attractive", category: "eyes", label: "My partner finding others attractive — and saying so", heavy: false, scale: "comfort" },
  { id: "ey-flirt", category: "eyes", label: "My partner harmlessly flirting", heavy: false, scale: "comfort" },
  { id: "ey-closefriend", category: "eyes", label: "A close friendship with someone they're attracted to", heavy: false, scale: "comfort" },

  // Digital
  { id: "dg-sext", category: "digital", label: "My partner sexting or trading nudes with someone else", heavy: true, scale: "comfort" },
  { id: "dg-ex", category: "digital", label: "My partner texting an ex", heavy: false, scale: "comfort" },
  { id: "dg-apps", category: "digital", label: "My partner on dating apps \"just to look\"", heavy: true, scale: "comfort" },
  { id: "dg-onlyfans", category: "digital", label: "An OnlyFans / posting content", heavy: true, scale: "comfort" },
  { id: "dg-ourvids", category: "digital", label: "Our videos only ever staying between us", heavy: false, scale: "agree" },
  { id: "dg-phones", category: "digital", label: "Phones: kept private, or open to each other?", heavy: false, scale: "prefer", options: prefer("Kept private", "Open to each other") },

  // Telling & trust
  { id: "tr-tellbefore", category: "trust", label: "Tell me before anything happens with someone else", heavy: false, scale: "agree" },
  { id: "tr-dadt", category: "trust", label: "I'd rather not know the details (don't ask, don't tell)", heavy: true, scale: "agree" },
  { id: "tr-honesty", category: "trust", label: "Full honesty even when it's hard", heavy: false, scale: "agree" },
  { id: "tr-jealousy", category: "trust", label: "Jealousy is something we talk through, not bottle up", heavy: false, scale: "agree" },
  { id: "tr-whitelie", category: "trust", label: "A small white lie to spare feelings is okay", heavy: false, scale: "agree" },
  { id: "tr-define-cheat", category: "trust", label: "We've actually talked about what counts as cheating for us", heavy: false, scale: "agree" },
  { id: "tr-emotional-affair", category: "trust", label: "An emotional affair would hurt me as much as a physical one", heavy: false, scale: "agree" },

  // Physical with others
  { id: "ot-kiss", category: "others", label: "My partner kissing someone else", heavy: true, scale: "comfort" },
  { id: "ot-sex-noemo", category: "others", label: "Sex with someone else — no emotional connection", heavy: true, scale: "comfort" },
  { id: "ot-sex-emo", category: "others", label: "Sex with someone else — feelings allowed", heavy: true, scale: "comfort" },
  { id: "ot-threesome", category: "others", label: "A threesome we both choose", heavy: true, scale: "comfort" },
  { id: "ot-open", category: "others", label: "An open / non-monogamous arrangement", heavy: true, scale: "comfort" },
  { id: "ot-watch", category: "others", label: "Watching my partner with someone else", heavy: true, scale: "comfort" },

  // Sharing & compersion (fantasy + taking joy in your partner's pleasure)
  { id: "sh-imagine-you", category: "sharing", label: "I like imagining you with someone else, with no plan to act on it", heavy: true, scale: "agree" },
  { id: "sh-stays-talk", category: "sharing", label: "Fantasy talk about others stays just talk unless we both choose more", heavy: true, scale: "agree" },
  { id: "sh-past-hot", category: "sharing", label: "Hearing about a past experience of yours can be hot, not threatening", heavy: true, scale: "agree" },
  { id: "sh-freepass-impact", category: "sharing", label: "Sex with someone else — even a one-time free pass — would change things between us", heavy: true, scale: "agree" },
  { id: "sh-together-only", category: "sharing", label: "If we ever bring someone else in, it's only ever together — never apart", heavy: true, scale: "agree" },
  { id: "sh-wish-experience", category: "sharing", label: "Part of me wishes you could experience other people too", heavy: true, scale: "want" },
  { id: "sh-pleasure-mine", category: "sharing", label: "Your pleasure turns me on as much as my own", heavy: false, scale: "agree" },
  { id: "sh-pleasure-others", category: "sharing", label: "Your pleasure — even with someone else — would turn me on more than make me jealous", heavy: true, scale: "agree" },
  { id: "sh-watch-me", category: "sharing", label: "The thought of you watching me with someone else turns me on", heavy: true, scale: "agree" },
  // Compersion, the gentle end — taking joy in your partner's own (solo) pleasure
  // What they picture while solo (you / others)
];

export const GREEN_LIGHT_BY_ID: Record<string, GreenLightCard> = Object.fromEntries(
  GREEN_LIGHT_DECK.map((card) => [card.id, card]),
);

export function greenLightCategoryTitle(id: string): string {
  return GREEN_LIGHT_CATEGORIES.find((c) => c.id === id)?.title || "";
}

// The answer buttons for a card — inline options (prefer/cadence) or the shared
// set for its scale.
export function optionsForCard(card: GreenLightCard): GreenLightOption[] {
  if (card.options) return card.options;
  if (card.scale === "comfort" || card.scale === "agree" || card.scale === "want" || card.scale === "matters") {
    return SHARED_SCALE_OPTIONS[card.scale];
  }
  return [];
}

export function labelForCardValue(card: GreenLightCard, value: string): string {
  return optionsForCard(card).find((o) => o.id === value)?.label || value;
}

// Coloring signal for a button/answer. pos = top/positive (green), neg =
// bottom/negative (red), mid = the middle, pole = a `prefer`/`cadence` choice
// (neither good nor bad → neutral/accent).
export type GreenLightTone = "pos" | "mid" | "neg" | "pole";
export function valueTone(card: GreenLightCard, value: string): GreenLightTone {
  const opts = optionsForCard(card);
  const i = opts.findIndex((o) => o.id === value);
  if (card.scale === "prefer" || card.scale === "cadence") return i === 1 && card.scale === "prefer" ? "mid" : "pole";
  if (i === 0) return "pos";
  if (i === opts.length - 1) return "neg";
  return "mid";
}

// Kept for back-compat (comfort scale only).
export const GREEN_LIGHT_VALUE_LABEL: Record<GreenLightValue, string> = {
  good: "I'm good",
  depends: "Depends",
  no: "No",
};

// ---------- Reveal engine (runs client-side; the deck is the source of truth) ----------

export interface GreenLightAnswerLike {
  value: string;
  note?: string;
}
export interface GreenLightRevealItem {
  id: string;
  label: string;
  valueLabel: string;
  scale: GreenLightScale;
}
export interface GreenLightPairItem {
  id: string;
  label: string;
  scale: GreenLightScale;
  mine: { value: string; label: string; note?: string };
  partner: { value: string; label: string; note?: string };
}
export interface GreenLightTalkItem extends GreenLightPairItem {
  opener: string;
}
export interface GreenLightCadenceItem extends GreenLightPairItem {
  gap: number;
}
export interface GreenLightsReveal {
  greenLights: GreenLightRevealItem[];
  agreedLimits: GreenLightRevealItem[];
  talk: GreenLightTalkItem[];
  cadence: GreenLightCadenceItem[];
  syncScore: number | null;
}

function gentleOpener(card: GreenLightCard, ia: number, ib: number): string {
  if (card.scale === "prefer") {
    return "You lean different ways here — share what each of you likes about your side. No wrong answer.";
  }
  const lo = Math.min(ia, ib);
  const hi = Math.max(ia, ib);
  if (lo === 0 && hi === 2) return "One of you is in, one's a clear no — start by asking what's behind the no, with zero pressure to land anywhere.";
  if (lo === 0 && hi === 1) return "Almost aligned — one's in, one's on the fence. Ask what would tip the maybe to a yes.";
  if (lo === 1 && hi === 2) return "One's out, one's on the fence — worth finding where the line is, and why.";
  if (lo === 1 && hi === 1) return "You're both somewhere in the middle — lay your conditions side by side and see if they meet.";
  return "Worth a gentle conversation — share the why behind each answer.";
}

export function computeGreenLightsReveal(
  mine: Record<string, GreenLightAnswerLike>,
  partner: Record<string, GreenLightAnswerLike>,
): GreenLightsReveal {
  const greenLights: GreenLightRevealItem[] = [];
  const agreedLimits: GreenLightRevealItem[] = [];
  const talk: GreenLightTalkItem[] = [];
  const cadence: GreenLightCadenceItem[] = [];
  let both = 0;
  let aligned = 0;

  for (const card of GREEN_LIGHT_DECK) {
    const a = mine[card.id];
    const b = partner[card.id];
    if (!a || !b) continue;
    const opts = optionsForCard(card);
    const ia = opts.findIndex((o) => o.id === a.value);
    const ib = opts.findIndex((o) => o.id === b.value);
    // Skip any answer that isn't a current option for the card's scale — e.g. a
    // value stored under the deck's PREVIOUS scale before a card was re-scaled.
    // It can't be compared, so it must never land in a bucket or the sync math
    // (a stale "good" on an `agree` card would findIndex→-1 and otherwise both
    // corrupt syncScore and leak the raw id to the UI). Re-taking refreshes it.
    if (ia < 0 || ib < 0) continue;
    const mineSide = { value: a.value, label: labelForCardValue(card, a.value), note: a.note };
    const partnerSide = { value: b.value, label: labelForCardValue(card, b.value), note: b.note };

    if (card.scale === "cadence") {
      cadence.push({
        id: card.id, label: card.label, scale: card.scale,
        mine: mineSide, partner: partnerSide,
        gap: ia >= 0 && ib >= 0 ? Math.abs(ia - ib) : 0,
      });
      continue; // gap-based, excluded from the sync math
    }

    both += 1;
    const same = a.value === b.value;
    if (same) aligned += 1;

    if (card.scale === "prefer") {
      if (same) {
        // Both lean the same way (or both "either") — on the same page.
        greenLights.push({ id: card.id, label: card.label, valueLabel: mineSide.label, scale: card.scale });
      } else {
        talk.push({ id: card.id, label: card.label, scale: card.scale, mine: mineSide, partner: partnerSide, opener: gentleOpener(card, ia, ib) });
      }
      continue;
    }

    // comfort / agree / want / matters — top = aligned-yes, bottom = shared-no.
    const last = opts.length - 1;
    if (ia === 0 && ib === 0) {
      greenLights.push({ id: card.id, label: card.label, valueLabel: mineSide.label, scale: card.scale });
    } else if (ia === last && ib === last) {
      agreedLimits.push({ id: card.id, label: card.label, valueLabel: mineSide.label, scale: card.scale });
    } else {
      talk.push({ id: card.id, label: card.label, scale: card.scale, mine: mineSide, partner: partnerSide, opener: gentleOpener(card, ia, ib) });
    }
  }

  return {
    greenLights,
    agreedLimits,
    talk,
    cadence,
    syncScore: both === 0 ? null : Math.round((aligned / both) * 100),
  };
}
