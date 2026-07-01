"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import ScreenHeader from "@/components/ScreenHeader";
import { ErrorState, SkeletonList } from "@/components/States";
import {
  ApiUnauthorizedError,
  getBlindReveal,
  getGreenLights,
  getPile,
  getSexQuiz,
} from "@/lib/api";
import { getProfileCached } from "@/lib/profile-cache";
import { computeGreenLightsReveal } from "@/lib/green-lights-deck";
import { getCachedResource, setCachedResource, useColdStart } from "@/lib/resource-cache";
import type {
  AuthInfo,
  BlindReveal,
  GreenLightsResponse,
  PileView,
  ProfileResponse,
  SexQuizResponse,
  Workspace,
} from "@/lib/types";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unauthorized" }
  | { kind: "no-workspace"; auth: AuthInfo }
  | {
      kind: "ready";
      auth: AuthInfo;
      workspace: Workspace;
      pile: PileView | null;
      blindReveal: BlindReveal | null;
      quiz: SexQuizResponse | null;
      greenLights: GreenLightsResponse | null;
    };

export default function GamesPage() {
  const [state, setState] = useState<LoadState>(() => getCachedResource<LoadState>("games") ?? { kind: "loading" });
  useColdStart("games", setState);
  useEffect(() => { if (state.kind === "ready") setCachedResource("games", state); }, [state]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const profile: ProfileResponse = await getProfileCached();
        if (cancelled) return;
        if (!profile.activeWorkspace) {
          setState({ kind: "no-workspace", auth: profile.auth });
          return;
        }
        const [pile, reveal, quiz, greenLights] = await Promise.all([
          getPile(profile.activeWorkspace.id),
          getBlindReveal(profile.activeWorkspace.id),
          getSexQuiz(profile.activeWorkspace.id).catch(() => null),
          getGreenLights(profile.activeWorkspace.id).catch(() => null),
        ]);
        if (cancelled) return;
        setState({
          kind: "ready",
          auth: profile.auth,
          workspace: profile.activeWorkspace,
          pile: pile.pile,
          blindReveal: reveal.activeReveal,
          quiz,
          greenLights,
        });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiUnauthorizedError) {
          setState({ kind: "unauthorized" });
          return;
        }
        setState({ kind: "error", message: error instanceof Error ? error.message : "Couldn't load reveals." });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <AppShell>
      <ScreenHeader
        eyebrow="Reveals"
        showBrand={false}
        title="Nobody has to go first."
        subtitle="You each answer in private — only what you're both into comes back. Let the slut in you talk: no shame, no judgment, and nothing leaves this room unless you both want it."
      />
      <Body state={state} />
    </AppShell>
  );
}

function Body({ state }: { state: LoadState }) {
  if (state.kind === "loading") return <SkeletonList count={3} />;
  if (state.kind === "unauthorized") {
    return (
      <ErrorState
        title="Session expired"
        body="Sign in again to play."
        action={<Link href="/" className="btn-ghost">Back to sign-in</Link>}
      />
    );
  }
  if (state.kind === "error") {
    return <ErrorState title="Couldn't load Reveals" body={state.message} />;
  }
  if (state.kind === "no-workspace") {
    return (
      <ErrorState
        title="No partner space yet"
        body="You need a shared space with your partner before anything here can open."
        action={<Link href="/space" className="btn-ghost">Open Space</Link>}
      />
    );
  }

  const pile = state.pile;
  const reveal = state.blindReveal;

  return (
    <div className="games-stage">
      <div className="games-list">
        <GameTile
          href="/games/sex-quiz"
          tone="quiz"
          status={quizStatus(state.quiz)}
          statusActive={Boolean(state.quiz?.mySubmitted)}
          title="Sex Quiz"
          body="Rate every desire in private — the filthy ones especially. Your matches and top turn-ons open only once you've both finished."
          meta={quizMeta(state.quiz)}
          cta={state.quiz?.mySubmitted ? "Open" : "Start"}
        />
        <GameTile
          href="/games/green-lights"
          tone="greenlights"
          status={greenLightsStatus(state.greenLights)}
          statusActive={Boolean(state.greenLights?.mySubmitted)}
          title="Green Lights"
          body="Where you each stand on sex, autonomy, and limits. Answer in private; see what you're aligned on and what's worth a talk."
          meta={greenLightsMeta(state.greenLights)}
          cta={state.greenLights?.mySubmitted ? "Open" : "Start"}
        />
        <GameTile
          href="/games/pile"
          tone="pile"
          status={pileStatus(pile)}
          statusActive={pileStatusActive(pile)}
          title="The Pile"
          body="Both drop what you're craving, in private. Whatever you both want survives the reveal — everything else vanishes."
          meta={pileMeta(pile)}
          cta={pile ? "Continue" : "Start"}
        />
        <GameTile
          href="/games/blind-reveal"
          tone="reveal"
          status={blindStatus(reveal)}
          statusActive={blindStatusActive(reveal)}
          title="Blind Reveal"
          body="One question, two honest answers — neither opens till you've both locked in. Finally say the quiet part."
          meta={blindMeta(reveal)}
          cta={reveal ? "Open" : "Start"}
        />
      </div>
    </div>
  );
}

