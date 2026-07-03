"use client";

import { FormEvent, memo, useEffect, useRef, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import ScreenHeader from "@/components/ScreenHeader";
import { EmptyState, ErrorState, SkeletonList } from "@/components/States";
import {
  ApiUnauthorizedError,
  createKink,
  deleteKink,
  getBootstrap,
  getFantasyBacklog,
  getPrompt,
  restoreKink,
} from "@/lib/api";
import { getProfileCached } from "@/lib/profile-cache";
import { decryptFromString, encryptToString } from "@/lib/device-cipher";
import { getCachedResource, setCachedResource, useColdStart } from "@/lib/resource-cache";
import type {
  AuthInfo,
  FantasyBacklogResponse,
  KinkReaction,
  KinkIdea,
  ProfileResponse,
  Workspace,
} from "@/lib/types";
import { normalizeEmail, partnerOf } from "@/lib/workspace";
import { useLiveRoomReload } from "@/lib/use-live-room";
import { fireSendPulse } from "@/lib/send-pulse";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "unauthorized" }
  | { kind: "no-workspace"; auth: AuthInfo }
  | {
      kind: "ready";
      auth: AuthInfo;
      workspace: Workspace;
      backlog: FantasyBacklogResponse;
      promptText: string;
    };

const KINK_DRAFT_PREFIX = "ss:kink-composer-draft:";

function kinkDraftKey(workspaceId: string) {
  return `${KINK_DRAFT_PREFIX}${workspaceId}`;
}

// The in-progress kink draft is intimate free text. Encrypt it at rest with
// the device key (device-cipher) instead of leaving it plaintext in
// localStorage; read/write are async as a result.
async function readKinkDraft(workspaceId: string): Promise<string> {
  if (!workspaceId || typeof window === "undefined") return "";
  try {
    return await decryptFromString(window.localStorage.getItem(kinkDraftKey(workspaceId)));
  } catch {
    return "";
  }
}

async function writeKinkDraft(workspaceId: string, text: string): Promise<void> {
  if (!workspaceId || typeof window === "undefined") return;
  const key = kinkDraftKey(workspaceId);
  try {
    if (text.trim()) window.localStorage.setItem(key, await encryptToString(text));
    else window.localStorage.removeItem(key);
  } catch {}
}

export default function InspirationPage() {
  // Instant paint from the last snapshot on revisit; reload() revalidates.
  const [state, setState] = useState<LoadState>(() => getCachedResource<LoadState>("inspiration") ?? { kind: "loading" });
  useColdStart("inspiration", setState);

  async function reload(workspaceId?: string) {
    const profile: ProfileResponse = await getProfileCached();
    if (!profile.activeWorkspace) {
      setState({ kind: "no-workspace", auth: profile.auth });
      return;
    }
    const activeWorkspaceId = workspaceId || profile.activeWorkspace.id;
    // Backlog is fast. Render with the backlog + a fallback prompt
    // immediately, then upgrade the prompt asynchronously so the LLM cold
    // start (which can run 10-20s on a fresh workspace) never blocks paint.
    const backlog = await loadBacklog(activeWorkspaceId);
    const fallbackPrompt = FALLBACK_PROMPTS[Math.floor(Math.random() * FALLBACK_PROMPTS.length)];
    const ready: LoadState = {
      kind: "ready",
      auth: profile.auth,
      workspace: profile.activeWorkspace,
      backlog,
      promptText: fallbackPrompt,
    };
    setState(ready);
    setCachedResource("inspiration", ready);
    if (hasJoinedPartner(profile.activeWorkspace, profile.auth.email)) {
      void upgradePrompt(activeWorkspaceId);
    }
  }

  // Async prompt upgrade: fetch the real LLM prompt and swap it in once it
  // resolves. Keeps the page interactive while the network call is in flight.
  async function upgradePrompt(workspaceId: string) {
    try {
      const text = await loadPrompt(workspaceId);
      setState((current) => {
        if (current.kind !== "ready" || current.workspace.id !== workspaceId) return current;
        return { ...current, promptText: text };
      });
    } catch {
      // Fallback prompt is already on screen — silent failure is fine.
    }
  }

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const profile: ProfileResponse = await getProfileCached({ signal: controller.signal });
        if (cancelled) return;
        if (!profile.activeWorkspace) {
          setState({ kind: "no-workspace", auth: profile.auth });
          return;
        }
        // Render with backlog + fallback prompt FIRST, then upgrade to the
        // LLM-generated prompt in the background. Solo workspaces don't even
        // try the LLM (prompts assume two partners and the cold start is
        // wasted work). Paired workspaces upgrade silently after first paint.
        const backlog = await loadBacklog(profile.activeWorkspace.id, controller.signal);
        if (cancelled) return;
        const fallbackPrompt = FALLBACK_PROMPTS[Math.floor(Math.random() * FALLBACK_PROMPTS.length)];
        setState({
          kind: "ready",
          auth: profile.auth,
          workspace: profile.activeWorkspace,
          backlog,
          promptText: fallbackPrompt,
        });
        if (hasJoinedPartner(profile.activeWorkspace, profile.auth.email)) {
          void upgradePrompt(profile.activeWorkspace.id);
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiUnauthorizedError) {
          setState({ kind: "unauthorized" });
          return;
        }
        setState({ kind: "error", message: error instanceof Error ? error.message : "Something went sideways." });
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return (
    <AppShell>
      <ScreenHeader
        eyebrow="Inspiration"
        showBrand={false}
        title={(
          <>
            Find the spark.
            <br />
            Release the inner slut.
          </>
        )}
        subtitle="Where ideas live before they become acts. Get inspired below with porn, erotica, your own clips, then share kinks/fantasies, and see what lands with your partner."
      />
      <div className="insp-stage">
        <Body state={state} onReload={() => reload(state.kind === "ready" ? state.workspace.id : undefined)} />
      </div>
    </AppShell>
  );
}

