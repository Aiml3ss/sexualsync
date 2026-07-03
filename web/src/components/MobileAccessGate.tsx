"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  getAccessBlockReason,
  getPwaEnvironment,
  type AccessBlockReason,
} from "@/lib/pwa-environment";
import {
  DEFAULT_DEPLOYMENT_CONFIG,
  DeploymentConfigContext,
  loadDeploymentConfig,
  readCachedDeploymentConfig,
  type DeploymentConfigState,
} from "@/lib/deployment-config";

// useLayoutEffect warns when the component is server-rendered; the gate is
// prerendered by the static export, so alias to useEffect off-window.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const GITHUB_URL = "https://github.com/Aiml3ss/sexualsync";

// A few real screens, shown inline so desktop visitors see the room before they
// reach for their phone. Served from dist/ (copied with the presentation deck).
const SHOTS: { src: string; alt: string }[] = [
  { src: "/docs/screenshots/share/03-sexboard-home.png", alt: "The Sexboard — the room's home screen" },
  { src: "/docs/screenshots/share/05-ask-detail.png", alt: "An Ask, with acts, timing, and the reply" },
  { src: "/docs/screenshots/share/07-new-ask.png", alt: "Composing a new Ask" },
  { src: "/docs/screenshots/share/08-inspiration.png", alt: "Inspiration — kinks and fantasies before plans" },
  { src: "/docs/screenshots/share/13-pile-revealed.png", alt: "The Pile — only the overlap reveals" },
];

