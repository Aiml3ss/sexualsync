"use client";

import type { CSSProperties, ReactNode } from "react";
import { useInView } from "@/lib/use-in-view";

/**
 * Wraps content so it rises into view the first time it scrolls onto screen
 * (uses the `.reveal` / `.is-in-view` primitives in globals.css). Degrades to
 * visible if IntersectionObserver is unavailable, and to no-motion under
 * prefers-reduced-motion. Renders a plain block wrapper — drop it around an
 * item in a flex/grid/space-y list and the wrapper inherits the spacing.
 */
export default function Reveal({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const [ref, inView] = useInView<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={["reveal", inView ? "is-in-view" : "", className].filter(Boolean).join(" ")}
      style={style}
    >
      {children}
    </div>
  );
}
