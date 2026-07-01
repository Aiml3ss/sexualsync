"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import BrandWordmark from "@/components/BrandWordmark";
import { useDeploymentConfig } from "@/lib/deployment-config";
import "./signin.css";

const PRESENTATION_URL = "/presentation.html";

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
        <p className="public-preview-kicker">{selfHost ? "Self-hosted" : "Private preview"}</p>
        <h1 id="public-preview-title" className="cl-headline">
          <span className="quiet">Get Curious.</span>
          <br />
          <span className="glow">Get in Sync.</span>
        </h1>
        <p className="cl-sub">
          A private room for couples to explore what they want, share ideas and kinks, and turn curiosity into clear asks together.
        </p>
      </section>

      <div className="cl-actions public-preview-actions">
        {selfHost ? (
          <a className="pa-cta pressable public-preview-primary" href={signInHref}>
            Create account / sign in
          </a>
        ) : (
          <>
            <a className="pa-cta pressable public-preview-primary" href={PRESENTATION_URL}>
              View presentation
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
        </p>
      </div>

      <div className="cl-grain" aria-hidden="true" />
      <div className="cl-vignette" aria-hidden="true" />
    </main>
  );
}
