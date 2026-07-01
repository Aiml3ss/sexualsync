"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import ScreenHeader from "@/components/ScreenHeader";
import { ErrorState, SkeletonList } from "@/components/States";
import {
  ApiUnauthorizedError,
  getProfile,
  updateWorkspaceAction,
} from "@/lib/api";
import { downloadWorkspaceData } from "@/lib/data-export";
import { prepareSignOut } from "@/lib/signout";
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
  | { kind: "ready"; auth: AuthInfo; profile: ProfileResponse; workspace: Workspace };

export default function MorePage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    setState({ kind: "loading" });
    try {
      const profile = await getProfile();
      if (!profile.activeWorkspace) {
        setState({ kind: "no-workspace", auth: profile.auth });
        return;
      }
      setState({ kind: "ready", auth: profile.auth, profile, workspace: profile.activeWorkspace });
    } catch (error) {
      if (error instanceof ApiUnauthorizedError) {
        setState({ kind: "unauthorized" });
        return;
      }
      setState({ kind: "error", message: error instanceof Error ? error.message : "Couldn't load account." });
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const profile = await getProfile();
        if (cancelled) return;
        if (!profile.activeWorkspace) {
          setState({ kind: "no-workspace", auth: profile.auth });
          return;
        }
        setState({ kind: "ready", auth: profile.auth, profile, workspace: profile.activeWorkspace });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiUnauthorizedError) {
          setState({ kind: "unauthorized" });
          return;
        }
        setState({ kind: "error", message: error instanceof Error ? error.message : "Couldn't load account." });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function downloadData() {
    if (state.kind !== "ready" || busy) return;
    setBusy("download");
    setMessage(null);
    try {
      await downloadWorkspaceData(state.profile, state.workspace);
      setMessage("Export prepared on this device.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Couldn't prepare export.");
    } finally {
      setBusy("");
    }
  }

  async function scheduleDeletion() {
    if (state.kind !== "ready" || busy) return;
    setBusy("delete");
    setMessage(null);
    try {
      await updateWorkspaceAction({
        workspaceId: state.workspace.id,
        action: "schedule_deletion",
        confirmation,
      });
      setMessage("Closing scheduled. Both partners get seven days to undo.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Couldn't schedule closing.");
    } finally {
      setBusy("");
    }
  }

  return (
    <AppShell hideTabBar>
      <ScreenHeader
        eyebrow={<Link href="/space" className="text-ink-3">‹ Space</Link>}
        title="Account and data"
        subtitle={state.kind === "ready" ? state.auth.email : undefined}
      />
      <Body
        state={state}
        busy={busy}
        message={message}
        confirmation={confirmation}
        onConfirmation={setConfirmation}
        onDownload={downloadData}
        onDelete={scheduleDeletion}
        onReload={load}
      />
    </AppShell>
  );
}

function Body({
  state,
  busy,
  message,
  confirmation,
  onConfirmation,
  onDownload,
  onDelete,
  onReload,
}: {
  state: LoadState;
  busy: string;
  message: string | null;
  confirmation: string;
  onConfirmation: (value: string) => void;
  onDownload: () => Promise<void>;
  onDelete: () => Promise<void>;
  onReload: () => Promise<void>;
}) {
  if (state.kind === "loading") return <SkeletonList count={3} />;
  if (state.kind === "unauthorized") {
    return (
      <ErrorState
        title="Session expired"
        body="Sign in again to manage your account."
        action={<Link href="/" className="btn-ghost">Back to sign-in</Link>}
      />
    );
  }
  if (state.kind === "error") {
    return (
      <ErrorState
        title="Couldn't load Account"
        body={state.message}
        action={<button type="button" className="btn-ghost" onClick={() => { void onReload(); }}>Try again</button>}
      />
    );
  }
  if (state.kind === "no-workspace") {
    return (
      <ErrorState
        title="No partner space yet"
        body="You're signed in, but no shared space is attached yet."
        action={<a className="btn-ghost" href="/api/auth/logout" onClick={prepareSignOut}>Sign out</a>}
      />
    );
  }

  const expected = state.workspace.displayName || state.workspace.name;
  const canDelete = confirmation === expected;

  return (
    <div className="settings-stage">
      <section className="settings-section">
        <p className="eyebrow">Data</p>
        <div className="settings-card">
          <button type="button" className="settings-link pressable" onClick={onDownload} disabled={Boolean(busy)}>
            <span>
              Download my data
              <span className="settings-link-sub">JSON export for this shared space and private notes</span>
            </span>
            <span className="settings-link-chev">{busy === "download" ? "..." : "→"}</span>
          </button>
        </div>
      </section>

      <section className="settings-section">
        <p className="eyebrow">Session</p>
        <div className="settings-card">
          <a className="settings-link pressable" href="/api/auth/logout" onClick={prepareSignOut}>
            <span>
              Sign out of this device
              <span className="settings-link-sub">Clears the Google session here</span>
            </span>
            <span className="settings-link-chev">→</span>
          </a>
        </div>
      </section>

      <section className="settings-section">
        <p className="eyebrow">Step away or end the space</p>
        <div className="settings-card settings-card-danger">
          <p className="settings-danger-title">Begin closing this space</p>
          <p className="settings-danger-body">
            Both partners are notified. You have <strong>7 days</strong> to undo before anything is removed.
          </p>
          <input
            className="input"
            value={confirmation}
            onChange={(event) => onConfirmation(event.target.value)}
            placeholder={`Type ${expected}`}
            aria-label="Type the space name to confirm closing"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="settings-danger-btn pressable"
            onClick={onDelete}
            disabled={!canDelete || Boolean(busy)}
          >
            {busy === "delete" ? "Scheduling..." : "Begin closing"}
          </button>
        </div>
      </section>

      {message && <p className="text-sm leading-relaxed text-ink-2">{message}</p>}
    </div>
  );
}
