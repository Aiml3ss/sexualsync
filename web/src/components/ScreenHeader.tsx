/**
 * Per-screen header. Editorial serif title, optional eyebrow line above it.
 * Generous spacing — the brief leans literary, not SaaS.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import BrandWordmark from "./BrandWordmark";

export default function ScreenHeader({
  eyebrow,
  showBrand = true,
  title,
  subtitle,
  trailing,
  backHref,
}: {
  eyebrow?: ReactNode;
  showBrand?: boolean;
  title?: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  // When set, a back chevron sits inline at the start of the eyebrow line,
  // linking here — so it stays visible without adding a whole row of height.
  backHref?: string;
}) {
  // No notch inset here — AppShell's .app-shell-main already insets for the
  // safe area. pt-6 is design spacing only; adding `safe-top` double-counts
  // the status bar and buries the title (see the sheet-header note in globals).
  return (
    <header className="px-5 pb-4 pt-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          {showBrand && <BrandWordmark className="mb-4" />}
          {(backHref || eyebrow) && (
            <div className="screen-eyebrow-row">
              {backHref && (
                <Link href={backHref} className="screen-back pressable" aria-label="Back">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Link>
              )}
              {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            </div>
          )}
          {title && (
            <h1 className="font-display italic text-display-lg leading-tight text-ink">
              {title}
            </h1>
          )}
          {subtitle && (
            <p className="mt-1 text-sm text-ink-2">{subtitle}</p>
          )}
        </div>
        {trailing}
      </div>
    </header>
  );
}
