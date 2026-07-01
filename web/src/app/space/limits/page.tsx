"use client";

/**
 * Limits — boundaries (brief screen 12).
 *
 * Behavior:
 *  - GET /api/profile + /api/boundaries.
 *  - Grouped by type (Hard No / Talk First / Soft Limit / Yes With Conditions).
 *  - Add (POST), edit (PATCH), delete (DELETE) inline.
 *  - Owner attribution + "updated" timestamp.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import ScreenHeader from "@/components/ScreenHeader";
import { EmptyState, ErrorState, SkeletonList } from "@/components/States";
import {
  ApiUnauthorizedError,
  createBoundary,
  deleteBoundary,
  getBoundaries,
  updateBoundary,
} from "@/lib/api";
import { getProfileCached } from "@/lib/profile-cache";
import type {
  AuthInfo,
  Boundary,
  BoundaryType,
  Workspace,
} from "@/lib/types";

const TYPES: { value: BoundaryType; label: string; helper: string }[] = [
  { value: "Hard No",              label: "Hard No",              helper: "Blocking. Never sent." },
  { value: "Talk First",           label: "Talk First",           helper: "Warn before sending." },
  { value: "Soft Limit",           label: "Soft Limit",           helper: "Possible, but flag." },
  { value: "Yes With Conditions",  label: "Yes With Conditions",  helper: "Green light with notes." },
];

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unauthorized" }
  | { kind: "no-workspace" }
  | { kind: "ready"; auth: AuthInfo; workspace: Workspace; boundaries: Boundary[] };

export default function LimitsPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [composerOpen, setComposerOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const profile = await getProfileCached();
        if (cancelled) return;
        if (!profile.activeWorkspace) {
          setState({ kind: "no-workspace" });
          return;
        }
        const boundariesRes = await getBoundaries(profile.activeWorkspace.id);
        if (cancelled) return;
        setState({
          kind: "ready",
          auth: profile.auth,
          workspace: profile.activeWorkspace,
          boundaries: boundariesRes.boundaries,
        });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiUnauthorizedError) {
          setState({ kind: "unauthorized" });
          return;
        }
        setState({ kind: "error", message: error instanceof Error ? error.message : "Couldn't load." });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleAdd(text: string, type: BoundaryType) {
    if (state.kind !== "ready") return;
    const result = await createBoundary({
      workspaceId: state.workspace.id,
      text,
      type,
    });
    setState({ ...state, boundaries: result.boundaries });
    setComposerOpen(false);
  }

  async function handleUpdate(id: string, text: string, type: BoundaryType) {
    if (state.kind !== "ready") return;
    const result = await updateBoundary({
      workspaceId: state.workspace.id,
      id,
      text,
      type,
    });
    setState({ ...state, boundaries: result.boundaries });
  }

  async function handleDelete(id: string) {
    if (state.kind !== "ready") return;
    const result = await deleteBoundary({
      workspaceId: state.workspace.id,
      id,
    });
    setState({ ...state, boundaries: result.boundaries });
  }

  return (
    <AppShell>
      <ScreenHeader
        eyebrow={<Link href="/space" className="text-ink-3">‹ Space</Link>}
        showBrand={false}
        title="Limits"
        subtitle="The shape of yes."
      />
      <Body
        state={state}
        composerOpen={composerOpen}
        onComposerOpen={() => setComposerOpen(true)}
        onComposerClose={() => setComposerOpen(false)}
        onAdd={handleAdd}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
      />
    </AppShell>
  );
}

// ---------- body ----------

function Body({
  state,
  composerOpen,
  onComposerOpen,
  onComposerClose,
  onAdd,
  onUpdate,
  onDelete,
}: {
  state: LoadState;
  composerOpen: boolean;
  onComposerOpen: () => void;
  onComposerClose: () => void;
  onAdd: (text: string, type: BoundaryType) => Promise<void>;
  onUpdate: (id: string, text: string, type: BoundaryType) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  if (state.kind === "loading") return <SkeletonList count={4} />;
  if (state.kind === "unauthorized") {
    return (
      <ErrorState
        title="Session expired"
        body="Sign in again to see your shared limits."
        action={<Link href="/" className="btn-ghost">Back to sign-in</Link>}
      />
    );
  }
  if (state.kind === "no-workspace") {
    return (
      <ErrorState
        title="No partner space yet"
        body="Limits are shared. You need a paired workspace."
        action={<Link href="/space" className="btn-ghost">Open Space</Link>}
      />
    );
  }
  if (state.kind === "error") {
    return <ErrorState title="Couldn't load" body={state.message} />;
  }

  const grouped: Record<BoundaryType, Boundary[]> = {
    "Hard No": [],
    "Talk First": [],
    "Soft Limit": [],
    "Yes With Conditions": [],
  };
  for (const b of state.boundaries) {
    if (grouped[b.type]) grouped[b.type].push(b);
  }
  const empty = state.boundaries.length === 0;

  return (
    <div className="space-y-4 px-5 pb-24">
      {composerOpen && (
        <Composer
          onCancel={onComposerClose}
          onSubmit={(text, type) => onAdd(text, type)}
        />
      )}

      {empty && !composerOpen && (
        <EmptyState
          title="No limits set yet."
          body="A short list keeps requests honest. Start with one thing that's a clear no, or one thing you'd want to talk about first."
          action={
            <button onClick={onComposerOpen} className="btn-ghost">Add your first limit</button>
          }
        />
      )}

      {TYPES.map(({ value, label, helper }) => {
        const items = grouped[value];
        if (!items?.length) return null;
        return (
          <section key={value}>
            <header className="mb-2 mt-2">
              <p className="eyebrow">{label}</p>
              <p className="text-xs text-ink-3">{helper}</p>
            </header>
            <ul className="space-y-2">
              {items.map((b) => (
                <BoundaryRow
                  key={b.id}
                  boundary={b}
                  me={state.auth}
                  onUpdate={onUpdate}
                  onDelete={onDelete}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

// ---------- rows ----------

function BoundaryRow({
  boundary,
  me,
  onUpdate,
  onDelete,
}: {
  boundary: Boundary;
  me: AuthInfo;
  onUpdate: (id: string, text: string, type: BoundaryType) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(boundary.text);
  const [type, setType] = useState<BoundaryType>(boundary.type);
  const [busy, setBusy] = useState(false);
  const mine = boundary.addedByEmail.toLowerCase() === me.email.toLowerCase();

  async function save() {
    if (!text.trim()) return;
    setBusy(true);
    try { await onUpdate(boundary.id, text.trim(), type); setEditing(false); }
    finally { setBusy(false); }
  }

  async function destroy() {
    setBusy(true);
    try { await onDelete(boundary.id); }
    finally { setBusy(false); }
  }

  if (editing) {
    return (
      <li className="card p-4">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="input"
          maxLength={160}
          autoFocus
        />
        <div className="mt-3 flex flex-wrap gap-1.5">
          {TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setType(t.value)}
              className={[
                "limit-type-chip",
                t.value === type ? "is-active" : "",
              ].join(" ")}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={() => setEditing(false)} className="btn-ghost text-sm" disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={save} className="btn-primary text-sm" disabled={busy}>
            Save
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[15px] leading-snug text-ink">{boundary.text}</p>
        {mine && (
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              onClick={() => { setText(boundary.text); setType(boundary.type); setEditing(true); }}
              className="text-xs text-ink-3 hover:text-ink underline-offset-4 hover:underline"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={destroy}
              disabled={busy}
              className="text-xs underline-offset-4 hover:underline"
              style={{ color: "rgb(var(--no-rgb))" }}
            >
              Delete
            </button>
          </div>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs text-ink-3">
        <span>by {boundary.addedByName || boundary.addedByEmail}</span>
        <span aria-hidden>·</span>
        <span>{relativeTime(boundary.updatedAt || boundary.createdAt)}</span>
      </div>
    </li>
  );
}

function Composer({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (text: string, type: BoundaryType) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [type, setType] = useState<BoundaryType>("Hard No");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text.trim(), type);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
      setBusy(false);
    }
  }

  return (
    <div className="card p-4">
      <p className="font-display text-base text-ink">New limit</p>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What do you want to put off-limits or flag?"
        aria-label="New limit"
        className="input mt-3"
        maxLength={160}
        autoFocus
      />
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        {TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setType(t.value)}
            className={[
              "rounded-xl border px-3 py-2 text-left text-xs transition",
              t.value === type
                ? "border-primary bg-primary/10 text-ink"
                : "border-line bg-surface text-ink-2 hover:bg-surface-2",
            ].join(" ")}
          >
            <span className="block text-sm text-ink">{t.label}</span>
            <span className="text-ink-3">{t.helper}</span>
          </button>
        ))}
      </div>
      {error && (
        <p className="mt-2 text-sm" style={{ color: "rgb(var(--no-rgb))" }}>{error}</p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn-ghost text-sm" disabled={busy}>
          Cancel
        </button>
        <button type="button" onClick={submit} className="btn-primary text-sm" disabled={busy || !text.trim()}>
          {busy ? "Saving..." : "Save limit"}
        </button>
      </div>
    </div>
  );
}

function relativeTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 60) return mins <= 1 ? "just now" : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
