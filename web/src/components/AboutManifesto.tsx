"use client";

/**
 * "What we're about" — a tap-to-open manifesto on the Sexboard that states what
 * Sexualsync is for and how sex-positive it is: a private, zero-shame room where
 * your desire is yours, lower libido is fine, solo pleasure is healthy, and being
 * glad about your partner's pleasure is its own closeness. Native <dialog> (Esc +
 * backdrop close, like confirm-dialog), self-contained — drop it anywhere.
 */

import { useRef } from "react";

export default function AboutManifesto() {
  const ref = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        type="button"
        className="about-trigger pressable"
        onClick={() => ref.current?.showModal()}
      >
        What we&apos;re about
      </button>
      <dialog
        ref={ref}
        className="about-dialog"
        aria-label="What Sexualsync is about"
        onClick={(e) => { if (e.target === e.currentTarget) ref.current?.close(); }}
      >
        <div className="about-dialog-inner">
          <p className="eyebrow">The whole point</p>
          <h2 className="about-dialog-title">Want out loud. No shame.</h2>
          <p>
            Sexualsync is one private room for the two of you to want out loud —
            zero judgment, and nothing leaves unless you both want it to. It&apos;s
            where you finally say the things you&apos;ve kept quiet.
          </p>
          <p>
            Your desire is yours, and none of it is too much. Filthy or tender,
            loud or shy — letting the slut in you talk isn&apos;t something to
            apologize for here. It&apos;s the point. The braver you are about what
            turns you on, the better this works.
          </p>
          <p>
            And wanting less is just as okay as wanting more. Sex drives almost
            never match, a lower one isn&apos;t broken, and &ldquo;not
            tonight&rdquo; is never a verdict. No quotas — just honesty, at
            whatever volume is true for you.
          </p>
          <p>
            You own your own pleasure: getting yourself off, with or without porn,
            takes nothing from the two of you. And being genuinely glad your
            partner feels good — even when it isn&apos;t from you — is its own kind
            of closeness. That generosity, both ways, is what we&apos;re really
            building.
          </p>
          <p>
            Everything here is private, double-blind, and yours to take back. Go as
            far as you both want — and not one inch further.
          </p>
          <button
            type="button"
            className="btn-primary about-dialog-close"
            onClick={() => ref.current?.close()}
          >
            Got it
          </button>
        </div>
      </dialog>
    </>
  );
}