async function loadBacklog(workspaceId: string, signal?: AbortSignal): Promise<FantasyBacklogResponse> {
  try {
    // getFantasyBacklog takes no signal; the effect's `cancelled` guard drops
    // any stale result. The fallback's getBootstrap does honor the signal.
    return await getFantasyBacklog(workspaceId);
  } catch {
    return loadBacklogFallback(workspaceId, signal);
  }
}

function hasJoinedPartner(workspace: Workspace, myEmail: string): boolean {
  const me = (myEmail || "").toLowerCase();
  return (workspace.members || []).some((member) => {
    return member.status === "active" && (member.email || "").toLowerCase() !== me;
  });
}

async function loadBacklogFallback(workspaceId: string, signal?: AbortSignal): Promise<FantasyBacklogResponse> {
  try {
    const bootstrap = await getBootstrap(signal);
    if (bootstrap.bootstrap?.workspaceId === workspaceId || bootstrap.activeWorkspaceId === workspaceId) {
      return bootstrap.bootstrap?.fantasy || emptyBacklog(workspaceId);
    }
  } catch {}
  return emptyBacklog(workspaceId);
}

function emptyBacklog(workspaceId: string): FantasyBacklogResponse {
  return { workspaceId, reactionCatalog: [], ideas: [], graveyard: [] };
}

async function loadPrompt(workspaceId: string) {
  try {
    const result = await getPrompt({ workspaceId, kind: "curiosity" });
    return result.text || FALLBACK_PROMPTS[Math.floor(Math.random() * FALLBACK_PROMPTS.length)];
  } catch {
    return FALLBACK_PROMPTS[Math.floor(Math.random() * FALLBACK_PROMPTS.length)];
  }
}

const FALLBACK_PROMPTS = [
  "Name the fantasy that would feel easier if they admitted one too.",
  "What want have you been editing in your head instead of saying plainly?",
  "Write the version of it that would make you feel relieved to be known.",
];

function Body({ state, onReload }: { state: LoadState; onReload: () => Promise<void> }) {
  if (state.kind === "loading") return <SkeletonList count={4} />;
  if (state.kind === "unauthorized") {
    return (
      <ErrorState
        title="Session expired"
        body="Sign in again to see Inspiration."
        action={<Link href="/" className="btn-ghost">Back to sign-in</Link>}
      />
    );
  }
  if (state.kind === "error") {
    return (
      <ErrorState
        title="Couldn't load Inspiration"
        body={state.message}
        action={<button className="btn-ghost" onClick={() => { onReload().catch(() => {}); }}>Try again</button>}
      />
    );
  }
  if (state.kind === "no-workspace") {
    return (
      <EmptyState
        title="Set up your space"
        body="You're signed in, but you don't have a partner-paired space yet."
        action={<Link href="/space" className="btn-ghost">Open Space</Link>}
      />
    );
  }
  return <InspirationReady state={state} onReload={onReload} />;
}

