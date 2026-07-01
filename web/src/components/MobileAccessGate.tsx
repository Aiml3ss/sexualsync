"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
    description: "A private room for couples to explore what they want, share ideas and kinks, and turn curiosity into clear asks together.",
    body: "This app is designed for a private mobile browser or Home Screen install, not desktop browsing.",
  };
}

function MobileAccessPage({ reason }: { reason: AccessBlockReason }) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const wavesRef = useRef<SVGSVGElement | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const currentUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return window.location.href;
  }, []);
  const copy = copyTextFor(reason);

  async function copyLink() {
    if (!currentUrl) return;
    try {
      await navigator.clipboard.writeText(currentUrl);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2400);
    } catch {
      setCopyState("failed");
    }
  }

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
    const onMove = (event: PointerEvent) => {
      if (reducedMotion) return;
      const rect = stage.getBoundingClientRect();
      tx = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
      ty = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
    };
    const tick = () => {
      if (!reducedMotion) {
        cx += (tx - cx) * 0.06;
        cy += (ty - cy) * 0.06;
        stage.style.setProperty("--tx", cx.toFixed(3));
        stage.style.setProperty("--ty", cy.toFixed(3));
      }
      raf = requestAnimationFrame(tick);
    };

    stage.addEventListener("pointermove", onMove);
    stage.addEventListener("pointerleave", settle);
    reduceQuery.addEventListener("change", onMotionChange);
    raf = requestAnimationFrame(tick);
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
        <p className="mobile-access-eyebrow">{copy.eyebrow}</p>
        <h1 id="mobile-access-title">{copy.title}</h1>
        {"description" in copy && copy.description && (
          <p className="mobile-access-description">{copy.description}</p>
        )}
        <p className="mobile-access-body">{copy.body}</p>

        <div className="mobile-access-actions">
          <a className="mobile-access-primary pressable" href="/presentation.html">
            View presentation
          </a>
          <button type="button" className="mobile-access-copy pressable" onClick={copyLink}>
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy unavailable" : "Copy app link"}
          </button>
        </div>
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
