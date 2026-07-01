/**
 * Shared "Waiting on your partner" view, used on every room-dependent page
 * (sexboard, ask, mutual, games/pile, tonight) when the workspace exists but
 * the partner hasn't joined the claimable invite link yet.
 *
 * Renders inside the page's normal AppShell so the tab bar stays visible.
 * "Share the link" goes to /onboarding which surfaces the share UI.
 *
 * Visual mark mirrors the sexboard's RoomSyncMark stacked-wave so every
 * page that surfaces this state feels like the same room state.
 */

import Link from "next/link";
import type { Workspace } from "@/lib/types";

export default function WaitingForPartner({
  workspace,
  intent,
}: {
  workspace: Workspace;
  // What the user was trying to do — used to color the headline. E.g.
  // intent="Asking" → "Asking needs your partner here." Leave undefined for
  // the generic "Waiting on your partner." line.
  intent?: string;
}) {
  const displayName = workspace.displayName || workspace.name || "Your room";
  const headline = intent
    ? `${intent} needs your partner here.`
    : "Waiting on your partner.";
  return (
    <div className="sexboard-waiting-shell">
      <p className="eyebrow sexboard-waiting-eyebrow">Your room</p>
      <h2 className="sexboard-waiting-room">{displayName}</h2>
      <RoomSyncMark />
      <h3 className="sexboard-waiting-title">{headline}</h3>
      <p className="sexboard-waiting-body">
        Once they open your invite link and sign in, this comes alive. Until then, only you can see inside.
      </p>
      <div className="sexboard-waiting-actions">
        <Link href="/onboarding" className="btn-primary sexboard-waiting-cta">Share the link</Link>
        <Link href="/space" className="btn-ghost sexboard-waiting-secondary">Manage in Space</Link>
      </div>
    </div>
  );
}

function RoomSyncMark() {
  return (
    <div className="sexboard-waiting-orb" data-mode="waiting" aria-hidden="true">
      <svg className="sexboard-waiting-wave" viewBox="0 0 160 112" fill="none" focusable="false">
        <path
          className="sexboard-waiting-wave-back"
          pathLength={1}
          d="M 18 42 C 42 14 62 14 80 42 C 98 70 118 70 142 42"
        />
        <path
          className="sexboard-waiting-wave-line"
          pathLength={1}
          d="M 18 42 C 42 14 62 14 80 42 C 98 70 118 70 142 42"
        />
        <path
          className="sexboard-waiting-wave-sweep"
          pathLength={1}
          d="M 18 42 C 42 14 62 14 80 42 C 98 70 118 70 142 42"
        />
        <path
          className="sexboard-waiting-wave-back is-lower"
          pathLength={1}
          d="M 18 70 C 42 42 62 42 80 70 C 98 98 118 98 142 70"
        />
        <path
          className="sexboard-waiting-wave-line is-lower"
          pathLength={1}
          d="M 18 70 C 42 42 62 42 80 70 C 98 98 118 98 142 70"
        />
        <path
          className="sexboard-waiting-wave-sweep is-lower"
          pathLength={1}
          d="M 18 70 C 42 42 62 42 80 70 C 98 98 118 98 142 70"
        />
        <circle className="sexboard-waiting-spark a" cx="80" cy="24" r="1.8" />
        <circle className="sexboard-waiting-spark b" cx="41" cy="58" r="1.45" />
        <circle className="sexboard-waiting-spark c" cx="119" cy="87" r="1.45" />
      </svg>
    </div>
  );
}
