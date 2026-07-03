"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import BrandWordmark from "@/components/BrandWordmark";
import { useDeploymentConfig } from "@/lib/deployment-config";
import "./signin.css";

const PRESENTATION_URL = "/presentation.html";
const GITHUB_URL = "https://github.com/Aiml3ss/sexualsync";

// A few real screens, shown inline so the room is visible before anyone clicks
// through. Served from dist/ (copied alongside the presentation at build).
// Only screens the build copies to dist (via copyPresentationScreenshots, which
// scans presentation.html) — keep this list a subset of what the deck uses.
const SHOTS: { src: string; alt: string }[] = [
  { src: "/docs/screenshots/share/03-sexboard-home.png", alt: "The Sexboard — the room's home screen" },
  { src: "/docs/screenshots/share/05-ask-detail.png", alt: "An Ask, with acts, timing, and the reply" },
  { src: "/docs/screenshots/share/07-new-ask.png", alt: "Composing a new Ask" },
  { src: "/docs/screenshots/share/08-inspiration.png", alt: "Inspiration — kinks and fantasies before plans" },
  { src: "/docs/screenshots/share/13-pile-revealed.png", alt: "The Pile — only the overlap reveals" },
];

function reviewTokenFromParams(params: URLSearchParams): string {
  return (params.get("review") || params.get("token") || "").trim().slice(0, 256);
}

function privateSignInHref(params: URLSearchParams): string {
  const next = new URLSearchParams();
  const invite = (params.get("invite") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  const review = reviewTokenFromParams(params);
  if (invite) next.set("invite", invite);
  if (review) next.set("review", review);
  const query = next.toString();
  return query ? `/signin?${query}` : "/signin";
}

function GithubMark() {
  return (
    <svg className="pp-gh-mark" viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

export default function HomePage() {
  const router = useRouter();
  const { selfHost } = useDeploymentConfig();
  const [signInHref, setSignInHref] = useState("/signin");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const review = reviewTokenFromParams(params);
    if (review) {
      router.replace(`/review?token=${encodeURIComponent(review)}`);
      return;
    }
    queueMicrotask(() => setSignInHref(privateSignInHref(params)));
  }, [router]);

  return (
    <main className="signin signin-cl public-preview min-h-screen">
      <div className="cl-candle" aria-hidden="true" />
      <div className="cl-floor" aria-hidden="true" />
      <div className="cl-wave" aria-hidden="true">
        <svg viewBox="0 0 400 200" preserveAspectRatio="xMidYMid meet">
          <path d="M 0,100 C 50,30 130,30 200,100 C 270,170 350,170 400,100" />
          <path d="M 0,130 C 50,60 130,60 200,130 C 270,200 350,200 400,130" opacity="0.6" />
        </svg>
      </div>

      <BrandWordmark className="cl-wordmark" />

      <section className="public-preview-copy" aria-labelledby="public-preview-title">
        <p className="public-preview-kicker">{selfHost ? "Self-hosted" : "Private · yours to run"}</p>
        <h1 id="public-preview-title" className="cl-headline">
          <span className="quiet">Get Curious.</span>
          <br />
          <span className="glow">Get in Sync.</span>
        </h1>
        <p className="cl-sub">
          A private room for two — explore what you want, trade ideas and kinks, and turn a
          quiet curiosity into a clear ask. No feed, no profiles, no one else in the room.
        </p>
        {!selfHost && (
          <p className="cl-sub cl-sub-soft">
            There is no public sign-up. The whole thing is open source — <strong>run your own copy</strong>{" "}
            and your data never leaves your server.
          </p>
        )}
      </section>

      {!selfHost && (
        <section className="pp-shots" aria-label="A look inside the app">
          <div className="pp-shots-track">
            {SHOTS.map((shot) => (
              <figure className="pp-shot" key={shot.src}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={shot.src} alt={shot.alt} loading="lazy" decoding="async" />
              </figure>
            ))}
          </div>
        </section>
      )}

      <div className="cl-actions public-preview-actions">
        {selfHost ? (
          <a className="pa-cta pressable public-preview-primary" href={signInHref}>
            Create account / sign in
          </a>
        ) : (
          <>
            <a className="pa-cta pressable public-preview-primary" href={PRESENTATION_URL}>
              See how it works
            </a>
            <a
              className="pp-github pressable"
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
            >
              <GithubMark />
              <span>Self-host it — get the code</span>
            </a>
            <a className="public-preview-signin" href={signInHref}>
              Private sign in
            </a>
          </>
        )}
        <p className="cl-foot public-preview-foot">
          <span>18+</span>
          <span className="sep">·</span>
          <a href="/privacy.html">Privacy</a>
          <span className="sep">·</span>
          <a href="/terms.html">Terms</a>
          <span className="sep">·</span>
          <a href="/report.html">Report</a>
          <span className="sep">·</span>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </p>
      </div>

      <div className="cl-grain" aria-hidden="true" />
      <div className="cl-vignette" aria-hidden="true" />
    </main>
  );
}
