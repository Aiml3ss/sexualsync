"use client";

import { useEffect, useState } from "react";

function msUntilNextLocalDay() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  return Math.max(1000, next.getTime() - now.getTime());
}

export function useDayRollover(): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let timeout: number | undefined;
    const bump = () => setTick((value) => value + 1);
    const schedule = () => {
      timeout = window.setTimeout(() => {
        bump();
        schedule();
      }, msUntilNextLocalDay());
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") bump();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timeout) window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return tick;
}
