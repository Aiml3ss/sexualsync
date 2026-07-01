"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import ScreenHeader from "@/components/ScreenHeader";
import { EmptyState, ErrorState, SkeletonList } from "@/components/States";
import StickyAction from "@/components/StickyAction";
import { splitActLabel } from "@/lib/act-label";
import { combineBuiltInAndSavedActs } from "@/lib/built-in-acts";
import {
  ApiUnauthorizedError,
  createAct,
  deleteAct,
  getActs,
  updateAct,
} from "@/lib/api";
import { getProfileCached } from "@/lib/profile-cache";
import { invalidateResource } from "@/lib/resource-cache";
import type {
  Act,
  AuthInfo,
  Workspace,
} from "@/lib/types";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unauthorized" }
  | { kind: "no-workspace" }
  | { kind: "ready"; auth: AuthInfo; workspace: Workspace; acts: Act[] };

export default function ActsLibraryPage() {
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
        const actsRes = await getActs(profile.activeWorkspace.id);
        if (cancelled) return;
        setState({
          kind: "ready",
          auth: profile.auth,
          workspace: profile.activeWorkspace,
          acts: combineBuiltInAndSavedActs(actsRes.acts, profile.activeWorkspace.id),
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

  async function handleCreate(label: string) {
    if (state.kind !== "ready") return;
    const result = await createAct({
      workspaceId: state.workspace.id,
      label,
    });
    setState({ ...state, acts: combineBuiltInAndSavedActs(result.acts, state.workspace.id) });
    invalidateResource("ask");
    setComposerOpen(false);
  }

  async function handleUpdate(id: string, label: string) {
    if (state.kind !== "ready") return;
    const result = await updateAct({
      workspaceId: state.workspace.id,
      id,
      label,
    });
    setState({ ...state, acts: combineBuiltInAndSavedActs(result.acts, state.workspace.id) });
    invalidateResource("ask");
  }

  async function handleDelete(id: string) {
    if (state.kind !== "ready") return;
    const result = await deleteAct({
      workspaceId: state.workspace.id,
      id,
    });
    setState({ ...state, acts: combineBuiltInAndSavedActs(result.acts, state.workspace.id) });
    invalidateResource("ask");
  }

  return (
    <AppShell>
      <ScreenHeader
        eyebrow="Acts"
        showBrand={false}
        title="Your acts library"
        subtitle={subtitleFor(state)}
      />
      <Body
        state={state}
        composerOpen={composerOpen}
        onComposerOpen={() => setComposerOpen(true)}
        onComposerClose={() => setComposerOpen(false)}
        onCreate={handleCreate}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
      />
      {!composerOpen && state.kind === "ready" && (
        <StickyAction>
          <button
            type="button"
            onClick={() => setComposerOpen(true)}
            className="btn-primary w-full"
          >
            Add an Act
          </button>
        </StickyAction>
      )}
    </AppShell>
  );
}

function subtitleFor(state: LoadState) {
  if (state.kind !== "ready") return "Physical Acts that can become an Ask.";
  if (state.acts.length === 1) return "1 available Act. Add the real words you use.";
  return `${state.acts.length} available Acts. Keep them concrete and physical.`;
}

function Body({
  state,
  composerOpen,
  onComposerOpen,
  onComposerClose,
  onCreate,
  onUpdate,
  onDelete,
}: {
  state: LoadState;
  composerOpen: boolean;
  onComposerOpen: () => void;
  onComposerClose: () => void;
  onCreate: (label: string) => Promise<void>;
  onUpdate: (id: string, label: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (state.kind !== "ready") return [];
    const clean = query.trim().toLowerCase();
    if (!clean) return state.acts;
    return state.acts.filter((act) => (
      act.label.toLowerCase().includes(clean)
      || act.tags.some((tag) => tag.includes(clean))
    ));
  }, [query, state]);

  if (state.kind === "loading") return <SkeletonList count={4} />;
  if (state.kind === "unauthorized") {
    return (
      <ErrorState
        title="Session expired"
        body="Sign in again to manage your Acts."
        action={<Link href="/" className="btn-ghost">Back to sign-in</Link>}
      />
    );
  }
  if (state.kind === "no-workspace") {
    return (
      <ErrorState
        title="No partner space yet"
        body="Acts are scoped to a shared space."
        action={<Link href="/space" className="btn-ghost">Open Space</Link>}
      />
    );
  }
  if (state.kind === "error") {
    return <ErrorState title="Couldn't load" body={state.message} />;
  }

  return (
    <div className="act-library-stage">
      {composerOpen && (
        <ActLibraryComposer
          onCancel={onComposerClose}
          onSubmit={onCreate}
        />
      )}

      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search Acts"
        aria-label="Search Acts"
        className="input"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        inputMode="search"
      />

      {state.acts.length === 0 && !composerOpen && (
        <EmptyState
          title="No Acts yet."
          body="Add concrete physical things you might want to put in an Ask."
          action={<button onClick={onComposerOpen} className="btn-ghost">Add your first Act</button>}
        />
      )}

      {state.acts.length > 0 && filtered.length === 0 && (
        <EmptyState
          title="Nothing matches."
          body="Try a shorter word, or add the Act if it is missing."
        />
      )}

      {filtered.length > 0 && (
        <section className="act-library-box" aria-label="Acts library">
          <div className="act-library-box-head">
            <span className="eyebrow">Acts</span>
          </div>
          <ul className="act-library-grid">
            {filtered.map((act) => (
              <ActRow
                key={act.id}
                act={act}
                onUpdate={onUpdate}
                onDelete={onDelete}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ActRow({
  act,
  onUpdate,
  onDelete,
}: {
  act: Act;
  onUpdate: (id: string, label: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(act.label);
  const [busy, setBusy] = useState(false);
  const isBuiltIn = act.source === "built_in";

  async function save() {
    const clean = label.trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      await onUpdate(act.id, clean);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    if (busy) return;
    setBusy(true);
    try {
      await onDelete(act.id);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <li className="card p-4">
        <input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          className="input"
          maxLength={100}
          autoFocus
          autoCapitalize="none"
          autoCorrect="on"
          spellCheck
          inputMode="text"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={() => setEditing(false)} className="btn-ghost text-sm" disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={save} className="btn-primary text-sm" disabled={busy || !label.trim()}>
            Save
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="card act-library-row">
      <div className="act-library-copy">
        <p className="act-library-label">
          <ActLabel label={act.label} />
        </p>
      </div>
      {!isBuiltIn && (
        <div className="act-library-actions">
          <button
            type="button"
            onClick={() => { setLabel(act.label); setEditing(true); }}
            className="text-xs text-ink-3 underline-offset-4 hover:text-ink hover:underline"
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
    </li>
  );
}

function ActLabel({ label }: { label: string }) {
  const { emoji, text } = splitActLabel(label);
  return (
    <span className="act-label-inline">
      {emoji && <span className="act-label-emoji" aria-hidden="true">{emoji}</span>}
      <span className="act-label-text">{text}</span>
    </span>
  );
}

function ActLibraryComposer({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (label: string) => Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = label.trim();

  async function submit() {
    if (!clean || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(clean);
      setLabel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save this Act.");
      setBusy(false);
    }
  }

  return (
    <div className="card p-4">
      <p className="font-display text-base text-ink">New Act</p>
      <p className="mt-1 text-sm leading-relaxed text-ink-2">
        Keep it concrete: a thing someone can do, not a whole fantasy or Kink.
      </p>
      <input
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        placeholder="e.g. Slow undressing"
        aria-label="New Act"
        className="input mt-3"
        maxLength={80}
        autoFocus
        autoCapitalize="none"
        autoCorrect="on"
        spellCheck
        inputMode="text"
      />
      {error && <p className="mt-2 text-sm" style={{ color: "rgb(var(--no-rgb))" }}>{error}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn-ghost text-sm" disabled={busy}>
          Cancel
        </button>
        <button type="button" onClick={submit} className="btn-primary text-sm" disabled={busy || !clean}>
          {busy ? "Saving..." : "Add Act"}
        </button>
      </div>
    </div>
  );
}
