"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import RoomEncryptionPanel from "@/components/RoomEncryptionPanel";
import ScreenHeader from "@/components/ScreenHeader";
import { ErrorState, SkeletonList } from "@/components/States";
import { combineBuiltInAndSavedActs } from "@/lib/built-in-acts";
import { APP_RELEASE_VERSION } from "@/lib/app-version";
import { privateNoteCount } from "@/lib/private-notes";
import { prepareSignOut } from "@/lib/signout";
import { getCachedResource, setCachedResource, useColdStart } from "@/lib/resource-cache";
import { ensurePushSubscription, recordPushSave } from "@/lib/push-subscription";
import {
  ApiUnauthorizedError,
  createClaimableInvite,
  getConfig,
  getBootstrap,
  getMyInvites,
  getShelf,
  revokeInvite,
  savePushSubscription,
  sendTestPush,
  submitFeedback,
  updateProfileSettings,
  type InvitePreview,
} from "@/lib/api";
import type {
  Act,
  AuthInfo,
  BootstrapResponse,
  Boundary,
  FantasyBacklogResponse,
  FeedbackSentiment,
  RequestBoardResponse,
  ShelfResponse,
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
      boundaries: Boundary[];
      acts: Act[];
      backlog: FantasyBacklogResponse;
      shelf: ShelfResponse;
      board: RequestBoardResponse;
    };

type SpacePrefs = {
  blur: boolean;
  lock: boolean;
  notifyName: boolean;
  shareAttentionSignals: boolean;
};

const PUSH_PREFS_KEY = "sexualsync-push-preferences";
const SPACE_RECONNECT_URL = "/api/auth/google?returnTo=%2Fspace";
const FEEDBACK_OPTIONS: { id: FeedbackSentiment; label: string }[] = [
  { id: "positive", label: "Good" },
  { id: "neutral", label: "Idea" },
  { id: "negative", label: "Issue" },
];
const PUSH_PREF_LABELS: { id: string; title: string; sub: string }[] = [
  { id: "chat-message", title: "Sext messages", sub: "When your partner sends you a sext." },
  { id: "request-reviewed", title: "Ask replies", sub: "When your partner answers or counters an Ask." },
  { id: "request-sent", title: "New Asks", sub: "When your partner sends something for review." },
  { id: "request-reminder", title: "Ask reminders", sub: "Quiet nudges for something waiting." },
  { id: "kink-nudge", title: "Kink nudges", sub: "A batched reminder when several Kinks are waiting." },
  { id: "pile-started", title: "Pile starts", sub: "When your partner starts a Pile that needs you." },
  { id: "pile-reminder", title: "Pile reminders", sub: "Halfway, 1 hour, and 10 minutes before reveal." },
  { id: "blind-reveal", title: "Blind Reveal ready", sub: "When both answers are ready." },
  { id: "game-ready", title: "Quiz & Green Lights", sub: "When a reveal is ready, or it's your turn." },
];

function defaultPushPrefs() {
  return Object.fromEntries(PUSH_PREF_LABELS.map((pref) => [pref.id, true])) as Record<string, boolean>;
}