function quizStatus(quiz: SexQuizResponse | null) {
  if (!quiz || !quiz.mySubmitted) return "Idle";
  if (quiz.status === "revealed") return "Ready";
  return "Waiting";
}

function quizMeta(quiz: SexQuizResponse | null) {
  if (!quiz || !quiz.mySubmitted) return "Build your desire map";
  if (quiz.status === "revealed") return `${quiz.matches.length} matches open`;
  return "Waiting on your partner";
}

function greenLightsStatus(gl: GreenLightsResponse | null) {
  if (!gl || !gl.mySubmitted) return "Idle";
  if (gl.status === "revealed") return "Ready";
  return "Waiting";
}

function greenLightsMeta(gl: GreenLightsResponse | null) {
  if (!gl || !gl.mySubmitted) return "Where you both stand";
  if (gl.status === "revealed") {
    const { talk } = computeGreenLightsReveal(gl.myAnswers || {}, gl.partnerAnswers || {});
    return `${talk.length} to talk through`;
  }
  return "Waiting on your partner";
}

function GameTile({
  href,
  tone,
  status,
  statusActive,
  title,
  body,
  meta,
  cta,
}: {
  href: string;
  tone: "pile" | "reveal" | "quiz" | "greenlights";
  status: string;
  statusActive: boolean;
  title: string;
  body: string;
  meta: string;
  cta: string;
}) {
  return (
    <Link href={href} className={`game-tile game-${tone} pressable`}>
      <div className={`game-art game-art-${tone}`} aria-hidden="true">
        {tone === "pile" ? (
          <>
            <span className="pile-glow" />
            <span className="pile-card pile-card-3" />
            <span className="pile-card pile-card-1" />
            <span className="pile-card pile-card-2">
              <span className="pile-card-pip" />
            </span>
          </>
        ) : tone === "quiz" ? (
          <svg className="quiz-art-svg" viewBox="0 0 200 110" fill="none">
            <defs>
              <radialGradient id="quizGrad" cx="50%" cy="42%" r="62%">
                <stop className="quiz-grad-a" offset="0%" />
                <stop className="quiz-grad-b" offset="100%" />
              </radialGradient>
            </defs>
            <path
              className="quiz-heart-fill"
              fill="url(#quizGrad)"
              d="M100 88 C 74 68 60 55 60 42 C 60 32 69 26 78 30 C 87 34 95 42 100 51 C 105 42 113 34 122 30 C 131 26 140 32 140 42 C 140 55 126 68 100 88 Z"
            />
            <path
              className="quiz-heart-line"
              pathLength={1}
              d="M100 88 C 74 68 60 55 60 42 C 60 32 69 26 78 30 C 87 34 95 42 100 51 C 105 42 113 34 122 30 C 131 26 140 32 140 42 C 140 55 126 68 100 88 Z"
            />
            <circle className="quiz-spark" cx="100" cy="55" r="3.4" />
            <g transform="translate(45 32)"><path className="quiz-sparkle s1" d="M0 -4.5 L1 -1 L4.5 0 L1 1 L0 4.5 L-1 1 L-4.5 0 L-1 -1 Z" /></g>
            <g transform="translate(158 30)"><path className="quiz-sparkle s2" d="M0 -3.6 L0.8 -0.8 L3.6 0 L0.8 0.8 L0 3.6 L-0.8 0.8 L-3.6 0 L-0.8 -0.8 Z" /></g>
            <g transform="translate(150 82)"><path className="quiz-sparkle s3" d="M0 -4 L0.9 -0.9 L4 0 L0.9 0.9 L0 4 L-0.9 0.9 L-4 0 L-0.9 -0.9 Z" /></g>
            <g transform="translate(48 80)"><path className="quiz-sparkle s4" d="M0 -3.2 L0.7 -0.7 L3.2 0 L0.7 0.7 L0 3.2 L-0.7 0.7 L-3.2 0 L-0.7 -0.7 Z" /></g>
          </svg>
        ) : tone === "greenlights" ? (
          <svg className="gl-art-svg" viewBox="0 0 200 110" fill="none">
            <circle className="gl-dot gl-red" cx="66" cy="55" r="11" />
            <circle className="gl-dot gl-amber" cx="100" cy="55" r="11" />
            <circle className="gl-halo" cx="138" cy="55" r="13" />
            <circle className="gl-dot gl-green" cx="138" cy="55" r="13" />
          </svg>
        ) : (
          <>
            <span className="reveal-half reveal-half-a">
              <span className="reveal-line rl-a" />
              <span className="reveal-line rl-b" />
              <span className="reveal-line rl-c" />
            </span>
            <span className="reveal-half reveal-half-b">
              <span className="reveal-line rr-a" />
              <span className="reveal-line rr-b" />
              <span className="reveal-line rr-c" />
            </span>
            <span className="reveal-seam" />
            <span className="reveal-pip" />
            <span className="reveal-pip-halo" />
          </>
        )}
      </div>
      <div className="game-body">
        <span className={`game-status ${statusActive ? "status-active" : "status-idle"}`}>
          {status}
        </span>
        <h2 className="game-title">{title}</h2>
        <p className="game-desc">{body}</p>
        <div className="game-foot">
          <span className="game-meta">{meta}</span>
          <span className="game-cta">{cta} →</span>
        </div>
      </div>
    </Link>
  );
}

