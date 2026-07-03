"use client";

/**
 * Sex Quiz — a double-blind desire profile. Each partner privately rates the
 * deck (Pass / Curious / Into it, plus Give / Receive / Both where it applies)
 * and pins their top turn-ons. Nothing reveals until both finish; then the
 * overlap (matches + complementary fits + curious-together) opens, and each
 * partner's top picks surface here, on the Sexboard, and in Sext.
 *
 * The route + API are /games/sex-quiz and /api/sex-quiz. v1 stores ratings
 * plaintext-at-rest (encrypted by the store envelope) + double-blind at the
 * app layer; Room-E2EE for the ratings is a planned follow-up.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import DesireStyles from "@/components/DesireStyles";
import SyncScoreReveal from "@/components/SyncScoreReveal";
import { ErrorState, SkeletonList } from "@/components/States";
import TopTurnOns from "@/components/TopTurnOns";
import {
  ApiUnauthorizedError,
  createBoundary,
  getSexQuiz,
  retakeSexQuiz,
  setSexQuizFullReveal,
  setSexQuizTopPicks,
  submitSexQuiz,
} from "@/lib/api";
import { getProfileCached } from "@/lib/profile-cache";
import { clearRunnerDraft, loadRunnerDraft, saveRunnerDraft } from "@/lib/runner-draft";
import {
  QUIZ_CARD_BY_ID,
  QUIZ_DECK,
  categoryTitle,
  proposeHref,
  type QuizCard,
  type QuizInterest,
  type QuizRole,
} from "@/lib/quiz-deck";
import type { AuthInfo, ProfileResponse, SexQuizRating, SexQuizResponse, Workspace } from "@/lib/types";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unauthorized" }
  | { kind: "no-workspace" }
  | { kind: "ready"; auth: AuthInfo; workspace: Workspace; quiz: SexQuizResponse };

const ACCENT_BTN: CSSProperties = {
  background: "linear-gradient(158deg, var(--accent), var(--accent-deep))",
  color: "var(--ink)",
  fontWeight: 600,
  boxShadow: "0 4px 16px rgb(var(--accent-rgb) / 0.3)",
};

export default function SexQuizPage() {
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
        const quiz = await getSexQuiz(profile.activeWorkspace.id);
        if (cancelled) return;
        setState({ kind: "ready", auth: profile.auth, workspace: profile.activeWorkspace, quiz });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiUnauthorizedError) {
          setState({ kind: "unauthorized" });
          return;
        }
        setState({ kind: "error", message: error instanceof Error ? error.message : "Couldn't load the Sex Quiz." });
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
        <span className="sheet-title">Sex Quiz</span>
        <span style={{ width: 22 }} aria-hidden="true" />
      </header>
      <Body state={state} setState={setState} />
    </AppShell>
  );
}

function Body({ state, setState }: { state: LoadState; setState: (s: LoadState) => void }) {
  if (state.kind === "loading") return <SkeletonList count={4} />;
  if (state.kind === "unauthorized") {
    return <ErrorState title="Session expired" body="Sign in again to take the Sex Quiz." action={<Link href="/" className="btn-ghost">Back to sign-in</Link>} />;
  }
  if (state.kind === "error") return <ErrorState title="Couldn't load the Sex Quiz" body={state.message} />;
  if (state.kind === "no-workspace") {
    return <ErrorState title="No partner space yet" body="The Sex Quiz needs a paired room." action={<Link href="/space" className="btn-ghost">Open Space</Link>} />;
  }

  const { workspace, quiz } = state;
  const onUpdate = (next: SexQuizResponse) => setState({ ...state, quiz: next });

  if (!quiz.mySubmitted) {
    return <QuizRunner workspace={workspace} onSubmitted={onUpdate} />;
  }
  if (quiz.status !== "revealed") {
    return <Waiting workspace={workspace} quiz={quiz} onUpdate={onUpdate} />;
  }
  return <Reveal workspace={workspace} quiz={quiz} onUpdate={onUpdate} />;
}

// ---------- Taking the quiz ----------

function QuizRunner({ workspace, onSubmitted }: { workspace: Workspace; onSubmitted: (next: SexQuizResponse) => void }) {
  const deck = QUIZ_DECK;
  const [phase, setPhase] = useState<"intro" | "cards" | "picks">("intro");
  const [index, setIndex] = useState(0);
  const [ratings, setRatings] = useState<Record<string, SexQuizRating>>({});
  const [role, setRole] = useState<QuizRole | "">("");
  const [topPicks, setTopPicks] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const initialDraft = useRef(loadRunnerDraft<{ ratings: Record<string, SexQuizRating>; topPicks: string[]; index: number; phase: "cards" | "picks" }>("sex-quiz", workspace.id));

  // Autosave (same-device, localStorage) so a long sit can be picked back up.
  useEffect(() => {
    if (phase === "intro") return;
    saveRunnerDraft("sex-quiz", workspace.id, { ratings, topPicks, index, phase });
  }, [ratings, topPicks, index, phase, workspace.id]);

  function resumeDraft() {
    const d = initialDraft.current;
    if (!d) return;
    const restored = d.ratings || {};
    setRatings(restored);
    setTopPicks(Array.isArray(d.topPicks) ? d.topPicks : []);
    const i = Math.min(Math.max(0, d.index || 0), deck.length - 1);
    setIndex(i);
    setRole((restored[deck[i].id]?.role as QuizRole) || "");
    setPhase(d.phase === "picks" ? "picks" : "cards");
  }
  function startFresh() {
    clearRunnerDraft("sex-quiz", workspace.id);
    initialDraft.current = null;
    setRatings({});
    setTopPicks([]);
    setIndex(0);
    setRole("");
    setPhase("cards");
  }

  // Swipe-to-rate: drag the card left = Pass, right = Into it, up = Curious. The
  // buttons stay as the tap fallback. dragRef mirrors `drag` so the pointer-up
  // handler reads the latest offset without a stale closure.
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef({ x: 0, y: 0 });
  const moveRaf = useRef(0);
  const flinging = useRef(false);

  const card = deck[index];
  const intoCards = useMemo(() => deck.filter((c) => ratings[c.id]?.interest === "into"), [deck, ratings]);

  function fling(interest: QuizInterest, target: { x: number; y: number }) {
    flinging.current = true;
    setDrag(target);
    window.setTimeout(() => {
      rate(interest);
      dragRef.current = { x: 0, y: 0 };
      setDrag({ x: 0, y: 0 });
      flinging.current = false;
    }, 180);
  }

  function onCardPointerDown(e: React.PointerEvent) {
    // Don't hijack taps on the role buttons inside the card.
    if (flinging.current || (e.target as HTMLElement).closest("button")) return;
    dragStart.current = { x: e.clientX, y: e.clientY };
    // Capture so move/up keep firing even if the finger drifts off the card.
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    setDragging(true);
  }
  function onCardPointerMove(e: React.PointerEvent) {
    if (!dragStart.current) return;
    const next = { x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y };
    dragRef.current = next;
    // Coalesce to one state commit per frame: pointermove fires at up to
    // 120Hz on iOS, and each uncoalesced setDrag ran a full QuizRunner
    // render (header, card, hint, buttons) before the style could land.
    if (moveRaf.current) return;
    moveRaf.current = requestAnimationFrame(() => {
      moveRaf.current = 0;
      setDrag(dragRef.current);
    });
  }
  function onCardPointerEnd() {
    if (!dragStart.current) return;
    dragStart.current = null;
    // A queued frame committing a stale mid-drag position after the snap-back
    // reset would make the card jump — drop it.
    if (moveRaf.current) {
      cancelAnimationFrame(moveRaf.current);
      moveRaf.current = 0;
    }
    setDragging(false);
    const { x, y } = dragRef.current;
    if (x > 90) fling("into", { x: 480, y });
    else if (x < -90) fling("pass", { x: -480, y });
    else if (y < -80) fling("curious", { x, y: -480 });
    else { dragRef.current = { x: 0, y: 0 }; setDrag({ x: 0, y: 0 }); }
  }

  function rate(interest: QuizInterest) {
    const entry: SexQuizRating = { interest };
    // Only record a role when the user actually picked one — don't coerce an
    // unspecified preference into "both" (which would fake a give/receive fit).
    if (card.role && interest !== "pass" && role) entry.role = role as QuizRole;
    setRatings((prev) => ({ ...prev, [card.id]: entry }));
    if (index + 1 < deck.length) {
      const next = deck[index + 1];
      setIndex(index + 1);
      setRole((ratings[next.id]?.role as QuizRole) || "");
    } else {
      setPhase("picks");
    }
  }

  function back() {
    if (index === 0) return;
    const prev = deck[index - 1];
    setIndex(index - 1);
    setRole((ratings[prev.id]?.role as QuizRole) || "");
  }

  // Move forward through already-rated cards WITHOUT re-rating them, so going
  // back to review an answer never forces a re-pick (which silently changed it).
  // Disabled on the unrated frontier (current card not yet rated) and the end.
  function next() {
    if (index + 1 >= deck.length || !ratings[card.id]) return;
    const upcoming = deck[index + 1];
    setIndex(index + 1);
    setRole((ratings[upcoming.id]?.role as QuizRole) || "");
  }

  function togglePick(id: string) {
    setTopPicks((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < 5 ? [...prev, id] : prev));
  }

  async function submit() {
    setSubmitting(true);
    setError("");
    try {
      const next = await submitSexQuiz({ workspaceId: workspace.id, ratings, topPicks });
      clearRunnerDraft("sex-quiz", workspace.id);
      onSubmitted(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't submit. Try again.");
      setSubmitting(false);
    }
  }

  if (phase === "intro") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "10px 22px" }}>
        <p className="eyebrow">Build your desire map</p>
        <p style={{ color: "var(--cream)", fontSize: 16, lineHeight: 1.55 }}>
          {deck.length} cards, softest first — the full map of what turns you on. Mark each <strong>Pass</strong>, <strong>Curious</strong>, or <strong>Into it</strong>, and call who gives or receives where it fits.
        </p>
        <p style={{ color: "var(--cream)", fontSize: 16, lineHeight: 1.55 }}>
          Then pick your <strong>top 5 most-wanted</strong> — the highlights your partner sees first.
        </p>
        <p style={{ color: "rgb(var(--cream-rgb) / 0.55)", fontSize: 14, lineHeight: 1.55 }}>
          🔒 It's double-blind: nothing you pick shows to {workspace.members?.length ? "your partner" : "them"} until you've <em>both</em> finished. Passes stay private.
        </p>
        <p style={{ color: "rgb(var(--cream-rgb) / 0.55)", fontSize: 14, lineHeight: 1.55 }}>
          No wrong answers — nothing&apos;s too much or too tame. Let the slut out; your passes never show, so be greedy.
        </p>
        <DesireStyles />
        {(initialDraft.current && Object.keys(initialDraft.current.ratings || {}).length > 0) ? (
          <>
            <button type="button" className="pressable" style={{ ...ACCENT_BTN, padding: 15, borderRadius: 16, border: "none", fontSize: 15 }} onClick={resumeDraft}>
              Resume — {Object.keys(initialDraft.current.ratings || {}).length} rated
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

  if (phase === "picks") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "10px 22px" }}>
        <p className="eyebrow">Your top turn-ons</p>
        <p style={{ color: "var(--cream)", fontSize: 16, lineHeight: 1.5 }}>
          Tap your <strong>5 most-wanted</strong> in order — first tap is your #1. These are the highlights your partner sees first.
        </p>
        {intoCards.length === 0 ? (
          <p style={{ color: "rgb(var(--cream-rgb) / 0.55)", fontSize: 14 }}>
            You didn't mark anything "Into it" — that's okay. You can still reveal and compare.
          </p>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {intoCards.map((c) => {
              const rank = topPicks.indexOf(c.id);
              const on = rank >= 0;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => togglePick(c.id)}
                  aria-pressed={on}
                  style={{
                    padding: "8px 13px", borderRadius: 999, border: "none", fontSize: 14, cursor: "pointer",
                    ...(on ? ACCENT_BTN : { background: "rgb(var(--cream-rgb) / 0.08)", color: "var(--cream)", boxShadow: "var(--ring-hairline)" }),
                  }}
                >
                  {on ? <strong style={{ marginRight: 5 }}>{rank + 1}.</strong> : null}{c.emoji} {c.label}
                </button>
              );
            })}
          </div>
        )}
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "rgb(var(--cream-rgb) / 0.45)" }}>{topPicks.length} / 5 pinned</div>
        {error && <p style={{ color: "rgb(var(--no-rgb))", fontSize: 13 }}>{error}</p>}
        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" className="btn-ghost" onClick={() => setPhase("cards")} disabled={submitting}>Back</button>
          <button type="button" className="pressable" style={{ ...ACCENT_BTN, flex: 1, padding: 14, borderRadius: 16, border: "none", fontSize: 15 }} disabled={submitting} onClick={submit}>
            {submitting ? "Revealing…" : "Reveal to your partner"}
          </button>
        </div>
      </div>
    );
  }

  // phase === "cards"
  const pct = Math.round(((index + 1) / deck.length) * 100);
  const swipeHint = drag.x > 50 ? { label: "Into it", color: "var(--accent)" }
    : drag.x < -50 ? { label: "Pass", color: "rgb(var(--cream-rgb) / 0.65)" }
    : drag.y < -45 ? { label: "Curious", color: "var(--cream)" }
    : null;
  const swipeOpacity = Math.min(1, Math.max(Math.abs(drag.x) / 90, drag.y < 0 ? -drag.y / 80 : 0));
  const savedInterest = ratings[card.id]?.interest;
  const nextDisabled = index + 1 >= deck.length || !savedInterest;
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0, gap: 14, padding: "8px 22px 4px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button type="button" onClick={back} aria-label="Previous card" disabled={index === 0}
          style={{ background: "none", border: "none", color: "rgb(var(--cream-rgb) / 0.6)", fontSize: 20, cursor: index === 0 ? "default" : "pointer", opacity: index === 0 ? 0.3 : 1, padding: 0 }}>‹</button>
        <div style={{ flex: 1, height: 5, borderRadius: 999, background: "rgb(var(--cream-rgb) / 0.1)", overflow: "hidden" }}>
          {/* scaleX, not width — a width transition re-runs layout every frame. */}
          <div style={{ width: "100%", height: "100%", background: "linear-gradient(90deg, var(--accent), var(--accent-deep))", borderRadius: 999, transform: `scaleX(${pct / 100})`, transformOrigin: "left", transition: "transform 240ms ease" }} />
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "rgb(var(--cream-rgb) / 0.5)" }}>{index + 1} / {deck.length}</div>
        <button type="button" onClick={next} aria-label="Next card" disabled={nextDisabled}
          style={{ background: "none", border: "none", color: "rgb(var(--cream-rgb) / 0.6)", fontSize: 20, cursor: nextDisabled ? "default" : "pointer", opacity: nextDisabled ? 0.3 : 1, padding: 0 }}>›</button>
      </div>

      <div style={{ flex: 1, display: "flex", alignItems: "center" }}>
        <div
          onPointerDown={onCardPointerDown}
          onPointerMove={onCardPointerMove}
          onPointerUp={onCardPointerEnd}
          onPointerCancel={onCardPointerEnd}
          style={{ position: "relative", width: "100%", background: "var(--surface-2)", borderRadius: 24, boxShadow: "var(--ring-hairline-strong)", padding: "28px 22px", textAlign: "center", touchAction: "none", userSelect: "none", cursor: dragging ? "grabbing" : "grab", transform: `translate(${drag.x}px, ${drag.y}px) rotate(${drag.x * 0.04}deg)`, transition: dragging ? "none" : "transform 200ms var(--ease-settle, ease)", willChange: dragging ? "transform" : undefined }}
        >
          {swipeHint && (
            <div aria-hidden="true" style={{ position: "absolute", top: -13, left: "50%", transform: "translateX(-50%)", opacity: swipeOpacity, padding: "5px 14px", borderRadius: 999, background: "var(--surface-3)", color: swipeHint.color, fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600, boxShadow: "var(--ring-hairline-strong)", whiteSpace: "nowrap", pointerEvents: "none" }}>
              {swipeHint.label}
            </div>
          )}
          <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgb(var(--cream-rgb) / 0.4)" }}>
            {categoryTitle(card.category)}{card.edge ? " · talk first" : ""}
          </div>
          <div style={{ fontSize: 44, lineHeight: 1, marginTop: 14 }}>{card.emoji}</div>
          <div style={{ fontSize: 22, color: "var(--cream)", fontWeight: 600, marginTop: 12 }}>{card.label}</div>
          <div style={{ fontSize: 14, color: "rgb(var(--cream-rgb) / 0.6)", lineHeight: 1.5, marginTop: 6, maxWidth: "30ch", marginInline: "auto" }}>{card.desc}</div>
          {card.role && (
            <>
              <div style={{ marginTop: 20, fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "rgb(var(--cream-rgb) / 0.45)" }}>I want to</div>
              <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 8 }}>
                {(["give", "receive", "both"] as QuizRole[]).map((r) => {
                  const on = role === r;
                  return (
                    <button key={r} type="button" onClick={() => setRole(on ? "" : r)} aria-pressed={on}
                      style={{ padding: "7px 16px", borderRadius: 999, border: "none", fontSize: 13, cursor: "pointer", textTransform: "capitalize",
                        ...(on ? ACCENT_BTN : { background: "rgb(var(--cream-rgb) / 0.08)", color: "var(--cream)", boxShadow: "var(--ring-hairline)" }) }}>
                      {r}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      <p style={{ textAlign: "center", fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgb(var(--cream-rgb) / 0.35)" }}>
        Swipe ← pass · ↑ curious · into → — or tap
      </p>
      <div style={{ display: "flex", gap: 10 }}>
        <button type="button" className="pressable" aria-pressed={savedInterest === "pass"} onClick={() => rate("pass")}
          style={{ flex: 1, padding: 15, borderRadius: 18, border: "none", background: "rgb(var(--cream-rgb) / 0.07)", color: "rgb(var(--cream-rgb) / 0.7)", fontSize: 14, fontWeight: 500, boxShadow: savedInterest === "pass" ? "inset 0 0 0 2px var(--cream)" : "var(--ring-hairline)", opacity: savedInterest && savedInterest !== "pass" ? 0.5 : 1 }}>Pass</button>
        <button type="button" className="pressable" aria-pressed={savedInterest === "curious"} onClick={() => rate("curious")}
          style={{ flex: 1, padding: 15, borderRadius: 18, border: "none", background: "rgb(var(--cream-rgb) / 0.07)", color: "var(--cream)", fontSize: 14, fontWeight: 500, boxShadow: savedInterest === "curious" ? "inset 0 0 0 2px var(--cream)" : "var(--ring-hairline)", opacity: savedInterest && savedInterest !== "curious" ? 0.5 : 1 }}>Curious</button>
        <button type="button" className="pressable" aria-pressed={savedInterest === "into"} onClick={() => rate("into")}
          style={{ flex: 1.3, padding: 15, borderRadius: 18, border: "none", ...ACCENT_BTN, fontSize: 14, boxShadow: savedInterest === "into" ? "inset 0 0 0 2px var(--cream)" : ACCENT_BTN.boxShadow, opacity: savedInterest && savedInterest !== "into" ? 0.5 : 1 }}>Into it</button>
      </div>
    </div>
  );
}

// ---------- Waiting for partner ----------

function Waiting({ workspace, quiz, onUpdate }: { workspace: Workspace; quiz: SexQuizResponse; onUpdate: (next: SexQuizResponse) => void }) {
  const [showMine, setShowMine] = useState(false);
  const hasPicks = (quiz.myTopPicks?.length || 0) > 0;
  // Open the pinner by default when nothing's pinned yet — this is the step
  // people miss at the end of the quiz, so make it the first thing waiting here.
  const [editPicks, setEditPicks] = useState(!hasPicks);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "10px 22px", textAlign: "center", alignItems: "center", marginTop: 24 }}>
      <div style={{ fontSize: 40 }}>🔒</div>
      <p style={{ color: "var(--cream)", fontSize: 18, fontWeight: 600 }}>Your answers are locked in</p>
      <p style={{ color: "rgb(var(--cream-rgb) / 0.6)", fontSize: 15, lineHeight: 1.55, maxWidth: "32ch" }}>
        {quiz.partnerName || "Your partner"}&apos;s answers stay hidden until they finish too — but you can always look back at your own.
      </p>
      <button type="button" className="btn-ghost" onClick={() => setEditPicks((v) => !v)} aria-expanded={editPicks}>
        {hasPicks ? (editPicks ? "Done editing turn-ons" : "Edit my top turn-ons") : (editPicks ? "Hide" : "Pick my top turn-ons")}
      </button>
      {editPicks && <TopPicksEditor workspace={workspace} quiz={quiz} onUpdate={onUpdate} />}
      <button type="button" className="btn-ghost" onClick={() => setShowMine((v) => !v)} aria-expanded={showMine}>
        {showMine ? "Hide my answers" : "View my answers"}
      </button>
      {showMine && <MyAnswers quiz={quiz} />}
      <EdgePassToLimits workspace={workspace} quiz={quiz} />
      <button type="button" className="btn-ghost" style={{ marginTop: 8 }} onClick={() => { retakeSexQuiz(workspace.id).then(onUpdate).catch(() => {}); }}>
        Redo my answers
      </button>
    </div>
  );
}

// Pin / re-pin your top turn-ons after submitting, without re-rating the deck —
// the fix for "I never got to pick my top 5." Saves only this actor's picks via
// set_top_picks; ratings, status, and the reveal are untouched.
function TopPicksEditor({ workspace, quiz, onUpdate }: { workspace: Workspace; quiz: SexQuizResponse; onUpdate: (next: SexQuizResponse) => void }) {
  const intoCards = useMemo(
    () => Object.entries(quiz.myRatings)
      .filter(([, r]) => r.interest === "into")
      .map(([id]) => QUIZ_CARD_BY_ID[id])
      .filter((c): c is QuizCard => Boolean(c)),
    [quiz.myRatings],
  );
  const [picks, setPicks] = useState<string[]>(quiz.myTopPicks || []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const original = quiz.myTopPicks || [];
  const dirty = picks.length !== original.length || picks.some((id) => !original.includes(id));

  function toggle(id: string) {
    setSaved(false);
    setPicks((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < 5 ? [...prev, id] : prev));
  }
  async function save() {
    setSaving(true);
    try {
      onUpdate(await setSexQuizTopPicks({ workspaceId: workspace.id, topPicks: picks }));
      setSaved(true);
    } catch { /* best-effort; the chips just stay as-is on failure */ }
    finally { setSaving(false); }
  }

  if (intoCards.length === 0) {
    return (
      <p style={{ color: "rgb(var(--cream-rgb) / 0.55)", fontSize: 14, lineHeight: 1.5, maxWidth: "34ch" }}>
        You didn&apos;t mark anything &quot;Into it&quot; yet — redo the quiz to add some, then pin your favorites here.
      </p>
    );
  }
  return (
    <div style={{ width: "100%", textAlign: "left", display: "flex", flexDirection: "column", gap: 10, background: "var(--surface-2)", borderRadius: 18, boxShadow: "var(--ring-hairline-strong)", padding: "14px 16px" }}>
      <p className="eyebrow">Your top turn-ons</p>
      <p style={{ color: "rgb(var(--cream-rgb) / 0.6)", fontSize: 14, lineHeight: 1.5 }}>
        Tap up to 5 in order — first tap is your #1. The highlights {quiz.partnerName || "your partner"} sees first.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {intoCards.map((c) => {
          const rank = picks.indexOf(c.id);
          const on = rank >= 0;
          return (
            <button key={c.id} type="button" onClick={() => toggle(c.id)} aria-pressed={on}
              style={{ padding: "8px 13px", borderRadius: 999, border: "none", fontSize: 14, cursor: "pointer",
                ...(on ? ACCENT_BTN : { background: "rgb(var(--cream-rgb) / 0.08)", color: "var(--cream)", boxShadow: "var(--ring-hairline)" }) }}>
              {on ? <strong style={{ marginRight: 5 }}>{rank + 1}.</strong> : null}{c.emoji} {c.label}
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "rgb(var(--cream-rgb) / 0.45)" }}>{picks.length} / 5 pinned</span>
        <button type="button" className="pressable" disabled={saving || !dirty} onClick={save}
          style={{ ...ACCENT_BTN, padding: "9px 18px", borderRadius: 14, border: "none", fontSize: 14, marginLeft: "auto", opacity: saving || !dirty ? 0.5 : 1 }}>
          {saving ? "Saving…" : saved && !dirty ? "Saved ✓" : "Save"}
        </button>
      </div>
    </div>
  );
}

// Read-only view of your own answers — your pinned turn-ons plus how you rated
// every card. Available while waiting (and in the reveal) so you never have to
// retake just to remember what you said.
function MyAnswers({ quiz }: { quiz: SexQuizResponse }) {
  const rows = fullAnswerRows(quiz.myRatings);
  if (rows.length === 0) {
    return (
      <p style={{ color: "rgb(var(--cream-rgb) / 0.55)", fontSize: 14 }}>You didn&apos;t rate any cards.</p>
    );
  }
  return (
    <div style={{ width: "100%", textAlign: "left", display: "flex", flexDirection: "column", gap: 14 }}>
      <TopTurnOns name="Your" cardIds={quiz.myTopPicks} ranked />
      <section>
        <p className="eyebrow" style={{ color: "rgb(var(--cream-rgb) / 0.5)" }}>Your answers</p>
        <div style={{ marginTop: 6, background: "var(--surface-2)", borderRadius: 18, boxShadow: "var(--ring-hairline-strong)", padding: "4px 16px" }}>
          {rows.map(({ card, rating }) => (
            <div key={card.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--hairline)" }}>
              <span style={{ fontSize: 20, width: 24, textAlign: "center" }}>{card.emoji}</span>
              <span style={{ flex: 1, color: "var(--cream)", fontSize: 14 }}>{card.label}</span>
              <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: interestColor(rating.interest) }}>
                {interestLabel(rating.interest)}{rating.role ? ` · ${rating.role}` : ""}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------- Reveal ----------

function Reveal({ workspace, quiz, onUpdate }: { workspace: Workspace; quiz: SexQuizResponse; onUpdate: (next: SexQuizResponse) => void }) {
  const fits = quiz.matches.filter((m) => m.complementary).length;
  const partnerName = quiz.partnerName || "your partner";
  const [editPicks, setEditPicks] = useState(false);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, padding: "8px 22px 4px" }}>
      <div>
        <p className="eyebrow">Revealed</p>
        {quiz.syncScore !== null ? (
          <SyncScoreReveal score={quiz.syncScore} label="In sync" />
        ) : (
          <p style={{ fontSize: 24, color: "var(--cream)", fontWeight: 600, marginTop: 2 }}>You&apos;re in sync 🔥</p>
        )}
        <p style={{ fontSize: 15, color: "rgb(var(--cream-rgb) / 0.62)", lineHeight: 1.5, marginTop: 10 }}>
          You both lit up on <strong style={{ color: "var(--cream)" }}>{quiz.matches.length}</strong> of the same desires{fits > 0 ? <> — and <strong style={{ color: "var(--cream)" }}>{fits}</strong> are a perfect give/receive fit.</> : "."}
        </p>
      </div>

      <TopTurnOns name={partnerName} cardIds={quiz.partnerTopPicks} ranked caption={`What ${partnerName} craves most — with you.`} />

      {quiz.matches.length > 0 && (
        <section>
          <p className="eyebrow" style={{ color: "rgb(var(--cream-rgb) / 0.5)" }}>Matches · both into it · tap to propose</p>
          <div style={{ marginTop: 6, background: "var(--surface-2)", borderRadius: 18, boxShadow: "var(--ring-hairline-strong)", padding: "4px 16px" }}>
            {quiz.matches.map((m) => {
              const card = QUIZ_CARD_BY_ID[m.cardId];
              if (!card) return null;
              return (
                <Link key={m.cardId} href={proposeHref(card.label)} className="pressable" style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderBottom: "1px solid var(--hairline)", textDecoration: "none" }}>
                  <span style={{ fontSize: 22, width: 26, textAlign: "center" }}>{card.emoji}</span>
                  <span style={{ flex: 1, color: "var(--cream)", fontSize: 15 }}>{card.label}</span>
                  <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: m.complementary ? "var(--accent)" : "rgb(var(--cream-rgb) / 0.45)", textAlign: "right" }}>
                    {roleTag(m)}
                  </span>
                  <span aria-hidden="true" style={{ color: "rgb(var(--accent-rgb) / 0.8)", fontSize: 18, lineHeight: 1, marginLeft: 2 }}>›</span>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {quiz.curiousTogether.length > 0 && (
        <section>
          <p className="eyebrow" style={{ color: "rgb(var(--cream-rgb) / 0.5)" }}>Curious together · tap to propose</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            {quiz.curiousTogether.map(({ cardId }) => {
              const card = QUIZ_CARD_BY_ID[cardId];
              if (!card) return null;
              return <Link key={cardId} href={proposeHref(card.label)} className="pressable" style={{ padding: "7px 13px", borderRadius: 999, fontSize: 13, background: "rgb(var(--cream-rgb) / 0.07)", color: "var(--cream)", boxShadow: "var(--ring-hairline)", textDecoration: "none" }}>{card.emoji} {card.label}</Link>;
            })}
          </div>
        </section>
      )}

      <p style={{ fontSize: 12, color: "rgb(var(--cream-rgb) / 0.45)", lineHeight: 1.5 }}>
        🔒 Passes & limits stay private — never shown to {partnerName} as a "no".
      </p>

      {quiz.matches.length > 0 && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link href={`/ask?note=${encodeURIComponent(askNote(quiz))}`} className="pressable" style={{ ...ACCENT_BTN, flex: 1, padding: 14, borderRadius: 16, textAlign: "center", textDecoration: "none", fontSize: 14, minWidth: 180 }}>
            Turn a match into an Ask
          </Link>
        </div>
      )}

      {quiz.partnerRatings && (
        <section>
          <p className="eyebrow" style={{ color: "rgb(var(--cream-rgb) / 0.5)" }}>{partnerName}'s full answers</p>
          <div style={{ marginTop: 6, background: "var(--surface-2)", borderRadius: 18, boxShadow: "var(--ring-hairline-strong)", padding: "4px 16px" }}>
            {fullAnswerRows(quiz.partnerRatings).map(({ card, rating }) => (
              <div key={card.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--hairline)" }}>
                <span style={{ fontSize: 20, width: 24, textAlign: "center" }}>{card.emoji}</span>
                <span style={{ flex: 1, color: "var(--cream)", fontSize: 14 }}>{card.label}</span>
                <span style={{ fontSize: 11, fontFamily: "var(--mono)", color: interestColor(rating.interest) }}>
                  {interestLabel(rating.interest)}{rating.role ? ` · ${rating.role}` : ""}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <FullRevealToggle workspace={workspace} quiz={quiz} onUpdate={onUpdate} />

      <button type="button" className="btn-ghost" onClick={() => setEditPicks((v) => !v)} aria-expanded={editPicks}>
        {editPicks ? "Done editing turn-ons" : "Edit my top turn-ons"}
      </button>
      {editPicks && <TopPicksEditor workspace={workspace} quiz={quiz} onUpdate={onUpdate} />}

      <button type="button" className="btn-ghost" onClick={() => { retakeSexQuiz(workspace.id).then(onUpdate).catch(() => {}); }}>
        Retake the quiz
      </button>
    </div>
  );
}

function FullRevealToggle({ workspace, quiz, onUpdate }: { workspace: Workspace; quiz: SexQuizResponse; onUpdate: (next: SexQuizResponse) => void }) {
  const [busy, setBusy] = useState(false);
  async function toggle() {
    setBusy(true);
    try { onUpdate(await setSexQuizFullReveal({ workspaceId: workspace.id, on: !quiz.fullRevealMine })); }
    catch { /* best-effort; toggle simply stays put on failure */ }
    finally { setBusy(false); }
  }
  const both = quiz.fullRevealMine && quiz.fullRevealPartner;
  return (
    <div style={{ background: "var(--surface-2)", borderRadius: 16, boxShadow: "var(--ring-hairline)", padding: 14 }}>
      <p style={{ color: "var(--cream)", fontSize: 14, fontWeight: 500 }}>Open the full deck to each other?</p>
      <p style={{ color: "rgb(var(--cream-rgb) / 0.55)", fontSize: 13, lineHeight: 1.5, marginTop: 4 }}>
        {both ? "You're both open — every answer is visible above." : quiz.fullRevealMine ? `Waiting for ${quiz.partnerName || "your partner"} to opt in too.` : "Only if you both choose to — then you'll each see every rating, not just the matches."}
      </p>
      {!both && (
        <button type="button" className="pressable" disabled={busy} onClick={toggle}
          style={{ marginTop: 10, padding: "9px 14px", borderRadius: 999, border: "none", fontSize: 13,
            ...(quiz.fullRevealMine ? { background: "rgb(var(--cream-rgb) / 0.1)", color: "var(--cream)" } : ACCENT_BTN) }}>
          {quiz.fullRevealMine ? "You're in — undo" : "I'm open to it"}
        </button>
      )}
    </div>
  );
}

function EdgePassToLimits({ workspace, quiz }: { workspace: Workspace; quiz: SexQuizResponse }) {
  const edgePasses = useMemo(
    () => Object.entries(quiz.myRatings).filter(([id, r]) => r.interest === "pass" && QUIZ_CARD_BY_ID[id]?.edge).map(([id]) => id),
    [quiz.myRatings],
  );
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (edgePasses.length === 0 || done) return null;
  async function fileThem() {
    setBusy(true);
    setError("");
    try {
      for (const id of edgePasses) {
        const card = QUIZ_CARD_BY_ID[id];
        if (card) await createBoundary({ workspaceId: workspace.id, text: card.label, type: "Soft Limit" });
      }
      setDone(true);
    } catch {
      // createBoundary throws in a locked Room-Encryption workspace and on
      // network errors; some boundaries may already be saved (createBoundary
      // dedups, so a retry is safe).
      setError("Couldn't save them all. If Room Encryption is on, unlock it in Privacy, then try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center" }}>
      <button type="button" className="pressable" disabled={busy} onClick={fileThem}
        style={{ marginTop: 4, padding: "10px 16px", borderRadius: 999, border: "none", background: "rgb(var(--cream-rgb) / 0.08)", color: "var(--cream)", fontSize: 13, boxShadow: "var(--ring-hairline)" }}>
        {busy ? "Saving…" : `File ${edgePasses.length} hard-pass${edgePasses.length === 1 ? "" : "es"} as Limits`}
      </button>
      {error && <span style={{ color: "rgb(var(--no-rgb))", fontSize: 12, maxWidth: "32ch", textAlign: "center", lineHeight: 1.4 }}>{error}</span>}
    </div>
  );
}

function roleTag(m: { myRole: string; partnerRole: string; complementary: boolean }): string {
  if (m.complementary && m.myRole && m.partnerRole) {
    if (m.myRole === "both" && m.partnerRole === "both") return "✨ you both switch";
    const mine = m.myRole === "both" ? "give & receive" : m.myRole;
    const theirs = m.partnerRole === "both" ? "give & receive" : m.partnerRole;
    return `✨ you ${mine} · them ${theirs}`;
  }
  if (m.myRole && m.partnerRole && m.myRole === m.partnerRole) return `both ${m.myRole === "both" ? "switch" : m.myRole}`;
  return "both";
}

function askNote(quiz: SexQuizResponse): string {
  const top = quiz.matches.find((m) => m.complementary) || quiz.matches[0];
  const label = top ? QUIZ_CARD_BY_ID[top.cardId]?.label : "";
  return label ? `From our Sex Quiz: ${label}` : "From our Sex Quiz";
}

const INTEREST_ORDER: Record<string, number> = { into: 0, curious: 1, pass: 2 };

function fullAnswerRows(ratings: Record<string, SexQuizRating>): Array<{ card: QuizCard; rating: SexQuizRating }> {
  return Object.entries(ratings)
    .map(([id, rating]) => ({ card: QUIZ_CARD_BY_ID[id], rating }))
    .filter((row): row is { card: QuizCard; rating: SexQuizRating } => Boolean(row.card))
    .sort((a, b) => (INTEREST_ORDER[a.rating.interest] ?? 3) - (INTEREST_ORDER[b.rating.interest] ?? 3));
}

function interestLabel(interest: string): string {
  return interest === "into" ? "Into it" : interest === "curious" ? "Curious" : "Pass";
}

function interestColor(interest: string): string {
  if (interest === "into") return "var(--accent)";
  if (interest === "curious") return "rgb(var(--cream-rgb) / 0.6)";
  return "rgb(var(--cream-rgb) / 0.35)";
}
