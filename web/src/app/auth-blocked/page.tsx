"use client";

/**
 * Terminal page for installed PWAs whose session cookie keeps getting
 * rejected (Safari ITP, third-party cookie partitioning, hostile extension).
 *
 * `maybeReconnectStandalonePwa` in lib/api.ts routes here after more than
 * PWA_AUTO_GOOGLE_LOOP_CAP attempts in the rolling window so the user lands
 * on a page that explains what to do instead of redirect-looping forever.
 */

import Link from "next/link";
import { useEffect } from "react";
import { clearReconnectAttemptLog } from "@/lib/api";

export default function AuthBlockedPage() {
  useEffect(() => {
    // Manual recovery clears the loop counter so the next sign-in attempt
    // gets a fresh budget.
    clearReconnectAttemptLog();
  }, []);

  return (
    <main className="surface min-h-screen auth-blocked-stage">
      <section className="auth-blocked-card">
        <p className="auth-blocked-eyebrow">Sign-in stalled</p>
        <h1 className="auth-blocked-title">Something is blocking sign-in.</h1>
        <p className="auth-blocked-body">
          The app tried to reconnect a few times and the browser kept rejecting
          the session cookie. This is almost always Safari ITP, third-party
          cookie restrictions, or a hostile browser extension.
        </p>
        <div className="auth-blocked-actions">
          <Link className="btn-primary pressable" href="/api/auth/google?returnTo=%2Fsexboard">
            Try Google sign-in again
          </Link>
          <Link className="btn-ghost pressable" href="/">Back to start</Link>
        </div>
        <p className="auth-blocked-foot">
          Still stuck? Open the page in a regular browser tab, sign in there,
          then come back to the installed app. Check that cookies are allowed
          for this site.
        </p>
      </section>
    </main>
  );
}