function pileStatus(pile: PileView | null) {
  if (!pile) return "Idle";
  if (pile.isRevealed) return pile.overlap?.length ? "Ready · overlap found" : "Revealed";
  return "Active";
}

function pileStatusActive(pile: PileView | null) {
  return Boolean(pile && (!pile.isRevealed || pile.overlap?.length));
}

function pileMeta(pile: PileView | null) {
  if (!pile) return "No active pile";
  if (pile.isRevealed) return `${pile.overlap?.length || 0} overlaps`;
  return `Reveal ${shortRevealTime(pile.revealAt)}`;
}

function blindStatus(reveal: BlindReveal | null) {
  if (!reveal) return "Idle";
  if (reveal.status === "revealed") return "Ready";
  if (reveal.mySubmitted && reveal.partnerSubmitted) return "Opening";
  if (reveal.mySubmitted) return "Waiting";
  if (reveal.partnerSubmitted) return "Your turn";
  return "Active";
}

function blindStatusActive(reveal: BlindReveal | null) {
  return Boolean(reveal);
}

function blindMeta(reveal: BlindReveal | null) {
  if (!reveal) return "No active reveal";
  if (reveal.status === "revealed") return `${reveal.entries.length} answers open`;
  return `${reveal.submittedCount}/${reveal.requiredCount} locked in`;
}

function shortRevealTime(value: string) {
  if (!value) return "soon";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "soon";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