function InspirationReady({
  state,
  onReload,
}: {
  state: Extract<LoadState, { kind: "ready" }>;
  onReload: () => Promise<void>;
}) {
  const [openSharedKinks, setOpenSharedKinks] = useState(false);

  useLiveRoomReload({
    workspaceId: state.workspace.id,
    actorEmail: state.auth.email,
    resources: ["fantasy-backlog"],
    onReload,
  });

  useEffect(() => {
    function syncSharedKinkTarget() {
      const params = new URLSearchParams(window.location.search);
      setOpenSharedKinks(params.get("section") === "shared-kinks" || window.location.hash === "#shared-kinks");
    }

    syncSharedKinkTarget();
    window.addEventListener("hashchange", syncSharedKinkTarget);
    window.addEventListener("popstate", syncSharedKinkTarget);
    return () => {
      window.removeEventListener("hashchange", syncSharedKinkTarget);
      window.removeEventListener("popstate", syncSharedKinkTarget);
    };
  }, []);

  const partner = partnerOf(state.workspace, state.auth.email);
  const partnerName = partner?.displayName?.split(" ")[0] || "your partner";
  const kinks = state.backlog.ideas;

  return (
    <>
      <section className="insp-section">
        <InspirationLinks />
      </section>

      <section className="insp-section">
        <div className="insp-section-head">
          <p className="eyebrow">Kinks, fantasies &amp; confessions · <em>{state.backlog.ideas.length} shared</em></p>
          <span className="insp-link text-ink-3">{state.backlog.graveyard.length} archived</span>
        </div>
        <button
          type="button"
          className="weekly-prompt-card pressable"
          onClick={() => {
            const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            window.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" });
          }}
        >
          <span className="weekly-prompt-kicker">Today&apos;s prompt</span>
          <span className="weekly-prompt-text">{state.promptText}</span>
        </button>
        <KinkComposer workspaceId={state.workspace.id} partnerName={partnerName} onSaved={onReload} />
        <KinkLibrary kinks={kinks} auth={state.auth} workspace={state.workspace} openOnLoad={openSharedKinks} onReload={onReload} />
        {state.backlog.graveyard.length > 0 && (
          <details className="ideas-graveyard-v1">
            <summary>graveyard 😢 <span>{state.backlog.graveyard.length}</span></summary>
            <ul className="kink-list mt-3">
              {state.backlog.graveyard.map((kink) => (
                <ArchivedKinkCard
                  key={kink.id}
                  kink={kink}
                  workspaceId={state.workspace.id}
                  onReload={onReload}
                />
              ))}
            </ul>
          </details>
        )}
      </section>

    </>
  );
}

const KINK_LIBRARY_PAGE = 50;