export default function SpacePage() {
  const [state, setState] = useState<LoadState>(() => getCachedResource<LoadState>("space") ?? { kind: "loading" });
  useColdStart("space", setState);
  useEffect(() => { if (state.kind === "ready") setCachedResource("space", state); }, [state]);
  const [notesCount, setNotesCount] = useState(0);
  const [pushPrefs, setPushPrefs] = useState<Record<string, boolean>>(defaultPushPrefs);
  const [pushPrefsLoaded, setPushPrefsLoaded] = useState(false);
  const [pushStatus, setPushStatus] = useState("Checking notification support.");
  const pushAutoRegisterAttemptedRef = useRef("");
  const [prefs, setPrefs] = useState<SpacePrefs>({
    blur: true,
    lock: true,
    notifyName: false,
    shareAttentionSignals: true,
  });

  useEffect(() => {
    // Hydration-safe seed: read prefs, push prefs, and note count from
    // localStorage after mount so the server-rendered defaults match the
    // first client paint.
    const initTimer = window.setTimeout(() => {
      try {
        const stored = JSON.parse(localStorage.getItem("ss:v1:space-prefs") || "{}");
        setPrefs((current) => ({ ...current, ...stored }));
      } catch {}
      try {
        setPushPrefs({ ...defaultPushPrefs(), ...JSON.parse(localStorage.getItem(PUSH_PREFS_KEY) || "{}") });
      } catch {
        setPushPrefs(defaultPushPrefs());
      }
      setPushPrefsLoaded(true);

      if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
        setPushStatus("Push is not available in this browser.");
        return;
      }
      if (Notification.permission === "granted") {
        navigator.serviceWorker.ready
          .then((registration) => registration.pushManager.getSubscription())
          .then((subscription) => setPushStatus(subscription ? "Notifications are on for this device." : "Notifications are allowed. Tap Enable to connect this device."))
          .catch(() => setPushStatus("Notifications are available."));
        return;
      }
      setPushStatus(Notification.permission === "denied" ? "Notifications are blocked in browser settings." : "Notifications are off on this device.");
    }, 0);

    // Private notes are encrypted at rest, so the count comes from the async
    // privateNoteCount() (it decrypts) rather than a raw localStorage parse.
    // Returns 0 while the app lock is engaged — the intended privacy behavior.
    void privateNoteCount().then(setNotesCount).catch(() => setNotesCount(0));

    return () => window.clearTimeout(initTimer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const profile: BootstrapResponse = await getBootstrap();
        if (cancelled) return;
        if (!profile.activeWorkspace) {
          setState({ kind: "no-workspace", auth: profile.auth });
          return;
        }
        const workspaceId = profile.activeWorkspace.id;
        const shelfResult = await Promise.allSettled([getShelf(workspaceId)]);
        const bootstrap = profile.bootstrap;
        if (cancelled) return;
        setPrefs((current) => ({
          ...current,
          shareAttentionSignals: profile.profile?.settings?.shareAttentionSignals !== false,
        }));
        setState({
          kind: "ready",
          auth: profile.auth,
          workspace: profile.activeWorkspace,
          boundaries: bootstrap.boundaries?.boundaries || [],
          acts: combineBuiltInAndSavedActs(bootstrap.acts?.acts || [], workspaceId),
          backlog: bootstrap.fantasy || emptyBacklog(workspaceId),
          shelf: shelfResult[0]?.status === "fulfilled" ? shelfResult[0].value : emptyShelf(workspaceId),
          board: bootstrap.requests || emptyBoard(workspaceId),
        });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiUnauthorizedError) {
          setState({ kind: "unauthorized" });
          return;
        }
        setState({ kind: "error", message: error instanceof Error ? error.message : "Couldn't load Space." });
      }
    }

    void load();

    // Re-fetch whenever the tab becomes visible again. Handles the common
    // case where the user is on /space waiting for the partner to claim
    // the invite link — once they swap tabs and come back, this refresh
    // picks up the new workspace state and InviteSection drops the
    // now-useless "Your room link" card.
    function onVisibility() {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void load();
      }
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      cancelled = true;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, []);

  function updatePref(key: keyof SpacePrefs, value: boolean) {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    try { localStorage.setItem("ss:v1:space-prefs", JSON.stringify(next)); } catch {}
    if (key === "shareAttentionSignals") {
      updateProfileSettings({ shareAttentionSignals: value })
        .then((profile) => {
          const persisted = profile.profile?.settings?.shareAttentionSignals !== false;
          setPrefs((current) => ({ ...current, shareAttentionSignals: persisted }));
          try {
            const stored = JSON.parse(localStorage.getItem("ss:v1:space-prefs") || "{}");
            localStorage.setItem("ss:v1:space-prefs", JSON.stringify({ ...stored, shareAttentionSignals: persisted }));
          } catch {}
        })
        .catch(() => {
          const reverted = { ...next, shareAttentionSignals: !value };
          setPrefs(reverted);
          try { localStorage.setItem("ss:v1:space-prefs", JSON.stringify(reverted)); } catch {}
        });
    }
  }

  const syncPushSubscription = useCallback(async (nextPrefs: Record<string, boolean> = pushPrefs) => {
    if (state.kind !== "ready") return;
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setPushStatus("Push is not available in this browser.");
      return;
    }
    setPushStatus("Connecting notifications.");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPushStatus(permission === "denied" ? "Notifications are blocked in browser settings." : "Notifications were not enabled.");
      return;
    }
    const config = await getConfig();
    if (!config.vapidPublicKey) {
      setPushStatus("Push keys are not configured yet.");
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
      });
    }
    const json = subscription.toJSON();
    await savePushSubscription({
      workspaceId: state.workspace.id,
      subscription: json,
      preferences: nextPrefs,
    });
    // Record the manual save so the background re-ensure (PushReconnect / the
    // auto-register effect below) can skip a redundant POST against the limit.
    recordPushSave(json.endpoint || "", nextPrefs);
    setPushStatus("Notifications are on for this device.");
  }, [pushPrefs, state]);

  useEffect(() => {
    if (state.kind !== "ready" || !pushPrefsLoaded) return;
    if (pushAutoRegisterAttemptedRef.current === state.workspace.id) return;
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (Notification.permission !== "granted") return;

    pushAutoRegisterAttemptedRef.current = state.workspace.id;
    const timeout = window.setTimeout(() => {
      // Deduped background heal — skips the POST when the subscription + prefs
      // are unchanged and saved recently, so repeated Space visits don't burn
      // the push-subscribe rate limit. The manual toggle still always saves.
      ensurePushSubscription(state.workspace.id, pushPrefs).catch(() => {
        // Best effort; manual enable below still works.
      });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [pushPrefs, pushPrefsLoaded, state]);

  function updatePushPref(key: string, value: boolean) {
    const next = { ...pushPrefs, [key]: value };
    setPushPrefs(next);
    try { localStorage.setItem(PUSH_PREFS_KEY, JSON.stringify(next)); } catch {}
    syncPushSubscription(next).catch((error) => {
      setPushStatus(error instanceof Error ? error.message : "Couldn't update notifications.");
    });
  }

  async function sendTestNotification() {
    if (state.kind !== "ready") return;
    try {
      await syncPushSubscription(pushPrefs);
      await sendTestPush(state.workspace.id);
      setPushStatus("Test push sent to this device.");
    } catch (error) {
      setPushStatus(error instanceof Error ? error.message : "Couldn't send a test push.");
    }
  }

  return (
    <AppShell>
      <ScreenHeader
        eyebrow="Space"
        showBrand={false}
        title="You & your space"
        subtitle={subtitleFor(state)}
      />
      <Body
        state={state}
        notesCount={notesCount}
        prefs={prefs}
        pushPrefs={pushPrefs}
        pushStatus={pushStatus}
        onPref={updatePref}
        onPushPref={updatePushPref}
        onEnablePush={() => syncPushSubscription().catch((error) => {
          setPushStatus(error instanceof Error ? error.message : "Couldn't enable notifications.");
        })}
        onTestPush={sendTestNotification}
      />
    </AppShell>
  );
}

function emptyBacklog(workspaceId: string): FantasyBacklogResponse {
  return { workspaceId, reactionCatalog: [], ideas: [], graveyard: [] };
}

function emptyShelf(workspaceId: string): ShelfResponse {
  return { workspaceId, reactionCatalog: [], items: [] };
}

function emptyBoard(workspaceId: string): RequestBoardResponse {
  return { workspaceId, requests: [], activeRequests: [], history: [] };
}

function Body({
  state,
  notesCount,
  prefs,
  pushPrefs,
  pushStatus,
  onPref,
  onPushPref,
  onEnablePush,
  onTestPush,
}: {
  state: LoadState;
  notesCount: number;
  prefs: SpacePrefs;
  pushPrefs: Record<string, boolean>;
  pushStatus: string;
  onPref: (key: keyof SpacePrefs, value: boolean) => void;
  onPushPref: (key: string, value: boolean) => void;
  onEnablePush: () => void;
  onTestPush: () => void;
}) {
  if (state.kind === "loading") return <SkeletonList count={4} />;
  if (state.kind === "unauthorized") {
    return (
      <ErrorState
        title="Couldn't confirm your session"
        body="Space could not verify your Google session. Reconnect and come right back here."
        action={
          <span className="settings-actions settings-actions-center">
            <Link href="/space" className="btn-ghost pressable">Try again</Link>
            <a className="btn-primary pressable" href={SPACE_RECONNECT_URL}>Reconnect</a>
          </span>
        }
      />
    );
  }
  if (state.kind === "error") {
    return <ErrorState title="Couldn't load Space" body={state.message} />;
  }
  if (state.kind === "no-workspace") {
    return (
      <ErrorState
        title="No partner space yet"
        body="You're signed in, but this device did not receive your partner space."
        action={<a className="btn-primary pressable" href={SPACE_RECONNECT_URL}>Reconnect Space</a>}
      />
    );
  }

  const hardLimits = state.boundaries.filter((item) => item.type === "Hard No").length;
  const careLimits = state.boundaries.length - hardLimits;

  return (
    <div className="settings-stage">
      <TutorialBanner />

      {!hasJoinedPartner(state.workspace, state.auth.email) && (
        <InviteSection workspaceId={state.workspace.id} />
      )}

      <section className="settings-section">
        <p className="eyebrow">Together</p>
        <div className="settings-card">
          <SettingsLink href="/space/limits" title="Limits" sub={`${hardLimits} hard · ${careLimits} handle with care`} />
          <SettingsLink href="/space/acts" title="Your acts library" sub={`${state.acts.length} available Acts`} />
          <SettingsLink href="/space/health" title="Health" sub="Approved sex, Pile overlaps, and Act counts" />
          <SettingsLink href="/space/vault" title="Private Vault" sub="Encrypted clips, moments, reactions, and comments" />
          <SettingsLink href="/space/notes" title="Private notes" sub={`${notesCount} on this device · never synced`} />
        </div>
      </section>

      <section className="settings-section">
        <p className="eyebrow">Trust</p>
        <div className="settings-card">
          <SettingsLink href="/space/privacy" title="Privacy & data" sub="See what is stored, what stays here, and how deletion works" />
          <SettingRow
            title="Blur the dirty stuff"
            sub="Thumbnails open clean. You decide what to reveal."
            checked={prefs.blur}
            onChange={(value) => onPref("blur", value)}
          />
          <SettingRow
            title="Show partner name in notifications"
            sub="Off, it reads as new from your partner."
            checked={prefs.notifyName}
            onChange={(value) => onPref("notifyName", value)}
          />
          <SettingRow
            title="Share attention signals"
            sub="Rare heat signals when a Kink or Shelf save holds your focus."
            checked={prefs.shareAttentionSignals}
            onChange={(value) => onPref("shareAttentionSignals", value)}
          />
        </div>
      </section>

      <section className="settings-section settings-room-encryption-section">
        <p className="eyebrow">Room Encryption</p>
        <RoomEncryptionPanel />
      </section>

      <section className="settings-section">
        <p className="eyebrow">Notifications</p>
        <div className="settings-card">
          <div className="settings-row settings-row-stack">
            <span>
              <span className="settings-row-title">This device</span>
              <span className="settings-row-sub">{pushStatus}</span>
            </span>
            <span className="settings-actions">
              <button type="button" className="btn-ghost pressable" onClick={onEnablePush}>Enable</button>
              <button type="button" className="btn-ghost pressable" onClick={onTestPush}>Test</button>
            </span>
          </div>
          {PUSH_PREF_LABELS.map((pref) => (
            <SettingRow
              key={pref.id}
              title={pref.title}
              sub={pref.sub}
              checked={pushPrefs[pref.id] !== false}
              onChange={(value) => onPushPref(pref.id, value)}
              dataPushPref={pref.id}
            />
          ))}
        </div>
      </section>

      <section className="settings-section">
        <p className="eyebrow">Account</p>
        <div className="settings-card">
          <SettingsLink href="/more" title="Account and data" sub={`${state.backlog.ideas.length} Kinks · ${state.shelf.items.length} Shelf items`} arrow="→" />
          <a className="settings-link pressable" href="/api/auth/logout" onClick={prepareSignOut}>
            <span>
              Sign out of this device
              <span className="settings-link-sub">Clears your Google session here.</span>
            </span>
            <span className="settings-link-chev">→</span>
          </a>
        </div>
      </section>

      <FeedbackSection workspaceId={state.workspace.id} />

      <section className="settings-section settings-beta-note">
        <p className="eyebrow">Beta / early access</p>
        <div className="settings-card settings-beta-card">
          <p>
            Sexualsync is in early access. Core privacy, auth, export, deletion, and safety checks are live, but the product is still young. Please use it with someone you trust and report anything weird.
          </p>
        </div>
      </section>

      <div className="settings-footer">
        <a
          className="settings-coffee-link pressable"
          href="https://ko-fi.com/bergwa"
          target="_blank"
          rel="noreferrer"
        >
          <span className="settings-coffee-mark" aria-hidden="true">k</span>
          <span className="settings-coffee-copy">
            <span>Support Sexualsync on Ko-fi</span>
            <small>Help keep the room cared for.</small>
          </span>
        </a>
        <span className="chip settings-version">{APP_RELEASE_VERSION}</span>
      </div>
    </div>
  );
}

function FeedbackSection({ workspaceId }: { workspaceId: string }) {
  const [sentiment, setSentiment] = useState<FeedbackSentiment>("neutral");
  const [message, setMessage] = useState("");
  const [mayContact, setMayContact] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const canSubmit = message.trim().length > 0 && !submitting;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setStatus("");
    setError("");
    try {
      await submitFeedback({
        workspaceId,
        sentiment,
        message: message.trim(),
        mayContact,
        route: typeof window === "undefined" ? "/space" : `${window.location.pathname}${window.location.search}`,
        surface: "space",
      });
      setMessage("");
      setMayContact(false);
      setSentiment("neutral");
      setStatus("Thanks. Feedback sent.");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Couldn't send feedback.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="settings-section settings-feedback-section">
      <p className="eyebrow">Feedback</p>
      <form className="settings-card settings-feedback" onSubmit={submit}>
        <div className="settings-feedback-head">
          <span className="settings-row-title">What should feel better?</span>
          <span className="settings-row-sub">Private to Sexualsync. Skip intimate details.</span>
        </div>
        <div className="settings-feedback-options" role="group" aria-label="Feedback type">
          {FEEDBACK_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`settings-feedback-chip pressable ${sentiment === option.id ? "is-active" : ""}`}
              onClick={() => setSentiment(option.id)}
              aria-pressed={sentiment === option.id}
            >
              {option.label}
            </button>
          ))}
        </div>
        <textarea
          className="input settings-feedback-input"
          value={message}
          onChange={(event) => {
            setMessage(event.target.value);
            if (status) setStatus("");
            if (error) setError("");
          }}
          placeholder="What should we fix, keep, or rethink?"
          aria-label="Feedback"
          maxLength={1200}
          autoCapitalize="sentences"
          autoCorrect="on"
          spellCheck
        />
        <label className="settings-feedback-followup">
          <input
            type="checkbox"
            checked={mayContact}
            onChange={(event) => setMayContact(event.target.checked)}
          />
          <span>You can follow up with me</span>
        </label>
        <div className="settings-feedback-actions">
          {(status || error) && (
            <p className={`settings-feedback-status ${error ? "is-error" : ""}`} role="status">
              {error || status}
            </p>
          )}
          <button type="submit" className="btn-primary pressable" disabled={!canSubmit}>
            {submitting ? "Sending" : "Send"}
          </button>
        </div>
      </form>
    </section>
  );
}

