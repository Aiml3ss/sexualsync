/**
 * Sticky primary action at the bottom of a screen. Per the brief: every
 * screen with a single primary action should pin it to the thumb zone.
 * Floats above the tab bar.
 */
import type { ReactNode } from "react";

export default function StickyAction({ children }: { children: ReactNode }) {
  return (
    <div className="sticky-action">
      <div className="sticky-action-inner">
        <div className="sticky-action-panel">
          {children}
        </div>
      </div>
    </div>
  );
}