function KinkLibrary({
  kinks,
  auth,
  workspace,
  openOnLoad,
  onReload,
}: {
  kinks: KinkIdea[];
  auth: AuthInfo;
  workspace: Workspace;
  openOnLoad: boolean;
  onReload: () => Promise<void>;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [archiving, setArchiving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [archiveError, setArchiveError] = useState("");
  // Page the card list: the server caps ideas at 300, and mounting 300
  // KinkCards (~7,500 DOM nodes) inside a CLOSED <details> cost every
  // Inspiration visit the full render + a 300-way entry animation on open.
  const [shownCount, setShownCount] = useState(KINK_LIBRARY_PAGE);

  const myEmail = normalizeEmail(auth.email);
  // Archiving is author-scoped, so only the user's own kinks are selectable —
  // which also matches "my kinks" and avoids per-item permission failures.
  const canArchive = (kink: KinkIdea) => normalizeEmail(kink.addedByEmail) === myEmail;
  const mineCount = kinks.reduce((n, kink) => (canArchive(kink) ? n + 1 : n), 0);

  useEffect(() => {
    if (!openOnLoad) return;
    // One-shot deep-link expand-and-scroll when the activity card lands here
    // with ?section=shared-kinks. Cannot run during render because it touches
    // window/document.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsOpen(true);
    window.requestAnimationFrame(() => {
      const panel = document.getElementById("shared-kinks");
      if (!panel) return;
      const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      panel.scrollIntoView({ block: "start", behavior: prefersReducedMotion ? "auto" : "smooth" });
    });
  }, [openOnLoad]);

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitSelect() {
    setSelectMode(false);
    setSelectedIds(new Set());
    setArchiveError("");
    setProgress(0);
  }

  async function archiveSelected() {
    if (archiving || selectedIds.size === 0) return;
    const ids = [...selectedIds];
    setArchiving(true);
    setArchiveError("");
    setProgress(0);
    let failed = 0;
    // Sequential on purpose: every archive does a CAS write to the same
    // per-workspace ideas/graveyard key, so firing them in parallel just
    // thrashes the version check. One at a time with a progress count.
    for (let i = 0; i < ids.length; i++) {
      try {
        await deleteKink({ workspaceId: workspace.id, id: ids[i] });
      } catch {
        failed += 1;
      }
      setProgress(i + 1);
    }
    if (navigator.vibrate) navigator.vibrate([6, 16, 8]);
    await onReload();
    setArchiving(false);
    if (failed) {
      setArchiveError(`${failed} couldn't be archived — try again.`);
      setSelectedIds(new Set());
    } else {
      exitSelect();
    }
  }

  if (!kinks.length) {
    return (
      <div className="card p-5">
        <p className="font-display text-display-sm italic leading-tight text-ink">No kinks yet.</p>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">
          The first one can be tiny. A phrase, a scene, a maybe.
        </p>
      </div>
    );
  }

  return (
    <details
      id="shared-kinks"
      className="kink-library-panel"
      open={isOpen || selectMode}
      onToggle={(event) => { if (!selectMode) setIsOpen(event.currentTarget.open); }}
    >
      <summary className="kink-library-summary pressable">
        <span className="kink-library-summary-copy">
          <span className="kink-library-kicker">Shared library</span>
          <span className="kink-library-title">Kinks, fantasies &amp; confessions</span>
        </span>
        <span className="kink-library-count">
          {kinks.length} shared
        </span>
      </summary>

      {mineCount > 0 && (
        <div className="kink-library-tools">
          {!selectMode ? (
            <button type="button" className="btn-ghost kink-select-start" onClick={() => setSelectMode(true)}>
              Select to archive
            </button>
          ) : (
            <>
              <div className="kink-bulk-bar">
                <span className="kink-bulk-count">{selectedIds.size} selected</span>
                <div className="kink-bulk-actions">
                  <button type="button" className="btn-ghost" onClick={exitSelect} disabled={archiving}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={archiveSelected}
                    disabled={selectedIds.size === 0 || archiving}
                  >
                    {archiving ? `Archiving ${progress}/${selectedIds.size}…` : `Archive${selectedIds.size ? ` ${selectedIds.size}` : ""}`}
                  </button>
                </div>
              </div>
              <p className="kink-bulk-hint">Tap your own kinks to select, then archive them all at once.</p>
            </>
          )}
          {archiveError && (
            <p className="text-sm" role="alert" aria-live="assertive" style={{ color: "rgb(var(--no-rgb))" }}>{archiveError}</p>
          )}
        </div>
      )}

      {/* Render the cards only while the panel is actually open — children of
          a closed <details> still cost the full React render + DOM. */}
      {(isOpen || selectMode) && (
        <>
          <ul className="kink-list kink-library-list">
            {kinks.slice(0, shownCount).map((kink) => (
              <KinkCard
                key={kink.id}
                kink={kink}
                auth={auth}
                workspace={workspace}
                selectable={selectMode && canArchive(kink)}
                selected={selectedIds.has(kink.id)}
                onToggleSelect={() => toggleSelect(kink.id)}
              />
            ))}
          </ul>
          {kinks.length > shownCount && (
            <div className="kink-library-more">
              <button
                type="button"
                className="chip pressable"
                onClick={() => setShownCount((count) => count + KINK_LIBRARY_PAGE)}
              >
                Show more ({kinks.length - shownCount} left)
              </button>
            </div>
          )}
        </>
      )}
    </details>
  );
}

type InspirationSource = {
  name: string;
  href: string;
  caption: string;
  internal?: boolean;
};

function InspirationLinks() {
  const groups: Array<{ label: string; links: InspirationSource[] }> = [
    {
      label: "Watch",
      links: [
        { name: "Bellesa", href: "https://www.bellesa.co/", caption: "porn for women, story-first" },
        { name: "RedGIFs", href: "https://www.redgifs.com/niches", caption: "short clips, browse by niche" },
      ],
    },
    {
      label: "Read",
      links: [
        { name: "Literotica", href: "https://www.literotica.com/", caption: "classic erotica catalog" },
        { name: "AO3", href: "https://archiveofourown.org/works/search?work_search%5Brating_ids%5D=13", caption: "fan-fiction, explicit filter" },
      ],
    },
    {
      label: "Yours",
      links: [
        { name: "Private Vault", href: "/space/vault", caption: "watch, clip, and share moments from videos you made together", internal: true },
      ],
    },
  ];

  return (
    <section className="inspiration-card inspiration-source-dock" aria-label="Inspiration links">
      <div className="inspiration-copy">
        <span className="eyebrow">Inspiration</span>
      </div>
      <div className="inspiration-actions-grid">
        {groups.map((group) => (
          <div className="inspiration-row" key={group.label}>
            <span className="inspiration-row-label">{group.label}</span>
            <div className="inspiration-row-links">
              {group.links.map((source) => (
                source.internal ? (
                  <Link key={source.name} className="inspiration-source-card pressable" href={source.href}>
                    <SourceCardContent source={source} />
                  </Link>
                ) : (
                  <a
                    key={source.name}
                    className="inspiration-source-card pressable"
                    href={source.href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <SourceCardContent source={source} />
                  </a>
                )
              ))}
            </div>
          </div>
        ))}
      </div>
      <Link href="/inspiration/shelf" className="btn-primary shelf-entry-link--block inspiration-shelf-link pressable">
        <span>Open The Shelf</span>
        <span aria-hidden="true">→</span>
      </Link>
    </section>
  );
}

function SourceCardContent({ source }: { source: InspirationSource }) {
  return (
    <>
      <span className="inspiration-source-name-row">
        <span className="inspiration-source-name">{source.name}</span>
        <span className="inspiration-source-icon" aria-hidden="true">{source.internal ? "→" : "↗"}</span>
      </span>
      <span className="inspiration-link-caption">{source.caption}</span>
    </>
  );
}

function KinkComposer({
  workspaceId,
  partnerName,
  onSaved,
}: {
  workspaceId: string;
  partnerName: string;
  onSaved: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const skipNextDraftWrite = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const templates = ["I keep thinking about ", "I want to try ", "What if we "];

  useEffect(() => {
    // Gate the write-effect's mount run synchronously (as before), then load the
    // encrypted draft async. The device-key derive can take ~200ms on first use,
    // so don't clobber anything the user has already started typing in that
    // window — only apply the saved draft into an empty field.
    skipNextDraftWrite.current = true;
    let cancelled = false;
    readKinkDraft(workspaceId).then((draft) => {
      if (cancelled || !draft) return;
      setText((current) => (current ? current : draft));
    });
    return () => { cancelled = true; };
  }, [workspaceId]);

  useEffect(() => {
    if (skipNextDraftWrite.current) {
      skipNextDraftWrite.current = false;
      return;
    }
    // Debounced: this used to AES-encrypt + synchronously setItem on every
    // keystroke. A trailing 500ms write keeps the draft durable without the
    // per-character main-thread hit; worst case on a hard close is losing
    // the final half-second of typing.
    const timer = window.setTimeout(() => { void writeKinkDraft(workspaceId, text); }, 500);
    return () => window.clearTimeout(timer);
  }, [text, workspaceId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const clean = text.trim();
    if (!clean || saving) return;
    // Capture the pulse target before the await — event.currentTarget is
    // nulled once React recycles the synthetic event.
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    const pulseTarget = submitter ?? (event.currentTarget as HTMLElement);
    setSaveError("");
    setSaving(true);
    try {
      // Await the write FIRST; only confirm (pulse + haptic + clear draft) once
      // it actually succeeds, so a failed send never fakes a confirmation.
      await createKink({ workspaceId, text: clean });
      fireSendPulse(pulseTarget);
      void writeKinkDraft(workspaceId, "");
      setText("");
      if (navigator.vibrate) navigator.vibrate([6, 16, 8]);
      await onSaved();
    } catch {
      // Leave the draft text in place so the user doesn't lose what they wrote.
      setSaveError("Couldn't share that yet. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="kink-compose-form kink-compose-obvious" onSubmit={submit}>
      <div className="kink-compose-obvious-head">
        <span className="kink-compose-kicker">Share with {partnerName}</span>
        <h2 className="kink-compose-title">Add a kink, fantasy, or confession</h2>
      </div>
      <textarea
        className="input min-h-[118px] resize-none"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={`Write that dirty thing you’ve always wanted to say to ${partnerName}`}
        aria-label="Add a kink, fantasy, or confession"
        autoCapitalize="none"
        autoCorrect="on"
        spellCheck
        inputMode="text"
      />
      <div className="kink-template-row" aria-label="Starter lines">
        {templates.map((template) => (
          <button
            key={template}
            type="button"
            className="kink-template-chip pressable"
            onClick={() => setText((current) => current || template)}
          >
            {template.trim()}
          </button>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <button type="submit" className="btn-primary flex-1" disabled={!text.trim() || saving}>
          {saving ? "Saving" : `Share with ${partnerName}`}
        </button>
      </div>
      {saveError && (
        <p className="text-sm mt-2" role="alert" aria-live="assertive" style={{ color: "rgb(var(--no-rgb))" }}>
          {saveError}
        </p>
      )}
    </form>
  );
}

// Memoized: KinkLibrary maps this over every shared idea, and the parent
// re-renders on each live room push / prompt upgrade. auth + workspace are
// stable state refs, so a card only needs to re-render when its own `kink`
// (or the archived flag) actually changes.
const KinkCard = memo(function KinkCard({
  kink,
  auth,
  workspace,
  archived = false,
  selectable = false,
  selected = false,
  onToggleSelect,
}: {
  kink: KinkIdea;
  auth?: AuthInfo;
  workspace?: Workspace;
  archived?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const counts = reactionCounts(kink);
  const signal = auth && workspace ? kinkSignal(kink, auth, workspace) : null;
  const cardClass = `kink-card ${signal ? `kink-card--${signal.state}` : ""} enter-rise`;
  const content = (
    <>
      {signal && <KinkSignal signal={signal} />}
      <div className="kink-meta-row">
        <span className="kink-author">
          {kink.addedByName || "Someone"} · <em>{archived ? "archived" : relativeAge(kink.createdAt)}</em>
        </span>
      </div>
      <p className="kink-body">{kink.text}</p>
      <div className="kink-footer">
        <div className="kink-reactions">
          {counts.length ? counts.map((reaction) => (
            <span key={reaction.key} className="kink-react">
              <span className="kink-react-emoji">{reaction.glyph}</span>
              <span className="kink-react-count">{reaction.count}</span>
            </span>
          )) : (
            <span className="kink-comments">No reactions yet</span>
          )}
        </div>
        <span className="kink-comments">
          {kink.comments.length ? `${kink.comments.length} ${kink.comments.length === 1 ? "comment" : "comments"}` : "No comments yet"}
        </span>
      </div>
    </>
  );

  if (selectable) {
    return (
      <li>
        <button
          type="button"
          className={`${cardClass} kink-card-selectable pressable block ${selected ? "is-selected" : ""}`}
          onClick={onToggleSelect}
          aria-pressed={selected}
        >
          <span className="kink-select-check" aria-hidden="true">{selected ? "✓" : ""}</span>
          {content}
        </button>
      </li>
    );
  }

  if (archived) {
    return (
      <li>
        <article className={`${cardClass} is-archived`}>{content}</article>
      </li>
    );
  }

  return (
    <li>
      <Link href={`/inspiration/kink?id=${encodeURIComponent(kink.id)}`} className={`${cardClass} pressable block`}>
        {content}
      </Link>
    </li>
  );
});

function ArchivedKinkCard({
  kink,
  workspaceId,
  onReload,
}: {
  kink: KinkIdea;
  workspaceId: string;
  onReload: () => Promise<void>;
}) {
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState("");

  async function restore() {
    if (restoring) return;
    setRestoreError("");
    setRestoring(true);
    try {
      await restoreKink({ workspaceId, id: kink.id });
      if (navigator.vibrate) navigator.vibrate([6, 16, 8]);
      await onReload();
    } catch {
      setRestoreError("Couldn't restore that. Try again.");
    } finally {
      setRestoring(false);
    }
  }

  return (
    <li>
      <article className="kink-card is-archived">
        <div className="kink-meta-row">
          <span className="kink-author">
            {kink.addedByName || "Someone"} · <em>archived</em>
          </span>
        </div>
        <p className="kink-body">{kink.text}</p>
        <button type="button" className="btn-ghost mt-3 w-full" onClick={restore} disabled={restoring}>
          {restoring ? "Restoring..." : "Restore"}
        </button>
        {restoreError && (
          <p className="text-sm mt-2" role="alert" aria-live="assertive" style={{ color: "rgb(var(--no-rgb))" }}>
            {restoreError}
          </p>
        )}
      </article>
    </li>
  );
}

function reactionCounts(kink: KinkIdea) {
  const byKey = new Map<string, { key: string; glyph: string; count: number; label: string }>();
  for (const response of Array.from(allKinkResponses(kink).values())) {
    const key = response.id || idForLabel(response.label);
    const existing = byKey.get(key);
    if (existing) existing.count += 1;
    else byKey.set(key, {
      key,
      glyph: response.glyph || glyphForLabel(response.label),
      label: response.label,
      count: 1,
    });
  }
  return Array.from(byKey.values());
}

type KinkResponse = {
  email: string;
  name: string;
  id: string;
  glyph: string;
  label: string;
  tone: "positive" | "pause" | "no";
};

type KinkSignalState = "answered" | "both-in" | "wants-details" | "waiting-on-them" | "needs-response" | "live-ask";

type KinkSignalInfo = {
  label: string;
  status: string;
  state: KinkSignalState;
  title: string;
  pulse?: boolean;
};

function KinkSignal({ signal }: { signal: KinkSignalInfo }) {
  return (
    <div className="idea-signal" data-state={signal.state} aria-label="Kink response tag">
      <span className={`idea-signal-pill ${signalClass(signal)} ${signal.pulse ? "has-wave" : ""}`} title={signal.title}>
        {signal.pulse && (
          <svg className="idea-signal-wave ss-breathe" viewBox="0 0 44 16" aria-hidden="true" focusable="false">
            <path d="M2 8 C7 2 14 2 22 8 C30 14 37 14 42 8" />
            <path d="M2 11 C7 5 14 5 22 11 C30 17 37 17 42 11" opacity="0.38" />
          </svg>
        )}
        <span className="idea-signal-text">{signal.label}</span>
      </span>
    </div>
  );
}

function signalClass(signal: KinkSignalInfo) {
  if (signal.label === "LIVE ASK") return "is-action";
  if (signal.label === "THEY WANT YOUR TAKE") return "is-needed";
  if (signal.label.startsWith("WAITING ON")) return "is-waiting";
  if (signal.status === "Commented") return "is-commented";
  if (signal.status === "Tell me more" || signal.status === "Curious") return "is-curious";
  if (signal.status === "Me too" || signal.status === "Hell yeah") return "is-hell-yeah";
  if (signal.status === "Give me a minute") return "is-later";
  return "is-no";
}

function kinkSignal(kink: KinkIdea, auth: AuthInfo, workspace: Workspace): KinkSignalInfo {
  const me = { email: auth.email, displayName: auth.person || "You" };
  const partner = partnerOf(workspace, auth.email);
  const partnerName = partner?.displayName?.split(" ")[0] || "Partner";
  const mine = normalizeEmail(kink.addedByEmail) === normalizeEmail(auth.email);
  const myResponse = responseForEmail(kink, auth.email);
  const partnerResponse = partner ? responseForEmail(kink, partner.email) : null;
  const myComment = latestCommentFrom(kink, auth.email);
  const partnerComment = partner ? latestCommentFrom(kink, partner.email) : null;

  if (hasLiveAsk(kink)) {
    return { label: "LIVE ASK", status: "", state: "live-ask", title: "Promoted into an Ask" };
  }

  if (mine) {
    if (partnerResponse) {
      const wantsDetails = wantsDetailsResponse(partnerResponse);
      return {
        label: signalLabelForResponse(partnerResponse),
        status: statusForResponse(partnerResponse),
        state: isMutualYesResponse(partnerResponse) ? "both-in" : wantsDetails ? "wants-details" : "answered",
        title: `${partnerName}: ${partnerResponse.label}`,
        pulse: wantsDetails,
      };
    }
    if (partnerComment) {
      return {
        label: `${partnerName.toUpperCase()} REPLIED`,
        status: "Commented",
        state: "answered",
        title: `${partnerName} replied in comments`,
      };
    }
    return {
      label: `WAITING ON ${partnerName.toUpperCase()}`,
      status: "",
      state: "waiting-on-them",
      title: `${partnerName} needs to respond`,
      pulse: true,
    };
  }

  if (myResponse) {
    const wantsDetails = wantsDetailsResponse(myResponse);
    return {
      label: signalLabelForResponse(myResponse),
      status: statusForResponse(myResponse),
      state: isMutualYesResponse(myResponse) ? "both-in" : wantsDetails ? "wants-details" : "answered",
      title: `${me.displayName}: ${myResponse.label}`,
      pulse: wantsDetails,
    };
  }

  if (myComment) {
    return {
      label: "YOU REPLIED",
      status: "Commented",
      state: "answered",
      title: "You replied in comments",
    };
  }

  return {
    label: "THEY WANT YOUR TAKE",
    status: "",
    state: "needs-response",
    title: "You have not responded yet",
    pulse: true,
  };
}

function responseForEmail(kink: KinkIdea, email: string) {
  return allKinkResponses(kink).get(normalizeEmail(email)) || null;
}

function latestCommentFrom(kink: KinkIdea, email: string) {
  const actor = normalizeEmail(email);
  if (!actor) return null;
  return [...(kink.comments || [])].reverse().find((entry) => normalizeEmail(entry.email) === actor) || null;
}

function allKinkResponses(kink: KinkIdea) {
  const responses = new Map<string, KinkResponse>();
  const author = normalizeEmail(kink.addedByEmail);
  for (const entry of kink.statusHistory || []) {
    const email = normalizeEmail(entry.email);
    if (!email) continue;
    if (author && email === author) continue;
    responses.set(email, statusToResponse(entry.status, email, entry.name));
  }
  if (kink.status && kink.statusByEmail) {
    const email = normalizeEmail(kink.statusByEmail);
    if (!author || email !== author) {
      responses.set(email, statusToResponse(kink.status, email, kink.statusByName || ""));
    }
  }
  for (const reaction of kink.reactions || []) {
    const email = normalizeEmail(reaction.by);
    if (!email) continue;
    if (author && email === author) continue;
    responses.set(email, reactionToResponse(reaction, email));
  }
  return responses;
}

function reactionToResponse(reaction: KinkReaction, email: string): KinkResponse {
  const label = normalizeReactionLabel(reaction.label || reaction.id);
  return {
    email,
    name: "",
    id: reaction.id || idForLabel(label),
    glyph: reaction.glyph || glyphForLabel(label),
    label,
    tone: toneForLabel(label),
  };
}

function statusToResponse(status: string, email: string, name = ""): KinkResponse {
  const label = normalizeReactionLabel(status);
  return {
    email,
    name,
    id: idForLabel(label),
    glyph: glyphForLabel(label),
    label,
    tone: toneForLabel(label),
  };
}

function normalizeReactionLabel(value: string) {
  const raw = String(value || "").trim();
  const byId: Record<string, string> = {
    curious: "Curious",
    hell_yeah: "Hell yeah",
    tell_me_more: "Tell me more",
    me_too: "Me too",
    give_me_a_minute: "Give me a minute",
    not_for_me: "Not for me — thank you for telling me",
  };
  const aliases: Record<string, string> = {
    "Let's chat": "Tell me more",
    Maybe: "Curious",
    "Talk first": "Give me a minute",
    Approved: "Hell yeah",
    "I'm in": "Hell yeah",
    No: "Not for me — thank you for telling me",
    "Not for me": "Not for me — thank you for telling me",
  };
  return aliases[raw] || byId[raw] || raw || "Curious";
}

function idForLabel(label: string) {
  if (label === "Hell yeah") return "hell_yeah";
  if (label === "Tell me more") return "tell_me_more";
  if (label === "Me too") return "me_too";
  if (label === "Give me a minute") return "give_me_a_minute";
  if (label === "Not for me — thank you for telling me") return "not_for_me";
  return "curious";
}

function glyphForLabel(label: string) {
  if (label === "Hell yeah") return "🔥";
  if (label === "Tell me more") return "👀";
  if (label === "Me too") return "🤤";
  if (label === "Give me a minute") return "💭";
  if (label === "Not for me — thank you for telling me") return "🌷";
  return "🤔";
}

function toneForLabel(label: string): "positive" | "pause" | "no" {
  if (label === "Give me a minute") return "pause";
  if (label === "Not for me — thank you for telling me") return "no";
  return "positive";
}

function statusForResponse(response: KinkResponse) {
  if (response.label === "Hell yeah") return "Me too";
  if (response.label === "Curious") return "Tell me more";
  return response.label;
}

function signalLabelForResponse(response: KinkResponse) {
  if (isMutualYesResponse(response)) return "BOTH IN";
  if (wantsDetailsResponse(response)) return "WANTS DETAILS";
  if (response.tone === "pause") return "MAYBE";
  return "NOT TONIGHT";
}

function isMutualYesResponse(response: KinkResponse) {
  return response.label === "Hell yeah" || response.label === "Me too";
}

function wantsDetailsResponse(response: KinkResponse) {
  return response.label === "Tell me more" || response.label === "Curious";
}

function hasLiveAsk(kink: KinkIdea) {
  const maybeKink = kink as KinkIdea & {
    promotedRequestId?: string;
    requestId?: string;
    askId?: string;
    promotedAt?: string;
  };
  return Boolean(maybeKink.promotedRequestId || maybeKink.requestId || maybeKink.askId || maybeKink.promotedAt);
}

function relativeAge(value: string) {
  const timestamp = new Date(value || "").getTime();
  if (!Number.isFinite(timestamp)) return "recently";
  const diff = Date.now() - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < hour) return "today";
  if (diff < day) return `${Math.max(1, Math.round(diff / hour))}h ago`;
  if (diff < 7 * day) return `${Math.max(1, Math.round(diff / day))}d ago`;
  return "last week";
}