function GithubMark() {
  return (
    <svg className="mobile-access-gh-mark" viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

type GateState =
  | { status: "checking" }
  | { status: "allowed" }
  | { status: "blocked"; reason: AccessBlockReason };

function evaluateAccess(): GateState {
  if (typeof window === "undefined") return { status: "checking" };
  const reason = getAccessBlockReason(getPwaEnvironment());
  if (reason) return { status: "blocked", reason };
  return { status: "allowed" };
}

function copyTextFor(reason: AccessBlockReason) {
  if (reason === "embedded") {
    return {
      eyebrow: "Open in browser",
      title: "Open Sexualsync in Safari or Chrome.",
      body: "You are inside an in-app browser. Open this same link in your phone browser, then add it to your Home Screen.",
    };
  }
  if (reason === "ios-browser") {
    return {
      eyebrow: "Safari required",
      title: "Use Safari to install on iPhone.",
      body: "iPhone can add Sexualsync to the Home Screen from Safari. Open this link in Safari, then use the Share menu.",
    };
  }
  return {
    eyebrow: "Mobile only",
    title: "Get Curious. Get in Sync.",
    description: "A private room for two — explore what you want, trade ideas and kinks, and turn a quiet curiosity into a clear ask. No feed, no profiles, no one else in the room.",
    body: "The app is built for a private mobile browser or a Home Screen install, so this is as far as desktop goes.",
    selfHost: "There is no public sign-up. The whole thing is open source — run your own copy and your data never leaves your server.",
  };
}

function MobileAccessPage({ reason }: { reason: AccessBlockReason }) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const wavesRef = useRef<SVGSVGElement | null>(null);
  const copy = copyTextFor(reason);
  // Show the app showcase on the desktop "mobile-only" state, not on the
  // in-app-browser / iOS-Safari install prompts (those are small + instructional).
  const showcase = reason !== "embedded" && reason !== "ios-browser";

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = reduceQuery.matches;
    let raf = 0;
    let tx = 0;
    let ty = 0;
    let cx = 0;
    let cy = 0;
    const settle = () => {
      tx = 0;
      ty = 0;
      cx = 0;
      cy = 0;
      stage.style.setProperty("--tx", "0");
      stage.style.setProperty("--ty", "0");
    };
    const onMotionChange = () => {
      reducedMotion = reduceQuery.matches;
      if (reducedMotion) settle();
    };
    // Demand-driven rAF: runs only while the eased values are chasing the
    // pointer, then idles (see RoomEncryptionGate for the same pattern). The
    // old loop ran every frame for the entire life of the access screen.
    const tick = () => {
      if (!reducedMotion) {
        cx += (tx - cx) * 0.06;
        cy += (ty - cy) * 0.06;
        stage.style.setProperty("--tx", cx.toFixed(3));
        stage.style.setProperty("--ty", cy.toFixed(3));
        if (Math.abs(tx - cx) + Math.abs(ty - cy) > 0.001) {
          raf = requestAnimationFrame(tick);
          return;
        }
      }
      raf = 0;
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
    const onMove = (event: PointerEvent) => {
      if (reducedMotion) return;
      const rect = stage.getBoundingClientRect();
      tx = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
      ty = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
      kick();
    };

    stage.addEventListener("pointermove", onMove);
    stage.addEventListener("pointerleave", settle);
    reduceQuery.addEventListener("change", onMotionChange);
    return () => {
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerleave", settle);
      reduceQuery.removeEventListener("change", onMotionChange);
      cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    wavesRef.current?.querySelectorAll<SVGPathElement>("path[data-wave]").forEach((path) => {
      path.style.setProperty("--L", String(path.getTotalLength()));
    });
  }, []);

  return (
    <main className="surface mobile-access-page signin-b min-h-screen">
      <div className="atmosphere" aria-hidden="true">
        <div className="atm-top" />
        <div className="atm-bottom" />
        <div className="grain" />
      </div>

      <section className="mobile-access-panel" aria-labelledby="mobile-access-title">
        <div className="signin-stage mobile-access-mark" ref={stageRef} aria-hidden="true">
          <div className="signin-tilt">
            <div className="signin-aura" />
            <div className="signin-bloom-2" />
            <div className="signin-bloom" />
            <svg
              ref={wavesRef}
              className="signin-svg"
              viewBox="0 0 360 280"
              preserveAspectRatio="xMidYMid meet"
              focusable="false"
            >
              <path data-wave className="signin-wave-back"
                d="M 30,110 C 80,40 130,40 180,110 C 230,180 280,180 330,110" />
              <path data-wave className="signin-wave"
                d="M 30,110 C 80,40 130,40 180,110 C 230,180 280,180 330,110" />
              <path className="signin-sweep"
                d="M 30,110 C 80,40 130,40 180,110 C 230,180 280,180 330,110" />

              <path data-wave className="signin-wave-back"
                d="M 30,170 C 80,100 130,100 180,170 C 230,240 280,240 330,170" />
              <path data-wave className="signin-wave"
                d="M 30,170 C 80,100 130,100 180,170 C 230,240 280,240 330,170" />
              <path className="signin-sweep"
                d="M 30,170 C 80,100 130,100 180,170 C 230,240 280,240 330,170" />

              <circle className="signin-spark a" cx="180" cy="76" r="2.0" />
              <circle className="signin-spark b" cx="106" cy="140" r="1.6" />
              <circle className="signin-spark c" cx="254" cy="200" r="1.6" />
            </svg>
          </div>
        </div>
        <div className="mobile-access-lead">
          <p className="mobile-access-eyebrow">{copy.eyebrow}</p>
          <h1 id="mobile-access-title">{copy.title}</h1>
          {"description" in copy && copy.description && (
            <p className="mobile-access-description">{copy.description}</p>
          )}
          <p className="mobile-access-body">{copy.body}</p>
          {"selfHost" in copy && copy.selfHost && (
            <p className="mobile-access-selfhost">{copy.selfHost}</p>
          )}

          <div className="mobile-access-actions">
            <a className="mobile-access-primary pressable" href="/presentation.html">
              View presentation
            </a>
            <a className="mobile-access-github pressable" href={GITHUB_URL} target="_blank" rel="noreferrer">
              <GithubMark />
              <span>Self-host it on GitHub</span>
            </a>
          </div>
        </div>

        {showcase && (
          <div className="mobile-access-shots" aria-label="A look inside the app">
            <div className="mobile-access-shots-track">
              {SHOTS.map((shot) => (
                <figure className="mobile-access-shot" key={shot.src}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={shot.src} alt={shot.alt} loading="lazy" decoding="async" />
                </figure>
              ))}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

export default function MobileAccessGate({ children }: { children: ReactNode }) {
  // Start in "checking" so SSR and first client paint agree, then evaluate
  // synchronously in the mount effect. The holding state is just a dark div
  // — the branded SplashScreen is reserved for the sign-in page's loading
  // state on PWA cold-launch, not for every gate remount (which would flash
  // the splash on in-app navigations).
  const [state, setState] = useState<GateState>({ status: "checking" });
  const [deployment, setDeployment] = useState<DeploymentConfigState>(DEFAULT_DEPLOYMENT_CONFIG);

  // Pre-paint hydration from the last-known config + a synchronous access
  // evaluation. Without this the whole app sat on a blank div until
  // /api/config answered — one full serial round-trip in front of every cold
  // start (the config values are deploy constants; the fetch below refreshes
  // them in the background). useLayoutEffect must not run during SSR, hence
  // the isomorphic alias.
  useIsomorphicLayoutEffect(() => {
    const cached = readCachedDeploymentConfig();
    if (cached) setDeployment(cached);
    setState(evaluateAccess());
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadDeploymentConfig(controller.signal)
      .then(setDeployment)
      .catch(() => setDeployment((current) => (current.ready ? current : { ...DEFAULT_DEPLOYMENT_CONFIG, ready: true })));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const apply = () => setState(evaluateAccess());
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
    return () => {
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
    };
  }, []);

  let content: ReactNode;
  if (!deployment.ready || state.status === "checking") {
    content = <div className="mobile-access-loading" aria-hidden="true" />;
  } else if (state.status === "blocked") {
    content = <MobileAccessPage reason={state.reason} />;
  } else {
    content = children;
  }

  return (
    <DeploymentConfigContext.Provider value={deployment}>
      {content}
    </DeploymentConfigContext.Provider>
  );
}
