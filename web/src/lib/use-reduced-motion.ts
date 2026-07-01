import { useEffect, useState } from "react";

/**
 * Tracks the user's `prefers-reduced-motion` setting, reactively.
 *
 * SSR-safe: starts `false`, resolves on mount, and updates if the OS setting
 * changes mid-session. Use this to skip JS-driven motion (the CSS layer already
 * gates its own animations via the media query — this is for motion decided in
 * JS, e.g. whether to fire an imperative effect).
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);

  return reduced;
}