function TutorialBanner() {
  return (
    <Link href="/space/tutorial" className="settings-tutorial-banner pressable" aria-label="Open the quick tour">
      <span className="settings-tutorial-mark" aria-hidden="true">?</span>
      <span className="settings-tutorial-copy">
        <span className="settings-tutorial-title">Need the quick tour?</span>
        <span className="settings-tutorial-sub">A tiny map for Asks, Inspiration, Reveals, and Space.</span>
      </span>
      <span className="settings-tutorial-action">Start</span>
    </Link>
  );
}

function SettingsLink({
  href,
  title,
  sub,
  arrow = "›",
}: {
  href: string;
  title: string;
  sub: string;
  arrow?: string;
}) {
  return (
    <Link href={href} className="settings-link pressable">
      <span>
        {title}
        <span className="settings-link-sub">{sub}</span>
      </span>
      <span className="settings-link-chev">{arrow}</span>
    </Link>
  );
}

function SettingRow({
  title,
  sub,
  checked,
  onChange,
  dataPushPref,
}: {
  title: string;
  sub: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  dataPushPref?: string;
}) {
  // The whole row is the control (role=switch) so the title text is a tap
  // target too — a <label> does NOT forward clicks to a nested <button>, so the
  // old markup left only the small switch thumb tappable (WCAG 2.5.5). The
  // visible pill is now decorative; the row carries the name + state.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-push-pref={dataPushPref}
      className="settings-row pressable"
      onClick={() => onChange(!checked)}
    >
      <span>
        <span className="settings-row-title">{title}</span>
        <span className="settings-row-sub">{sub}</span>
      </span>
      <span className={`switch ${checked ? "is-on" : ""}`} aria-hidden="true">
        <span className="switch-thumb" />
      </span>
    </button>
  );
}

