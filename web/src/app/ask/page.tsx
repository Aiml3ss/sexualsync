"use client";

/**
 * Ask — the request builder (brief screen 7).
 *
 * Behavior:
 *  - Pulls /api/profile, /api/approved-acts (for the picker), /api/boundaries
 *    (for conflict checks).
 *  - Form: acts multi-select, timing, filming, optional note.
 *  - Inline boundary conflict warnings — hard-no blocks send; talk-first
 *    warns.
 *  - On submit, POST /api/request-board, then route to /sexboard.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import ScreenHeader from "@/components/ScreenHeader";
import WaitingForPartner from "@/components/WaitingForPartner";
import { combineBuiltInAndSavedActs } from "@/lib/built-in-acts";
import { ErrorState, SkeletonList } from "@/components/States";
import {
  ApiOfflineQueuedError,
  ApiUnauthorizedError,
  createAct,
  createRequest,
  getActs,
  getBoundaries,
  getFantasyBacklog,
} from "@/lib/api";
import { getProfileCached } from "@/lib/profile-cache";
import type {
  Act,
  Boundary,
  Filming,
  ProfileResponse,
  Timing,
  Workspace,
  AuthInfo,
  KinkIdea,
} from "@/lib/types";
import { splitActLabel } from "@/lib/act-label";
import { partnerOf } from "@/lib/workspace";
import { getCachedResource, invalidateResource, setCachedResource, useColdStart } from "@/lib/resource-cache";
import { fireSendPulse } from "@/lib/send-pulse";
import {
  hasUnlockedRoomE2eeKey,
  restoreRoomE2eeSession,
  setRoomE2eeEnabled,
} from "@/lib/room-crypto";

const TIMINGS: { value: Timing; label: string }[] = [
  { value: "Tonight",   label: "Tonight" },
  { value: "Mid-day",   label: "Mid-day" },
  { value: "Tomorrow",  label: "Tomorrow" },
  { value: "Next week", label: "Next week" },
];

const COLLAPSED_ACT_COUNT = 10;

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unauthorized" }
  | { kind: "no-workspace" }
  | {
      kind: "ready";
      auth: AuthInfo;
      workspace: Workspace;
      acts: Act[];
      boundaries: Boundary[];
      seededKink: KinkIdea | null;
      seededNote: string;
    };

export default function AskPage() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>(() => getCachedResource<LoadState>("ask") ?? { kind: "loading" });
  useColdStart("ask", setState);
  useEffect(() => { if (state.kind === "ready") setCachedResource("ask", state); }, [state]);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => {
    setState({ kind: "loading" });
    setReloadKey((value) => value + 1);
  };

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        // Only getProfileCached accepts an AbortSignal today. getActs /
        // getBoundaries / getFantasyBacklog don't take one, so they stay
        // guarded by the `cancelled` flag below.
        const profile: ProfileResponse = await getProfileCached({ signal: controller.signal });
        if (cancelled) return;
        if (!profile.activeWorkspace) {
          setState({ kind: "no-workspace" });
          return;
        }
        const [actsRes, boundariesRes] = await Promise.all([
          getActs(profile.activeWorkspace.id),
          getBoundaries(profile.activeWorkspace.id),
        ]);
        const query = new URLSearchParams(window.location.search);
        const kinkId = query.get("kink") || "";
        const seededNote = (query.get("note") || "").trim().slice(0, 1800);
        const seededKink = kinkId
          ? (await getFantasyBacklog(profile.activeWorkspace.id)).ideas.find((kink) => kink.id === kinkId) || null
          : null;
        if (cancelled) return;
        setState({
          kind: "ready",
          auth: profile.auth,
          workspace: profile.activeWorkspace,
          acts: combineBuiltInAndSavedActs(actsRes.acts, profile.activeWorkspace.id),
          boundaries: boundariesRes.boundaries,
          seededKink,
          seededNote,
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
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [reloadKey]);

  if (state.kind === "loading") {
    return (
      <AppShell>
        <ScreenHeader
          eyebrow="Ask"
          showBrand={false}
          title="Be specific."
          subtitle="What do you want?"
        />
        <SkeletonList count={4} />
      </AppShell>
    );
  }
  if (state.kind === "unauthorized") {
    return (
      <AppShell>
        <ScreenHeader
          eyebrow="Ask"
          showBrand={false}
          title="Be specific."
          subtitle="Sign in again to send a request."
        />
        <ErrorState
          title="Session expired"
          body="Sign in again to send a request."
          action={<Link href="/" className="btn-ghost">Back to sign-in</Link>}
        />
      </AppShell>
    );
  }
  if (state.kind === "no-workspace") {
    return (
      <AppShell>
        <ScreenHeader
          eyebrow="Ask"
          showBrand={false}
          title="Be specific."
          subtitle="You need a paired workspace before you can send an Ask."
        />
        <ErrorState
          title="No partner space yet"
          body="You need a paired workspace before you can send an Ask."
          action={<Link href="/space" className="btn-ghost">Open Space</Link>}
        />
      </AppShell>
    );
  }
  if (state.kind === "error") {
    return (
      <AppShell>
        <ScreenHeader
          eyebrow="Ask"
          showBrand={false}
          title="Be specific."
          subtitle="What do you want?"
        />
        <ErrorState
          title="Couldn't load"
          body={state.message}
          action={<button className="btn-ghost" onClick={reload}>Try again</button>}
        />
      </AppShell>
    );
  }
  // Workspace exists but partner hasn't joined the claimable invite yet —
  // render the shared waiting state instead of a broken AskForm with a
  // permanently disabled Send button.
  if (!hasJoinedPartner(state.workspace, state.auth.email)) {
    return (
      <AppShell>
        <ScreenHeader
          eyebrow="Ask"
          showBrand={false}
          title="Be specific."
          subtitle="One clear ask, no awkward pause."
        />
        <WaitingForPartner workspace={state.workspace} intent="Asking" />
      </AppShell>
    );
  }
  return <AskForm state={state} router={router} />;
}

function hasJoinedPartner(workspace: Workspace, myEmail: string): boolean {
  const me = (myEmail || "").toLowerCase();
  return (workspace.members || []).some((member) => {
    return member.status === "active" && (member.email || "").toLowerCase() !== me;
  });
}

// ---------- form ----------

function AskForm({
  state,
  router,
}: {
  state: Extract<LoadState, { kind: "ready" }>;
  router: ReturnType<typeof useRouter>;
}) {
  const partner = partnerOf(state.workspace, state.auth.email);
  const partnerFirst = partner?.displayName?.split(" ")[0] || "your partner";

  const [acts, setActs] = useState<Act[]>(state.acts);
  const [selectedActIds, setSelectedActIds] = useState<string[]>([]);
  const [actsExpanded, setActsExpanded] = useState(false);
  const [actSearch, setActSearch] = useState("");
  const [actComposerOpen, setActComposerOpen] = useState(false);
  const [timing, setTiming] = useState<Timing>("Tonight");
  const [filming, setFilming] = useState<Filming>("No");
  const [note, setNote] = useState<string>(
    state.seededNote || (state.seededKink ? `Inspired by: ${state.seededKink.text}` : ""),
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);

  useEffect(() => {
    const availableIds = new Set(state.acts.map((act) => act.id));
    setActs(state.acts);
    setSelectedActIds((prev) => prev.filter((id) => availableIds.has(id)));
  }, [state.acts]);

  const selectedActs = useMemo(
    () => acts.filter((act) => selectedActIds.includes(act.id)),
    [acts, selectedActIds],
  );

  const filteredActs = useMemo(() => {
    const query = actSearch.trim().toLowerCase();
    if (!query) return acts;
    return acts.filter((act) => act.label.toLowerCase().includes(query) || act.tags?.some((tag) => tag.includes(query)));
  }, [actSearch, acts]);

  const visibleActs = useMemo(() => {
    if (actsExpanded) return filteredActs;
    const selected = new Set(selectedActIds);
    const pinned = acts.filter((act) => selected.has(act.id));
    const starters = acts.filter((act) => !selected.has(act.id)).slice(0, COLLAPSED_ACT_COUNT);
    return [...pinned, ...starters];
  }, [acts, actsExpanded, filteredActs, selectedActIds]);

  const hiddenActCount = Math.max(0, acts.length - visibleActs.length);

  // Conflicts inline. Each boundary text gets normalized and compared with
  // the selected act labels by simple substring match — the same rough
  // heuristic the legacy SPA uses, kept here for parity.
  const conflicts = useMemo(() => {
    if (!selectedActIds.length) return { hard: [] as Boundary[], warn: [] as Boundary[] };
    const labels = acts
      .filter((a) => selectedActIds.includes(a.id))
      .map((a) => a.label.toLowerCase());
    const hard: Boundary[] = [];
    const warn: Boundary[] = [];
    for (const boundary of state.boundaries) {
      const text = boundary.text.toLowerCase();
      const matched = labels.some((label) => text.includes(label) || label.includes(text));
      if (!matched) continue;
      if (boundary.type === "Hard No") hard.push(boundary);
      else if (boundary.type === "Talk First" || boundary.type === "Soft Limit") warn.push(boundary);
    }
    return { hard, warn };
  }, [acts, selectedActIds, state.boundaries]);

  const canSubmit = selectedActIds.length > 0 && conflicts.hard.length === 0 && !!partner && !submitting;

  function toggleAct(id: string) {
    setSelectedActIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function surpriseMe() {
    const myEmail = state.auth.email.toLowerCase();
    const safe = acts
      .filter((a) => {
        const myComfort = a.comfort?.[myEmail];
        return myComfort === "favorite" || myComfort === "curious";
      })
      .map((a) => a.id);
    const pool = safe.length ? safe : acts.map((a) => a.id);
    // pick up to 2
    const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, 2);
    setSelectedActIds(shuffled);
  }

  async function handleCreateAct(label: string) {
    const result = await createAct({
      workspaceId: state.workspace.id,
      label,
      myComfort: "curious",
    });
    setActs(combineBuiltInAndSavedActs(result.acts, state.workspace.id));
    setSelectedActIds((prev) => (
      prev.includes(result.act.id) ? prev : [...prev, result.act.id]
    ));
    setActsExpanded(false);
    setActSearch("");
    setActComposerOpen(false);
    invalidateResource("ask");
    if (navigator.vibrate) navigator.vibrate(4);
  }

  async function submit(originEl?: HTMLElement) {
    if (!partner) return;
    const partnerName = partner.displayName?.split(" ")[0] || "your partner";
    const workspace = state.workspace;
    const requiresE2ee = Boolean(workspace.settings?.roomE2eeEnabled);
    setSubmitting(true);
    setSubmitError(null);
    setSubmitNotice(null);
    try {
      // Room Encryption: the server rejects a plaintext Ask in an E2EE room
      // (400 "Room Encryption requires encrypted Asks"), so the Ask must be
      // encrypted client-side — which needs the room key unlocked in this
      // session. The unlock gate normally guarantees that, but the in-memory
      // key can be dropped (full reload, background relock) without the gate
      // re-locking the view in time. Re-check here so we never post an Ask
      // that the server silently drops.
      if (requiresE2ee && !hasUnlockedRoomE2eeKey(workspace.id)) {
        const restored = await restoreRoomE2eeSession(workspace.id);
        if (!restored) {
          // Re-arm the gate: setting the local flag emits ss:room-e2ee-change,
          // which makes RoomEncryptionGate show the passphrase overlay.
          setRoomE2eeEnabled(workspace.id, true);
          setSubmitError("Unlock Room Encryption to send this Ask.");
          setSubmitting(false);
          return;
        }
      }

      const selected = acts.filter((a) => selectedActIds.includes(a.id));
      const categories = selected.map((a) => a.label);

      const result = await createRequest({
        workspaceId: state.workspace.id,
        requesterEmail: state.auth.email,
        reviewerEmail: partner.email,
        categories,
        timing,
        filming,
        note: note.trim(),
        boundaryConflicts: conflicts.warn.map((b) => b.text),
        seededFromKinkId: state.seededKink?.id,
      });
      const cachedSexboard = getCachedResource<{ kind: string; board?: unknown }>("sexboard");
      if (cachedSexboard?.kind === "ready") {
        setCachedResource("sexboard", {
          ...cachedSexboard,
          board: {
            ...(typeof cachedSexboard.board === "object" && cachedSexboard.board ? cachedSexboard.board : {}),
            workspaceId: state.workspace.id,
            requests: result.requests,
            activeRequests: result.activeRequests,
            history: result.history,
          },
        });
      }

      // Only celebrate once the Ask has actually landed. Firing the pulse +
      // "It's with X now" before the write resolved meant a rejected send
      // (e.g. Room Encryption locked → 400) still told the user it was sent,
      // while nothing reached the Sexboard. Await the pulse so the confirm
      // moment lands on this calm composer, then navigate — sending it over an
      // immediate route change made it flash and jump to the Sexboard mid-mount.
      await fireSendPulse(originEl, {
        confirm: {
          headline: `It's with ${partnerName} now.`,
          sub: "The Sexboard will update when they respond",
        },
      });
      router.push("/sexboard");
    } catch (error) {
      // Offline: the write was queued locally and will sync when the network
      // returns. Treat it like a success — neutral confirmation, then move on
      // to the Sexboard — instead of the red error treatment below.
      if (error instanceof ApiOfflineQueuedError) {
        setSubmitNotice("Saved — will send when you're back online.");
        router.push("/sexboard");
        return;
      }
      const message = error instanceof Error ? error.message : "";
      // Backstop: our local E2EE state read "off" or "unlocked" (e.g. a stale
      // profile), but the server — the authoritative shared setting — still
      // required encryption and rejected the plaintext Ask. Re-arm the gate so
      // the user can unlock, then resend, instead of stranding the Ask.
      if (/room encryption requires encrypted/i.test(message)) {
        setRoomE2eeEnabled(workspace.id, true);
        setSubmitError("Unlock Room Encryption, then send your Ask again.");
      } else {
        setSubmitError(message || "Couldn't send the request.");
      }
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <ScreenHeader
        eyebrow="Ask"
        showBrand={false}
        title="Be specific."
        subtitle={`What do you want to do to ${partnerFirst}? Pick the physical Acts. Your partner can approve, counter, or pass without the awkward pause.`}
      />
      <div className="ask-stage">
      <form
        className="ask-panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) {
            const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
            submit(submitter ?? e.currentTarget);
          }
        }}
      >
        {state.seededKink && (
          <p className="ask-seed">
            Inspired by <em>{state.seededKink.text}</em>. Pick the exact Acts before sending.
          </p>
        )}

        <section className="ask-section">
          {selectedActs.length > 0 && (
            <div className="selected-act-strip" aria-label="Selected Acts">
              {selectedActs.map((act) => (
                <button
                  key={act.id}
                  type="button"
                  onClick={() => toggleAct(act.id)}
                  className="selected-act-pill pressable"
                >
                  <ActLabel label={act.label} className="selected-act-label" />
                  <span aria-hidden="true">x</span>
                </button>
              ))}
            </div>
          )}

          {actsExpanded && (
            <input
              value={actSearch}
              onChange={(event) => setActSearch(event.target.value)}
              placeholder="Search Acts"
              className="input mb-3"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="search"
            />
          )}

          {acts.length === 0 ? (
            <button
              type="button"
              onClick={() => setActComposerOpen(true)}
              className="card p-4 text-left pressable"
            >
              <p className="text-sm text-ink-2">
                No Acts in the library yet. Tap to add your first one — it&apos;ll be saved for later.
              </p>
            </button>
          ) : (
            <div className="ask-act-grid">
              {visibleActs.map((act) => (
                <ActButton
                  key={act.id}
                  act={act}
                  selected={selectedActIds.includes(act.id)}
                  onClick={() => toggleAct(act.id)}
                />
              ))}
            </div>
          )}

          <div className="ask-act-actions">
            {acts.length > COLLAPSED_ACT_COUNT && (
              <button
                type="button"
                onClick={() => {
                  setActsExpanded((value) => !value);
                  setActSearch("");
                }}
                className="btn-ghost ask-act-action"
              >
                {actsExpanded ? "Collapse Acts" : `Show all ${acts.length} Acts`}
              </button>
            )}
            <button
              type="button"
              onClick={() => setActComposerOpen((value) => !value)}
              className="btn-ghost ask-act-action"
            >
              {actComposerOpen ? "Close" : "Add your own"}
            </button>
            {acts.length > 0 && (
              <button
                type="button"
                onClick={surpriseMe}
                className="btn-ghost ask-act-action ask-surprise-action"
              >
                Open to anything? Surprise me
              </button>
            )}
          </div>

          {!actsExpanded && hiddenActCount > 0 && (
            <p className="mt-2 text-xs text-ink-3">
              {hiddenActCount} more saved Acts are tucked away until you expand.
            </p>
          )}

          {actComposerOpen && (
            <ActComposer
              onCancel={() => setActComposerOpen(false)}
              onSubmit={handleCreateAct}
            />
          )}
        </section>

        {/* Conflict banners */}
        {conflicts.hard.length > 0 && (
          <div className="card border-no/40 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "rgb(var(--no-rgb))" }}>
              Hits a hard limit
            </p>
            <ul className="mt-2 space-y-1 text-sm" style={{ color: "rgb(var(--no-rgb))" }}>
              {conflicts.hard.map((b) => (
                <li key={b.id}>{b.text}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-2">
              You can&apos;t send this. Swap or remove the items above.
            </p>
          </div>
        )}
        {conflicts.warn.length > 0 && (
          <div className="card p-4" style={{ borderColor: "rgb(var(--gold-rgb) / 0.4)" }}>
            <p className="text-xs font-semibold uppercase tracking-wide text-gold">Worth a heads-up</p>
            <ul className="mt-2 space-y-1 text-sm text-ink-2">
              {conflicts.warn.map((b) => (
                <li key={b.id}>{b.text} <span className="text-ink-3">— {b.type}</span></li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-3">
              These touch existing limits. You can still send.
            </p>
          </div>
        )}

        <section className="ask-section">
          <SectionLabel title="Cadence" />
          <RadioRow
            options={TIMINGS}
            value={timing}
            onChange={(v) => setTiming(v as Timing)}
          />
          <button
            type="button"
            role="switch"
            aria-checked={filming === "Yes"}
            className={`filming-check ask-film-button pressable ${filming === "Yes" ? "is-on" : ""}`}
            onClick={() => setFilming((value) => value === "Yes" ? "No" : "Yes")}
          >
            <span>Filming OK</span>
          </button>
        </section>

        <section className="ask-section">
          <SectionLabel title="Note" hint="Optional" />
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="One line for your partner - vibe, timing, or a dare."
            rows={3}
            className="input note-field resize-none"
            maxLength={1800}
            autoCapitalize="none"
            autoCorrect="on"
            spellCheck
            inputMode="text"
          />
        </section>

        {submitNotice && (
          <p className="text-sm text-ink-2" role="status" aria-live="polite">{submitNotice}</p>
        )}
        {submitError && (
          <p className="text-sm" role="alert" aria-live="assertive" style={{ color: "rgb(var(--no-rgb))" }}>{submitError}</p>
        )}

        <div className="ask-submit-panel">
          <span className="ask-submit-hint">
            {selectedActIds.length ? `${selectedActIds.length} Act${selectedActIds.length === 1 ? "" : "s"} selected` : "Choose at least one Act"}
          </span>
          <button
            type="submit"
            disabled={!canSubmit}
            className="btn-primary ask-submit-button"
            data-testid="ask-submit"
          >
            {submitting ? "Sending..." : "Send to " + (partner?.displayName?.split(" ")[0] || "partner")}
          </button>
        </div>
      </form>
      </div>
    </AppShell>
  );
}

// ---------- pieces ----------

function SectionLabel({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex items-baseline justify-between">
      <h2 className="font-display text-base text-ink">{title}</h2>
      <div className="flex items-baseline gap-3">
        {hint && <span className="text-xs text-ink-3">{hint}</span>}
        {action}
      </div>
    </div>
  );
}

function RadioRow<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="cadence-grid">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={[
              "cadence-chip pressable",
              active ? "is-picked" : "",
            ].join(" ")}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function ActButton({
  act,
  selected,
  onClick,
}: {
  act: Act;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={[
        "act-chip pressable",
        selected ? "is-picked" : "",
      ].join(" ")}
    >
      <ActLabel label={act.label} className="act-chip-inner" />
    </button>
  );
}

function ActLabel({ label, className }: { label: string; className: string }) {
  const { emoji, text } = splitActLabel(label);
  return (
    <span className={className}>
      {emoji && <span className="act-label-emoji" aria-hidden="true">{emoji}</span>}
      <span className="act-chip-name">{text}</span>
    </span>
  );
}

function ActComposer({
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
    <div className="act-composer card p-4">
      <p className="font-display text-base text-ink">Add an Act</p>
      <p className="mt-1 text-sm leading-relaxed text-ink-2">
        Acts are physical things you do. Kinks stay in Inspiration.
      </p>
      <input
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        placeholder="e.g. Slow undressing"
        className="input mt-3"
        maxLength={80}
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
          {busy ? "Saving..." : "Add and select"}
        </button>
      </div>
    </div>
  );
}
