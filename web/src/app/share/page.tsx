"use client";

import { FormEvent, Suspense, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import AppShell from "@/components/AppShell";
import { EmptyState, ErrorState, SkeletonList } from "@/components/States";
import {
  ApiUnauthorizedError,
  getProfile,
  saveShelfItem,
} from "@/lib/api";
import type {
  AuthInfo,
  ProfileResponse,
  Workspace,
} from "@/lib/types";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unauthorized" }
  | { kind: "no-workspace"; auth: AuthInfo }
  | {
      kind: "ready";
      auth: AuthInfo;
      workspace: Workspace;
    };

export default function SharePage() {
  return (
    <Suspense fallback={<ShareShell><SkeletonList count={2} /></ShareShell>}>
      <SharePageInner />
    </Suspense>
  );
}

function SharePageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [returnTo, setReturnTo] = useState("/share");
  const shareKey = searchParams.toString();

  useEffect(() => {
    // Sync the title/content draft from the Web Share Target query params each
    // time the URL changes. The form is editable, so we keep these as state
    // (not derived) — the effect just seeds them on arrival/refresh.
    const sharedTitle = cleanShareText(searchParams.get("title"), 180);
    const sharedText = cleanShareText(searchParams.get("text"), 1200);
    const sharedUrl = cleanShareText(searchParams.get("url"), 1000);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTitle(sharedTitle);
    setContent(sharedUrl || sharedText);
  }, [searchParams, shareKey]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      // Hydration-safe: server can't read window.location.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setReturnTo(`${window.location.pathname}${window.location.search}`);
    }

    let cancelled = false;
    (async () => {
      try {
        const profile: ProfileResponse = await getProfile();
        if (cancelled) return;
        if (!profile.activeWorkspace) {
          setState({ kind: "no-workspace", auth: profile.auth });
          return;
        }
        setState({ kind: "ready", auth: profile.auth, workspace: profile.activeWorkspace });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiUnauthorizedError) {
          setState({ kind: "unauthorized" });
          return;
        }
        setState({ kind: "error", message: error instanceof Error ? error.message : "Something went sideways." });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (state.kind !== "ready" || saving || !content.trim()) return;
    setSaving(true);
    setSaveError("");
    try {
      await saveShelfItem({
        workspaceId: state.workspace.id,
        content: content.trim(),
        title: title.trim(),
      });
      if (navigator.vibrate) navigator.vibrate([6, 16, 8]);
      router.replace("/inspiration/shelf?shared=1");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Couldn't save this.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ShareShell>
      {state.kind === "loading" && <SkeletonList count={2} />}
      {state.kind === "unauthorized" && (
        <ErrorState
          title="Session expired"
          body="Sign in again to save this."
          action={<Link href={`/api/auth/google?returnTo=${encodeURIComponent(returnTo)}`} className="btn-ghost">Sign in</Link>}
        />
      )}
      {state.kind === "no-workspace" && (
        <EmptyState
          title="Set up your space"
          body="You're signed in, but you don't have a partner-paired space yet."
          action={<Link href="/space" className="btn-ghost">Open Space</Link>}
        />
      )}
      {state.kind === "error" && <ErrorState title="Couldn't open Share" body={state.message} />}
      {state.kind === "ready" && (
        <div className="shelf-stage">
          <form className="shelf-compose-form shelf-compose-wide" onSubmit={submit}>
            <div className="shelf-compose-fields">
              <input
                className="input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Title"
                aria-label="Title"
                maxLength={180}
                autoCapitalize="sentences"
                autoCorrect="on"
                spellCheck
                inputMode="text"
              />
              <textarea
                className="input min-h-[132px] resize-none"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder="Paste a link or passage"
                aria-label="Link or passage"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="url"
              />
            </div>
            {saveError && <p className="text-sm" role="alert" aria-live="assertive" style={{ color: "rgb(var(--no-rgb))" }}>{saveError}</p>}
            <button type="submit" className="btn-primary shelf-save-btn" disabled={!content.trim() || saving}>
              {saving ? "Saving" : "Save to Shelf"}
            </button>
          </form>
        </div>
      )}
    </ShareShell>
  );
}

function ShareShell({ children }: { children: ReactNode }) {
  return (
    <AppShell hideTabBar>
      <header className="shelf-header">
        <div className="header-left">
          <span className="header-title">Save to Shelf</span>
        </div>
        <Link href="/inspiration/shelf" className="done-pill pressable">Done</Link>
      </header>
      {children}
    </AppShell>
  );
}

function cleanShareText(value: string | null, max: number) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}
