"use client";

/**
 * One-time post-accept welcome. Shown immediately after a user accepts a
 * claimable or email-bound invite. Dismissing it sets a per-workspace flag in
 * localStorage so we don't show it again for that room.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import ScreenHeader from "@/components/ScreenHeader";
import { ErrorState, SkeletonList } from "@/components/States";
import { ApiUnauthorizedError } from "@/lib/api";
import { getProfileCached } from "@/lib/profile-cache";
import "./welcome.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string }
  | { kind: "ready"; workspaceId: string; displayName: string };

const SEEN_PREFIX = "ss:welcome-seen:";

function seenKey(workspaceId: string) {
  return `${SEEN_PREFIX}${workspaceId}`;
}

function markSeen(workspaceId: string) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(seenKey(workspaceId), new Date().toISOString()); } catch {}
}

function hasSeen(workspaceId: string): boolean {
  if (typeof window === "undefined") return false;
  try { return Boolean(window.localStorage.getItem(seenKey(workspaceId))); } catch { return false; }
}

export default function WelcomePage() {
  const router = useRouter();
  // Router-ref pattern: avoid re-running the bootstrap effect on every render
  // if useRouter happens to return a fresh reference. See OnboardingPage for
  // the full reason — this fixes a fetch → setState → re-render → re-fetch
  // loop that visually looks like the page is refreshing.
  const routerRef = useRef(router);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const profile = await getProfileCached();
        if (cancelled) return;
        const workspace = profile.activeWorkspace;
        if (!workspace) {
          routerRef.current.replace("/onboarding");
          return;
        }
        if (hasSeen(workspace.id)) {
          routerRef.current.replace("/sexboard");
          return;
        }
        setState({
          kind: "ready",
          workspaceId: workspace.id,
          displayName: workspace.displayName || workspace.name || "Your room",
        });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiUnauthorizedError) {
          setState({ kind: "unauthorized" });
          return;
        }
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : "Couldn't load your welcome.",
        });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function dismiss(workspaceId: string) {
    markSeen(workspaceId);
    router.replace("/sexboard");
  }

  return (
    <AppShell hideTabBar>
      <ScreenHeader
        showBrand
        eyebrow="You're in"
        title={
          state.kind === "ready" ? (
            <>Welcome to <em>{state.displayName}</em>.</>
          ) : (
            "Welcome."
          )
        }
        subtitle="Here's how the room works."
      />
      <Body state={state} onDismiss={dismiss} />
    </AppShell>
  );
}

function Body({
  state,
  onDismiss,
}: {
  state: LoadState;
  onDismiss: (workspaceId: string) => void;
}) {
  if (state.kind === "loading") return <SkeletonList count={3} />;
  if (state.kind === "unauthorized") {
    return (
      <ErrorState
        title="Sign in to continue"
        body="You need to sign in to see your room."
        action={<Link href="/" className="btn-ghost">Back to sign-in</Link>}
      />
    );
  }
  if (state.kind === "error") {
    return <ErrorState title="Couldn't load" body={state.message} />;
  }

  return (
    <div className="welcome-stage">
      <ol className="welcome-list">
        <li>
          <span className="welcome-num">1</span>
          <div>
            <p className="welcome-step-title">Drop kinks in <strong>Ideas</strong></p>
            <p className="welcome-step-sub">Catch the spark before either of you has to commit.</p>
          </div>
        </li>
        <li>
          <span className="welcome-num">2</span>
          <div>
            <p className="welcome-step-title">Send a request in <strong>Ask</strong></p>
            <p className="welcome-step-sub">One clear ask. Accept, counter, or pass without the awkward pause.</p>
          </div>
        </li>
        <li>
          <span className="welcome-num">3</span>
          <div>
            <p className="welcome-step-title">See what&apos;s mutual on <strong>Sexboard</strong></p>
            <p className="welcome-step-sub">Active asks, locked answers, and the overlap that&apos;s ready to act on.</p>
          </div>
        </li>
        <li>
          <span className="welcome-num">4</span>
          <div>
            <p className="welcome-step-title">Set limits in <strong>Space</strong></p>
            <p className="welcome-step-sub">Limits, Acts, private notes, account controls.</p>
          </div>
        </li>
      </ol>

      <div
        style={{
          margin: "4px 0 4px",
          padding: "13px 15px",
          borderRadius: "12px",
          border: "1px solid var(--accent-fog)",
          background: "var(--accent-mist)",
        }}
      >
        <p className="welcome-step-title">One key step: the room passphrase</p>
        <p className="welcome-step-sub">
          Your room is end-to-end encrypted. Your partner will share a passphrase with you separately — keep it handy, you&apos;ll need it to unlock the room on each device.
        </p>
      </div>

      <button
        type="button"
        className="btn-primary welcome-cta"
        onClick={() => onDismiss(state.workspaceId)}
      >
        Open the room
      </button>
      <p className="welcome-foot">Revisit anytime &middot; Space &rsaquo; Tutorial</p>
    </div>
  );
}