function subtitleFor(state: LoadState) {
  if (state.kind !== "ready") return "Trust, together settings, and the doors out.";
  return state.auth.email;
}

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }
  return output;
}

function hasJoinedPartner(workspace: Workspace, myEmail: string): boolean {
  const me = (myEmail || "").toLowerCase();
  return (workspace.members || []).some((member) => {
    return member.status === "active" && (member.email || "").toLowerCase() !== me;
  });
}

function buildInviteShareUrl(inviteId: string): string {
  if (typeof window === "undefined") return `/signin?invite=${inviteId}`;
  return `${window.location.origin}/signin?invite=${encodeURIComponent(inviteId)}`;
}

function InviteSection({ workspaceId }: { workspaceId: string }) {
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"" | "copy" | "regen">("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await getMyInvites();
        if (cancelled) return;
        const match = list.sent.find((item) => item.workspaceId === workspaceId && item.claimable && item.status === "pending");
        setInvite(match || null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Couldn't load your invite.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

  async function copy() {
    if (!invite || busy) return;
    setBusy("copy");
    setError(null);
    try {
      const url = buildInviteShareUrl(invite.id);
      let copiedToClipboard = false;
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        copiedToClipboard = true;
      }
      if (!copiedToClipboard) {
        setError("Couldn't copy automatically. Long-press the link above to copy it manually.");
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy. Long-press the link above to copy manually.");
    } finally {
      setBusy("");
    }
  }

  async function regenerate() {
    if (!invite || busy) return;
    setBusy("regen");
    setError(null);
    try {
      await revokeInvite(invite.id);
      // Old link is dead the moment revoke resolves. Clear it immediately so a
      // failure on the create side doesn't leave a stale revoked URL on screen
      // for the user to copy and share.
      setInvite(null);
      const created = await createClaimableInvite({ workspaceId });
      setInvite(created.invite);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't regenerate the link.");
    } finally {
      setBusy("");
    }
  }

  async function create() {
    if (busy) return;
    setBusy("regen");
    setError(null);
    try {
      const created = await createClaimableInvite({ workspaceId });
      setInvite(created.invite);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the link.");
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="settings-section">
      <p className="eyebrow">Your room link</p>
      <div className="settings-card space-invite-card">
        {loading ? (
          <p className="space-invite-loading">Loading link&hellip;</p>
        ) : invite ? (
          <>
            <div className="space-invite-row">
              <span className="space-invite-url" title={buildInviteShareUrl(invite.id)}>
                {buildInviteShareUrl(invite.id)}
              </span>
              <span className="space-invite-status">Unclaimed</span>
            </div>
            <p className="space-invite-meta">
              {formatRelativeAge(invite.createdAt)} &middot; expires {formatRelativeExpiry(invite.expiresAt)}
            </p>
            {error && <p className="space-invite-error" role="alert">{error}</p>}
            <div className="space-invite-actions">
              <button type="button" className="space-invite-pill" onClick={() => void copy()} disabled={busy === "copy"}>
                {copied ? "Copied" : busy === "copy" ? "Copying..." : "Copy link"}
              </button>
              <button type="button" className="space-invite-pill space-invite-pill-ghost" onClick={() => void regenerate()} disabled={busy === "regen"}>
                {busy === "regen" ? "Regenerating..." : "Revoke & regenerate"}
              </button>
            </div>
            <p className="space-invite-hint">
              Revoking immediately voids the old link. Once your partner joins, this section goes away.
            </p>
          </>
        ) : (
          <>
            <p className="space-invite-empty">You don&apos;t have a shareable link yet for this room.</p>
            {error && <p className="space-invite-error" role="alert">{error}</p>}
            <div className="space-invite-actions">
              <button type="button" className="space-invite-pill" onClick={() => void create()} disabled={Boolean(busy)}>
                {busy ? "Creating..." : "Create invite link"}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function formatRelativeAge(iso: string): string {
  const when = new Date(iso).getTime();
  if (!Number.isFinite(when)) return "just now";
  const diff = Math.max(0, Date.now() - when);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `created ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `created ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `created ${days}d ago`;
}

function formatRelativeExpiry(iso: string): string {
  const when = new Date(iso).getTime();
  if (!Number.isFinite(when)) return "soon";
  const diff = when - Date.now();
  if (diff <= 0) return "now";
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  if (remHours === 0) return `in ${days}d`;
  return `in ${days}d ${remHours}h`;
}
