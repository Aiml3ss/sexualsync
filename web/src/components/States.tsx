/**
 * Shared empty / loading / error states for the four primary screens.
 *
 * Per the brief:
 *  - Empty states are inviting, not aggressive. No sales pitch tone.
 *  - Loading is a skeleton, not a spinner.
 *  - Errors are short, plain-language, with a clear next action. Never blame
 *    the user. Never expose stack traces.
 */
import type { ReactNode } from "react";

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="state-card card mx-5 my-2 p-6 text-center">
      <h2 className="font-display text-lg text-ink">{title}</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="sync-skeleton-card">
      <div className="sync-skeleton-head">
        <span className="sync-skeleton-dot" />
        <div className="skeleton-shimmer sync-skeleton-title" />
      </div>
      <div className="skeleton-shimmer sync-skeleton-line is-wide" />
      <div className="skeleton-shimmer sync-skeleton-line" />
    </div>
  );
}

export function SkeletonList({ count = 3 }: { count?: number }) {
  return (
    <div className="sync-loader" role="status" aria-live="polite" aria-label="Loading">
      <div className="sync-loader-signal" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="sync-skeleton-list">
        {Array.from({ length: count }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}

export function ErrorState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="state-card card mx-5 my-2 p-6 text-center" role="alert" aria-live="assertive">
      <h2 className="font-display text-lg text-ink">{title}</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
