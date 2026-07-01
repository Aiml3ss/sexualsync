"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

// The reveal "moment": the sync % counts up from zero, the card blooms in, an
// accent glow blooms once behind it, the bar fills, and a soft two-beat haptic
// lands — the payoff screen shared by the Sex Quiz and Green Lights reveals.
// Honors prefers-reduced-motion (jumps straight to the final value, no motion).
export default function SyncScoreReveal({ score, label }: { score: number; label: string }) {
  const display = useCountUp(score, 1000);
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([8, 40, 16]);
  }, []);

  const fillStyle = { ["--sync-target"]: `${Math.max(0, Math.min(100, score))}%` } as CSSProperties;

  return (
    <div
      className="sync-score-reveal"
      style={{ marginTop: 8, background: "var(--surface-2)", borderRadius: 20, boxShadow: "var(--ring-hairline-strong)", padding: "18px 18px 16px", textAlign: "center", position: "relative", overflow: "hidden" }}
    >
      <div className="sync-score-glow" aria-hidden="true" />
      <div style={{ position: "relative", fontSize: 46, fontWeight: 700, color: "var(--cream)", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
        {display}<span style={{ fontSize: 22, color: "rgb(var(--cream-rgb) / 0.5)" }}>%</span>
      </div>
      <div style={{ position: "relative", fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "rgb(var(--accent-rgb) / 0.85)", marginTop: 4 }}>{label}</div>
      <div style={{ position: "relative", height: 6, borderRadius: 999, background: "rgb(var(--cream-rgb) / 0.1)", overflow: "hidden", marginTop: 12 }}>
        <div className="sync-score-fill" style={{ ...fillStyle, height: "100%", background: "linear-gradient(90deg, var(--accent), var(--accent-deep))", borderRadius: 999 }} />
      </div>
    </div>
  );
}

// Animate 0 → target once on mount with an easeOutCubic curve. Reduced-motion
// and non-positive targets short-circuit to the final value immediately.
function useCountUp(target: number, duration: number): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined") { setValue(target); return; }
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || target <= 0) { setValue(target); return; }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
      else setValue(target);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}
