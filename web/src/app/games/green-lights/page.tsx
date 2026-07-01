"use client";

/**
 * Green Lights — a double-blind comfort & agreements questionnaire (sibling to
 * the Sex Quiz). Each partner privately answers "I'm good / Depends / No" (with
 * an optional note) to a deck of agreement statements; nothing reveals until both
 * finish. Then it opens what you're on the same page about (green lights + agreed
 * limits) and — the point — the opposites: where you differ or it's conditional,
 * as a "talk about these" list.
 *
 * Route + API are /games/green-lights and /api/green-lights. v1 stores answers
 * plaintext-at-rest (encrypted by the store envelope) + double-blind at the app
 * layer, mirroring the Sex Quiz.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import DesireStyles from "@/components/DesireStyles";
import LibidoNote from "@/components/LibidoNote";
import SyncScoreReveal from "@/components/SyncScoreReveal";
import { ErrorState, SkeletonList } from "@/components/States";
import {
  ApiUnauthorizedError,
  getGreenLights,
  retakeGreenLights,
  submitGreenLights,
} from "@/lib/api";
import { getProfileCached } from "@/lib/profile-cache";
import { clearRunnerDraft, loadRunnerDraft, saveRunnerDraft } from "@/lib/runner-draft";
import {
  GREEN_LIGHT_DECK,
  GREEN_LIGHT_BY_ID,
  computeGreenLightsReveal,
  greenLightCategoryTitle,
  labelForCardValue,
  optionsForCard,
  valueTone,
  type GreenLightTone,
} from "@/lib/green-lights-deck";
import type { AuthInfo, GreenLightAnswer, GreenLightsResponse, ProfileResponse, Workspace } from "@/lib/types";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unauthorized" }
  | { kind: "no-workspace" }
  | { kind: "ready"; auth: AuthInfo; workspace: Workspace; data: GreenLightsResponse };

const ACCENT_BTN: CSSProperties = {
  background: "linear-gradient(158deg, var(--accent), var(--accent-deep))",
  color: "var(--ink)",
  fontWeight: 600,
  boxShadow: "0 4px 16px rgb(var(--accent-rgb) / 0.3)",
};

// Answer-button styling keyed by the card's position TONE (see valueTone):
// pos = top/positive, mid = middle, neg = bottom/no, pole = a prefer/cadence
// choice (neither good nor bad → neutral accent).
const TONE_STYLE: Record<GreenLightTone, CSSProperties> = {
  pos: { background: "linear-gradient(158deg, #6FB89A, #3E8B6D)", color: "#0e1a13" },
  mid: { background: "rgb(var(--gold-rgb) / 0.16)", color: "var(--gold)", boxShadow: "var(--ring-hairline)" },
  neg: { background: "rgb(var(--no-rgb) / 0.16)", color: "rgb(var(--no-rgb))", boxShadow: "var(--ring-hairline)" },
  pole: { background: "rgb(var(--accent-rgb) / 0.14)", color: "var(--accent)", boxShadow: "var(--ring-hairline)" },
};
function toneColor(tone: GreenLightTone): string {
  if (tone === "pos") return "#7cc4a3";
  if (tone === "mid") return "var(--gold)";
  if (tone === "neg") return "rgb(var(--no-rgb))";
  return "var(--accent)";
}
// Cadence reveal — text for a gap already measured (steps apart) by the engine.
function cadenceGapText(gap: number): string {
  if (gap === 0) return "Same answer — you're in sync on how often.";
  if (gap === 1) return "One step apart — close. Easy to meet in the middle.";
  return "A real gap in how often you each want it — worth talking about what you each need.";
}

export default function GreenLightsPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const profile: ProfileResponse = await getProfileCached();
        if (cancelled) return;
        if (!profile.activeWorkspace) {
          setState({ kind: "no-workspace" });
          return;
        }
        const data = await getGreenLights(profile.activeWorkspace.id);
        if (cancelled) return;
        setState({ kind: "ready", auth: profile.auth, workspace: profile.activeWorkspace, data });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiUnauthorizedError) {
          setState({ kind: "unauthorized" });
          return;
        }
        setState({ kind: "error", message: error instanceof Error ? error.message : "Couldn't load Green Lights." });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <AppShell>
      <header className="sheet-header">
        <Link href="/games" className="fd-back pressable" aria-label="Back to Reveals">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <span className="sheet-title">Green Lights</span>
        <span style={{ width: 22 }} aria-hidden="true" />
      </header>
      <Body state={state} setState={setState} />
    </AppShell>
  );
}

function Body({ state, setState }: { state: LoadState; setState: (s: LoadState) => void }) {
  if (state.kind === "loading") return <SkeletonList count={4} />;
  if (state.kind === "unauthorized") {
    return <ErrorState title="Session expired" body="Sign in again to take Green Lights." action={<Link href="/" className="btn-ghost">Back to sign-in</Link>} />;
  }
  if (state.kind === "error") return <ErrorState title="Couldn't load Green Lights" body={state.message} />;
  if (state.kind === "no-workspace") {
    return <ErrorState title="No partner space yet" body="Green Lights needs a paired room." action={<Link href="/space" className="btn-ghost">Open Space</Link>} />;
  }

  const { workspace, data } = state;
  const onUpdate = (next: GreenLightsResponse) => setState({ ...state, data: next });

  if (!data.mySubmitted) return <Runner workspace={workspace} onSubmitted={onUpdate} />;
  if (data.status !== "revealed") return <Waiting workspace={workspace} data={data} onUpdate={onUpdate} />;
  return <Reveal workspace={workspace} data={data} onUpdate={onUpdate} />;
}

// ---------- Taking it ----------

function Runner({ workspace, onSubmitted }: { workspace: Workspace; onSubmitted: (next: GreenLightsResponse) => void }) {
  const deck = GREEN_LIGHT_DECK;
  const [phase, setPhase] = useState<"intro" | "cards" | "review">("intro");
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, GreenLightAnswer>>({});
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const initialDraft = useRef(loadRunnerDraft<{ answers: Record<string, GreenLightAnswer>; index: number; phase: "cards" | "review" }>("green-lights", workspace.id));

  // Autosave (same-device, localStorage) so a long sit can be picked back up.
  useEffect(() => {
    if (phase === "intro") return;
    saveRunnerDraft("green-lights", workspace.id, { answers, index, phase });
  }, [answers, index, phase, workspace.id]);

  const card = deck[index];

  function loadCard(i: number) {
    const existing = answers[deck[i].id];
    setNote(existing?.note || "");
    setShowNote(Boolean(existing?.note));
  }

  function choose(value: string) {
    const entry: GreenLightAnswer = { value };
    const trimmed = note.trim();
    if (trimmed) entry.note = trimmed;
    setAnswers((prev) => ({ ...prev, [card.id]: entry }));
    if (index + 1 < deck.length) {
      const next = index + 1;
      setIndex(next);
      loadCard(next);
    } else {
      setPhase("review");
    }
  }

  function back() {
    if (index === 0) return;
    const prev = index - 1;
    setIndex(prev);
    loadCard(prev);
  }

  // Move forward through already-answered cards WITHOUT re-answering, so going
  // back to review never forces a re-pick (which silently changed the answer).
  function next() {
    if (index + 1 >= deck.length || !answers[card.id]) return;
    const upcoming = index + 1;
    setIndex(upcoming);
    loadCard(upcoming);
  }

  function resumeDraft() {
    const d = initialDraft.current;
    if (!d) return;
    const restored = d.answers || {};
    setAnswers(restored);
    const i = Math.min(Math.max(0, d.index || 0), deck.length - 1);
    setIndex(i);
    const existing = restored[deck[i].id];
    setNote(existing?.note || "");
    setShowNote(Boolean(existing?.note));
    setPhase(d.phase === "review" ? "review" : "cards");
  }
  function startFresh() {
    clearRunnerDraft("green-lights", workspace.id);
    initialDraft.current = null;
    setAnswers({});
    setIndex(0);
    setNote("");
    setShowNote(false);
    setPhase("cards");
  }

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      const next = await submitGreenLights({ workspaceId: workspace.id, answers });
      clearRunnerDraft("green-lights", workspace.id);
      onSubmitted(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't submit. Try again.");
      setSubmitting(false);
    }
  }

  if (phase === "intro") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "10px 22px" }}>
        <p className="eyebrow">Where you both stand</p>
        <p style={{ color: "var(--cream)", fontSize: 16, lineHeight: 1.55 }}>
          {deck.length} honest reads on sex, autonomy, and what you&apos;re each okay with — your green lights and your hard limits both. Answer <strong>I&apos;m good</strong>, <strong>Depends</strong>, or <strong>No</strong>, and add a note wherever it&apos;s conditional.
        </p>
        <p style={{ color: "rgb(var(--cream-rgb) / 0.55)", fontSize: 14, lineHeight: 1.55 }}>
          🔒 Double-blind: nothing shows until you&apos;ve both finished. Then you&apos;ll see what you&apos;re aligned on — and the few worth talking through.
        </p>
        <p style={{ color: "rgb(var(--cream-rgb) / 0.55)", fontSize: 14, lineHeight: 1.55 }}>
          No wrong answers — and <strong>Depends</strong> is often the most honest one.
        </p>
        <DesireStyles />
        <LibidoNote />
        {(initialDraft.current && Object.keys(initialDraft.current.answers || {}).length > 0) ? (
          <>
            <button type="button" className="pressable" style={{ ...ACCENT_BTN, padding: 15, borderRadius: 16, border: "none", fontSize: 15 }} onClick={resumeDraft}>
              Resume — {Object.keys(initialDraft.current.answers || {}).length} answered
            </button>
            <button type="button" className="btn-ghost" onClick={startFresh}>Start over</button>
          </>
        ) : (
          <button type="button" className="pressable" style={{ ...ACCENT_BTN, padding: 15, borderRadius: 16, border: "none", fontSize: 15 }} onClick={startFresh}>
            Start
          </button>
        )}
      </div>
    );
  }

  if (phase === "review") {
    const answered = Object.keys(answers).length;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "10px 22px", textAlign: "center", alignItems: "center", marginTop: 16 }}>
        <div style={{ fontSize: 40 }}>🔒</div>
        <p style={{ color: "var(--cream)", fontSize: 18, fontWeight: 600 }}>You answered all {answered}</p>
        <p style={{ color: "rgb(var(--cream-rgb) / 0.6)", fontSize: 15, lineHeight: 1.55, maxWidth: "32ch" }}>
          Lock it in — your partner won&apos;t see anything until they finish too, and neither will you.
        </p>
        {error && <p style={{ color: "rgb(var(--no-rgb))", fontSize: 13 }}>{error}</p>}
        <div style={{ display: "flex", gap: 10, width: "100%" }}>
          <button type="button" className="btn-ghost" disabled={submitting} onClick={() => { setPhase("cards"); setIndex(deck.length - 1); loadCard(deck.length - 1); }}>Back</button>
          <button type="button" className="pressable" style={{ ...ACCENT_BTN, flex: 1, padding: 14, borderRadius: 16, border: "none", fontSize: 15 }} disabled={submitting} onClick={submit}>
            {submitting ? "Locking in…" : "Lock in my answers"}
          </button>
        </div>
      </div>
    );
  }

  // phase === "cards"
  const pct = Math.round(((index + 1) / deck.length) * 100);
  const nextDisabled = index + 1 >= deck.length || !answers[card.id];
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0, gap: 14, padding: "8px 22px 4px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button type="button" onClick={back} aria-label="Previous" disabled={index === 0}
          style={{ background: "none", border: "none", color: "rgb(var(--cream-rgb) / 0.6)", fontSize: 20, cursor: index === 0 ? "default" : "pointer", opacity: index === 0 ? 0.3 : 1, padding: 0 }}>‹</button>
        <div style={{ flex: 1, height: 5, borderRadius: 999, background: "rgb(var(--cream-rgb) / 0.1)", overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: "linear-gradient(90deg, var(--accent), var(--accent-deep))", borderRadius: 999, transition: "width 240ms ease" }} />
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "rgb(var(--cream-rgb) / 0.5)" }}>{index + 1} / {deck.length}</div>
        <button type="button" onClick={next} aria-label="Next" disabled={nextDisabled}
          style={{ background: "none", border: "none", color: "rgb(var(--cream-rgb) / 0.6)", fontSize: 20, cursor: nextDisabled ? "default" : "pointer", opacity: nextDisabled ? 0.3 : 1, padding: 0 }}>›</button>
      </div>

      <div style={{ flex: 1, display: "flex", alignItems: "center" }}>
        <div style={{ width: "100%", background: "var(--surface-2)", borderRadius: 24, boxShadow: "var(--ring-hairline-strong)", padding: "26px 22px", textAlign: "center" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgb(var(--cream-rgb) / 0.4)" }}>
            {greenLightCategoryTitle(card.category)}{card.heavy ? " · talk first" : ""}
          </div>
          <div style={{ fontSize: 20, color: "var(--cream)", fontWeight: 600, marginTop: 14, lineHeight: 1.4 }}>{card.label}</div>
          {showNote ? (
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a condition (optional)"
              maxLength={240}
              style={{ marginTop: 16, width: "100%", background: "rgb(var(--cream-rgb) / 0.06)", border: "none", borderRadius: 12, padding: "10px 12px", color: "var(--cream)", fontSize: 14, boxShadow: "var(--ring-hairline)" }}
            />
          ) : (
            <button type="button" onClick={() => setShowNote(true)} style={{ marginTop: 14, background: "none", border: "none", color: "rgb(var(--accent-rgb) / 0.8)", fontSize: 13, cursor: "pointer" }}>+ add a note</button>
          )}
        </div>
      </div>

      {/* Each card renders its own scale's options, ordered positive → negative,
          tone-colored (green / gold / red, or neutral accent for prefer & cadence). */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {optionsForCard(card).map((opt) => {
          const picked = answers[card.id]?.value === opt.id;
          const tone = TONE_STYLE[valueTone(card, opt.id)];
          return (
            <button key={opt.id} type="button" className="pressable" aria-pressed={picked} onClick={() => choose(opt.id)}
              style={{ padding: 15, borderRadius: 16, border: "none", fontSize: 14.5, fontWeight: 600, ...tone, boxShadow: picked ? "inset 0 0 0 2px var(--cream)" : tone.boxShadow, opacity: answers[card.id] && !picked ? 0.5 : 1 }}>
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Waiting ----------

function Waiting({ workspace, data, onUpdate }: { workspace: Workspace; data: GreenLightsResponse; onUpdate: (next: GreenLightsResponse) => void }) {
  const [showMine, setShowMine] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "10px 22px", textAlign: "center", alignItems: "center", marginTop: 24 }}>
      <div style={{ fontSize: 40 }}>🔒</div>
      <p style={{ color: "var(--cream)", fontSize: 18, fontWeight: 600 }}>Your answers are locked in</p>
      <p style={{ color: "rgb(var(--cream-rgb) / 0.6)", fontSize: 15, lineHeight: 1.55, maxWidth: "32ch" }}>
        {data.partnerName || "Your partner"}&apos;s stay hidden until they finish too — but you can always look back at your own.
      </p>
      <button type="button" className="btn-ghost" onClick={() => setShowMine((v) => !v)} aria-expanded={showMine}>
        {showMine ? "Hide my answers" : "View my answers"}
      </button>
      {showMine && <MyGreenLights data={data} />}
      <button type="button" className="btn-ghost" style={{ marginTop: 8 }} onClick={() => { retakeGreenLights(workspace.id).then(onUpdate).catch(() => {}); }}>
        Redo my answers
      </button>
    </div>
  );
}

// Read-only view of your own answers — every card you answered, grouped by
// category, with the option you picked. Available while waiting (and reusable in
// the reveal) so you never have to retake just to remember what you said.
function MyGreenLights({ data }: { data: GreenLightsResponse }) {
  const answers = data.myAnswers || {};
  const rows = GREEN_LIGHT_DECK.filter((card) => answers[card.id]);
  if (rows.length === 0) {
    return <p style={{ color: "rgb(var(--cream-rgb) / 0.55)", fontSize: 14 }}>You didn&apos;t answer any.</p>;
  }
  let lastCategory = "";
  return (
    <div style={{ width: "100%", textAlign: "left" }}>
      <p className="eyebrow" style={{ color: "rgb(var(--cream-rgb) / 0.5)" }}>Your answers</p>
      <div style={{ marginTop: 6, background: "var(--surface-2)", borderRadius: 18, boxShadow: "var(--ring-hairline-strong)", padding: "4px 16px" }}>
        {rows.map((card) => {
          const answer = answers[card.id];
          const showHeader = card.category !== lastCategory;
          lastCategory = card.category;
          return (
            <div key={card.id}>
              {showHeader && (
                <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgb(var(--cream-rgb) / 0.4)", paddingTop: 12, paddingBottom: 2 }}>
                  {greenLightCategoryTitle(card.category)}
                </div>
              )}
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 0", borderBottom: "1px solid var(--hairline)" }}>
                <span style={{ flex: 1, color: "var(--cream)", fontSize: 13.5, lineHeight: 1.35 }}>{card.label}</span>
                <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: toneColor(valueTone(card, answer.value)), whiteSpace: "nowrap", textAlign: "right" }}>
                  {labelForCardValue(card, answer.value)}
                </span>
              </div>
              {answer.note && (
                <div style={{ fontSize: 11.5, color: "rgb(var(--cream-rgb) / 0.5)", paddingBottom: 8, lineHeight: 1.4 }}>&ldquo;{answer.note}&rdquo;</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Reveal ----------

function Reveal({ workspace, data, onUpdate }: { workspace: Workspace; data: GreenLightsResponse; onUpdate: (next: GreenLightsResponse) => void }) {
  const partnerName = data.partnerName || "your partner";
  const [showMine, setShowMine] = useState(false);
  // The deck is the source of truth: derive every bucket from both answer sets.
  const { greenLights, agreedLimits, talk, cadence, syncScore } = useMemo(
    () => computeGreenLightsReveal(data.myAnswers || {}, data.partnerAnswers || {}),
    [data.myAnswers, data.partnerAnswers],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, padding: "8px 22px 4px" }}>
      <div>
        <p className="eyebrow">Where you stand</p>
        {syncScore !== null && <SyncScoreReveal score={syncScore} label="On the same page" />}
        <p style={{ fontSize: 15, color: "rgb(var(--cream-rgb) / 0.62)", lineHeight: 1.5, marginTop: 10 }}>
          You&apos;re aligned on <strong style={{ color: "var(--cream)" }}>{greenLights.length + agreedLimits.length}</strong>{talk.length > 0 ? <> — and there {talk.length === 1 ? "is" : "are"} <strong style={{ color: "var(--cream)" }}>{talk.length}</strong> worth talking through.</> : "."}
        </p>
      </div>

      {cadence.length > 0 && (
        <section>
          <p className="eyebrow">How often you each want it</p>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {cadence.map((c) => (
              <div key={c.id} style={{ background: "var(--surface-2)", borderRadius: 16, boxShadow: "var(--ring-hairline-strong)", padding: "14px 16px" }}>
                <div style={{ color: "rgb(var(--cream-rgb) / 0.7)", fontSize: 13, lineHeight: 1.4, textAlign: "center", marginBottom: 12 }}>{c.label}</div>
                <div style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
                  <div style={{ flex: 1, textAlign: "center" }}>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgb(var(--cream-rgb) / 0.45)" }}>You</div>
                    <div style={{ color: "var(--cream)", fontSize: 15, fontWeight: 600, marginTop: 4 }}>{c.mine.label}</div>
                  </div>
                  <div style={{ width: 1, background: "rgb(var(--cream-rgb) / 0.12)" }} aria-hidden="true" />
                  <div style={{ flex: 1, textAlign: "center" }}>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgb(var(--cream-rgb) / 0.45)" }}>{partnerName}</div>
                    <div style={{ color: "var(--cream)", fontSize: 15, fontWeight: 600, marginTop: 4 }}>{c.partner.label}</div>
                  </div>
                </div>
                <div style={{ marginTop: 12, fontSize: 12.5, lineHeight: 1.45, textAlign: "center", color: c.gap >= 2 ? "var(--gold)" : "#9fd6bb" }}>
                  {c.gap === 0 ? "✓ " : ""}{cadenceGapText(c.gap)}
                </div>
                {(c.mine.note || c.partner.note) && (
                  <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 12, justifyContent: "center", fontSize: 11.5, fontFamily: "var(--mono)", color: "rgb(var(--cream-rgb) / 0.5)" }}>
                    {c.mine.note ? <span>You: {c.mine.note}</span> : null}
                    {c.partner.note ? <span>{partnerName}: {c.partner.note}</span> : null}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {talk.length > 0 && (
        <section>
          <p className="eyebrow" style={{ color: "var(--gold)" }}>Talk about these</p>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            {talk.map((t) => {
              const card = GREEN_LIGHT_BY_ID[t.id];
              return (
                <div key={t.id} style={{ background: "var(--surface-2)", borderRadius: 16, boxShadow: "var(--ring-hairline-strong)", padding: "12px 14px" }}>
                  <div style={{ color: "var(--cream)", fontSize: 14.5, lineHeight: 1.4 }}>{t.label}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 8, fontSize: 12, fontFamily: "var(--mono)" }}>
                    <span style={{ color: card ? toneColor(valueTone(card, t.mine.value)) : "var(--cream)" }}>You: {t.mine.label}{t.mine.note ? ` — ${t.mine.note}` : ""}</span>
                    <span style={{ color: card ? toneColor(valueTone(card, t.partner.value)) : "var(--cream)" }}>{partnerName}: {t.partner.label}{t.partner.note ? ` — ${t.partner.note}` : ""}</span>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 12.5, color: "rgb(var(--cream-rgb) / 0.6)", lineHeight: 1.45 }}>
                    💬 {t.opener}
                  </div>
                </div>
              );
            })}
          </div>
          <Link href="/chat" className="pressable" style={{ ...ACCENT_BTN, display: "block", marginTop: 12, padding: 13, borderRadius: 16, textAlign: "center", textDecoration: "none", fontSize: 14 }}>
            Talk it through in Sext
          </Link>
        </section>
      )}

      {greenLights.length > 0 && (
        <section>
          <p className="eyebrow" style={{ color: "#7cc4a3" }}>Green lights · you&apos;re aligned</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            {greenLights.map((c) => (
              <span key={c.id} style={{ padding: "7px 13px", borderRadius: 999, fontSize: 13, background: "rgb(110 184 154 / 0.14)", color: "#9fd6bb", boxShadow: "var(--ring-hairline)" }}>
                {c.label}{c.scale !== "comfort" ? ` · ${c.valueLabel}` : ""}
              </span>
            ))}
          </div>
        </section>
      )}

      {agreedLimits.length > 0 && (
        <section>
          <p className="eyebrow" style={{ color: "rgb(var(--no-rgb))" }}>Agreed limits · shared no&apos;s</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            {agreedLimits.map((c) => (
              <span key={c.id} style={{ padding: "7px 13px", borderRadius: 999, fontSize: 13, background: "rgb(var(--no-rgb) / 0.12)", color: "rgb(var(--no-rgb))", boxShadow: "var(--ring-hairline)" }}>
                {c.label}{c.scale !== "comfort" ? ` · ${c.valueLabel}` : ""}
              </span>
            ))}
          </div>
        </section>
      )}

      <div style={{ textAlign: "center" }}>
        <button type="button" className="btn-ghost" onClick={() => setShowMine((v) => !v)} aria-expanded={showMine}>
          {showMine ? "Hide my answers" : "View my answers"}
        </button>
      </div>
      {showMine && <MyGreenLights data={data} />}

      <p style={{ fontSize: 12, color: "rgb(var(--cream-rgb) / 0.45)", lineHeight: 1.5 }}>
        A gap isn&apos;t a verdict — it&apos;s just where a conversation helps.
      </p>

      <button type="button" className="btn-ghost" onClick={() => { retakeGreenLights(workspace.id).then(onUpdate).catch(() => {}); }}>
        Retake
      </button>
    </div>
  );
}
