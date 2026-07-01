"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import ScreenHeader from "@/components/ScreenHeader";
import { ErrorState, SkeletonList } from "@/components/States";
import "./onboarding.css";
import {
  ApiUnauthorizedError,
  createClaimableInvite,
  createWorkspaceForSelf,
  getActiveRoomKdfVersion,
  getMyInvites,
  getProfile,
  revokeInvite,
  updateWorkspaceSettings,
} from "@/lib/api";
import { createRoomE2eeVerifier, generateRoomPassphrase, unlockRoomE2ee } from "@/lib/room-crypto";
import type { Workspace } from "@/lib/types";

type Stage =
  | { kind: "loading" }
  | { kind: "unauthorized" }
  | { kind: "error"; message: string }
  | { kind: "create"; ownerName: string }
  | { kind: "encrypt"; workspace: Workspace }
  | { kind: "share"; workspace: Workspace; inviteUrl: string; inviteId: string };

export default function OnboardingPage() {
  const router = useRouter();
  // Keep router in a ref so the bootstrap effect can use it without depending
  // on it. Some Next.js versions return a new router reference on every
  // render — depending on it inside a useEffect that calls setState causes a
  // fetch → setState → re-render → re-fetch loop that visually looks like
  // the page is refreshing every few hundred ms.
  const routerRef = useRef(router);

  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [ownerName, setOwnerName] = useState("");
  const [partnerName, setPartnerName] = useState("");
  const [roomName, setRoomName] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirmPass, setConfirmPass] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const profile = await getProfile();
        if (cancelled) return;
        if (profile.activeWorkspace && hasActivePartner(profile.activeWorkspace, profile.auth.email)) {
          routerRef.current.replace("/sexboard");
          return;
        }
        // If the user already has a solo workspace, jump straight to the share step.
        const solo = profile.activeWorkspace;
        if (solo) {
          // A new room that hasn't been encrypted yet → finish E2EE setup
          // before the share step, so a partner never joins an unencrypted room.
          if (!solo.settings?.roomE2eeEnabled) {
            setStage({ kind: "encrypt", workspace: solo });
            return;
          }
          const invites = await getMyInvites();
          const outgoing = invites.sent.find((invite) => invite.workspaceId === solo.id && invite.claimable);
          if (outgoing) {
            setStage({
              kind: "share",
              workspace: solo,
              inviteUrl: buildShareUrl(outgoing.id),
              inviteId: outgoing.id,
            });
            return;
          }
          // Workspace exists but no claimable invite yet — make one now.
          try {
            const created = await createClaimableInvite({ workspaceId: solo.id });
            if (cancelled) return;
            setStage({
              kind: "share",
              workspace: solo,
              inviteUrl: created.inviteUrl,
              inviteId: created.invite.id,
            });
            return;
          } catch (error) {
            if (cancelled) return;
            setStage({
              kind: "error",
              message: error instanceof Error ? error.message : "Couldn't prepare your invite link.",
            });
            return;
          }
        }
        const defaultOwner = (profile.auth.person || "").split(" ")[0] || "";
        setOwnerName(defaultOwner);
        setStage({ kind: "create", ownerName: defaultOwner });
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiUnauthorizedError) {
          setStage({ kind: "unauthorized" });
          return;
        }
        setStage({
          kind: "error",
          message: error instanceof Error ? error.message : "Couldn't load your account.",
        });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const canSubmitCreate = useMemo(() => ownerName.trim().length > 0 && !busy, [ownerName, busy]);

  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  async function submitCreate() {
    if (!canSubmitCreate) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const profile = await createWorkspaceForSelf({
        ownerName: ownerName.trim(),
        partnerName: partnerName.trim() || undefined,
        displayName: roomName.trim() || undefined,
      });
      const workspace = profile.activeWorkspace;
      if (!workspace) {
        throw new Error("Workspace was not created.");
      }
      // Set the room passphrase next. The invite link is only created after
      // encryption is on, so a partner never joins an unencrypted room.
      setStage({ kind: "encrypt", workspace });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Couldn't create the room.");
    } finally {
      setBusy(false);
    }
  }

  function generatePassphrase() {
    const generated = generateRoomPassphrase();
    setPassphrase(generated);
    setConfirmPass(generated);
    setSubmitError(null);
  }

  async function submitPassphrase(workspace: Workspace) {
    const pass = passphrase.trim();
    if (pass.length < 16) { setSubmitError("Use at least 16 characters for a new room passphrase."); return; }
    if (pass !== confirmPass.trim()) { setSubmitError("The two passphrases don't match."); return; }
    setBusy(true);
    setSubmitError(null);
    try {
      // First-time enable: derive the key from the chosen passphrase, mint a
      // verifier, and turn encryption on. Same mechanism the settings panel
      // uses; the passphrase never leaves the device. A new room adopts this
      // deploy's active KDF version (v1 unless self-host opts into v2); it is
      // frozen into the verifier so every later unlock derives at the same count.
      const kdfVersion = await getActiveRoomKdfVersion();
      await unlockRoomE2ee(workspace.id, pass, undefined, kdfVersion);
      const verifier = await createRoomE2eeVerifier(workspace.id);
      await updateWorkspaceSettings({
        workspaceId: workspace.id,
        roomE2eeEnabled: true,
        roomE2eeVerifier: verifier,
      });
      const invite = await createClaimableInvite({ workspaceId: workspace.id });
      setPassphrase("");
      setConfirmPass("");
      setStage({
        kind: "share",
        workspace,
        inviteUrl: invite.inviteUrl,
        inviteId: invite.invite.id,
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Couldn't turn on encryption. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function copyLink(url: string) {
    try {
      let copiedToClipboard = false;
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        copiedToClipboard = true;
      } else if (typeof document !== "undefined") {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        try {
          copiedToClipboard = document.execCommand("copy");
        } catch {
          copiedToClipboard = false;
        }
        document.body.removeChild(ta);
      }
      if (!copiedToClipboard) {
        setSubmitError("Couldn't copy automatically. Long-press the link above to copy it manually.");
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      setSubmitError("Couldn't copy. You can long-press the link to copy manually.");
    }
  }

  async function shareLink(url: string, partner: string) {
    const text = `Join me in our private space on Sexualsync: ${url}`;
    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({
          title: "Sexualsync invite",
          text,
          url,
        });
      } else {
        await copyLink(url);
      }
    } catch {
      // share cancelled — no-op
    }
    void partner;
  }

  async function regenerateLink(workspaceId: string, oldInviteId: string) {
    setBusy(true);
    setSubmitError(null);
    try {
      await revokeInvite(oldInviteId);
      // Old link is dead — clear the displayed URL before we attempt the
      // create. If create fails, the user gets an error instead of a
      // copy-able revoked link.
      setStage((current) => current.kind === "share" ? { ...current, inviteUrl: "", inviteId: "" } : current);
      const created = await createClaimableInvite({ workspaceId });
      setStage((current) => current.kind === "share" ? {
        ...current,
        inviteUrl: created.inviteUrl,
        inviteId: created.invite.id,
      } : current);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Couldn't regenerate the link. Try again or refresh.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell hideTabBar>
      <ScreenHeader
        showBrand
        eyebrow={stage.kind === "share" ? "Step 3 · of 3" : stage.kind === "encrypt" ? "Step 2 · of 3" : "Step 1 · of 3"}
        title={stage.kind === "share" ? "Send them in." : stage.kind === "encrypt" ? "Lock it to you two." : "Set up your room."}
        subtitle={stage.kind === "share"
          ? "Anyone with this link can claim the second seat — only the first person to open it."
          : stage.kind === "encrypt"
          ? "Pick a passphrase together. It encrypts everything end-to-end — even we can't read it."
          : "A private space for two. Tell us who's in it — you can change anything later."}
      />
      <Body
        stage={stage}
        ownerName={ownerName}
        partnerName={partnerName}
        roomName={roomName}
        busy={busy}
        submitError={submitError}
        copied={copied}
        canSubmitCreate={canSubmitCreate}
        onOwnerName={setOwnerName}
        onPartnerName={setPartnerName}
        onRoomName={setRoomName}
        onSubmitCreate={submitCreate}
        passphrase={passphrase}
        confirmPass={confirmPass}
        onPassphrase={setPassphrase}
        onConfirmPass={setConfirmPass}
        onGeneratePassphrase={generatePassphrase}
        onSubmitPassphrase={submitPassphrase}
        onCopy={copyLink}
        onShare={shareLink}
        onRegenerate={regenerateLink}
        onGoToRoom={() => router.push("/sexboard")}
      />
    </AppShell>
  );
}

function Body(props: {
  stage: Stage;
  ownerName: string;
  partnerName: string;
  roomName: string;
  busy: boolean;
  submitError: string | null;
  copied: boolean;
  canSubmitCreate: boolean;
  onOwnerName: (value: string) => void;
  onPartnerName: (value: string) => void;
  onRoomName: (value: string) => void;
  onSubmitCreate: () => Promise<void>;
  passphrase: string;
  confirmPass: string;
  onPassphrase: (value: string) => void;
  onConfirmPass: (value: string) => void;
  onGeneratePassphrase: () => void;
  onSubmitPassphrase: (workspace: Workspace) => Promise<void>;
  onCopy: (url: string) => Promise<void>;
  onShare: (url: string, partner: string) => Promise<void>;
  onRegenerate: (workspaceId: string, inviteId: string) => Promise<void>;
  onGoToRoom: () => void;
}) {
  const { stage } = props;
  if (stage.kind === "loading") return <SkeletonList count={3} />;
  if (stage.kind === "unauthorized") {
    return (
      <ErrorState
        title="Sign in to continue"
        body="You need to sign in before you can set up a room."
        action={<Link href="/" className="btn-ghost">Back to sign-in</Link>}
      />
    );
  }
  if (stage.kind === "error") {
    return <ErrorState title="Couldn't load onboarding" body={stage.message} />;
  }

  if (stage.kind === "create") {
    return (
      <div className="onboarding-stage">
        <form className="onboarding-form" onSubmit={(event) => { event.preventDefault(); void props.onSubmitCreate(); }}>
          <div className="field">
            <label htmlFor="ob-owner">You go by</label>
            <input
              id="ob-owner"
              className="input"
              value={props.ownerName}
              onChange={(event) => props.onOwnerName(event.target.value)}
              placeholder="Your first name"
              autoCapitalize="words"
              autoCorrect="off"
              spellCheck={false}
              maxLength={80}
            />
          </div>
          <div className="field">
            <label htmlFor="ob-partner">Partner&apos;s first name</label>
            <input
              id="ob-partner"
              className="input"
              value={props.partnerName}
              onChange={(event) => props.onPartnerName(event.target.value)}
              placeholder="What should we call them?"
              autoCapitalize="words"
              autoCorrect="off"
              spellCheck={false}
              maxLength={80}
            />
            <p className="field-hint">Optional. Used in prompts.</p>
          </div>
          <div className="field">
            <label htmlFor="ob-room">Room name</label>
            <input
              id="ob-room"
              className="input"
              value={props.roomName}
              onChange={(event) => props.onRoomName(event.target.value)}
              placeholder={props.ownerName ? `${props.ownerName} & ___` : "Your room"}
              autoCapitalize="words"
              autoCorrect="off"
              spellCheck={false}
              maxLength={80}
            />
            <p className="field-hint">Optional. Only the two of you ever see it.</p>
          </div>
          {props.submitError && (
            <p className="onboarding-error" role="alert">{props.submitError}</p>
          )}
          <button
            type="submit"
            className="btn-primary onboarding-submit"
            disabled={!props.canSubmitCreate}
          >
            {props.busy ? "Creating..." : "Create the room"}
          </button>
          <p className="onboarding-foot">Next · a private link to share</p>
        </form>
      </div>
    );
  }

  if (stage.kind === "encrypt") {
    const ws = stage.workspace;
    return (
      <div className="onboarding-stage">
        <form
          className="onboarding-form"
          onSubmit={(event) => { event.preventDefault(); void props.onSubmitPassphrase(ws); }}
        >
          <div className="field">
            <label htmlFor="ob-pass">Room passphrase</label>
            <input
              id="ob-pass"
              className="input"
              type="password"
              value={props.passphrase}
              onChange={(event) => props.onPassphrase(event.target.value)}
              placeholder="At least 16 characters"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="new-password"
              spellCheck={false}
              maxLength={200}
            />
          </div>
          <div className="field">
            <label htmlFor="ob-pass2">Confirm passphrase</label>
            <input
              id="ob-pass2"
              className="input"
              type="password"
              value={props.confirmPass}
              onChange={(event) => props.onConfirmPass(event.target.value)}
              placeholder="Type it again"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="new-password"
              spellCheck={false}
              maxLength={200}
            />
            <p className="field-hint">
              You and your partner share this one passphrase. It never leaves your devices — so if you both forget it, the room&rsquo;s contents can&rsquo;t be recovered by anyone, us included.
            </p>
          </div>
          <button
            type="button"
            className="btn-ghost onboarding-generate"
            onClick={props.onGeneratePassphrase}
            disabled={props.busy}
          >
            Suggest a strong passphrase
          </button>
          {props.submitError && (
            <p className="onboarding-error" role="alert">{props.submitError}</p>
          )}
          <button type="submit" className="btn-primary onboarding-submit" disabled={props.busy}>
            {props.busy ? "Encrypting…" : "Encrypt the room"}
          </button>
          <p className="onboarding-foot">Next · a private link to share</p>
        </form>
      </div>
    );
  }

  // share stage
  const workspace = stage.workspace;
  // Prefer a real invited-partner member, then fall back to the name captured
  // in the create step, and only then to the generic literal.
  const partnerLabel =
    workspace.members?.find((member) => member.role === "partner" && member.status === "invited")?.displayName
    || props.partnerName.trim()
    || "your partner";
  const url = stage.inviteUrl;

  return (
    <div className="onboarding-stage">
      <div className="onboarding-share">
        <div className="onboarding-link-card">
          <span className="onboarding-link-url">{url}</span>
          <button
            type="button"
            className={`onboarding-copy-pill${props.copied ? " is-copied" : ""}`}
            onClick={() => void props.onCopy(url)}
            aria-live="polite"
          >
            {props.copied ? "Copied" : "Copy"}
          </button>
        </div>

        <div className="onboarding-share-row">
          <a
            className="onboarding-share-btn"
            href={`mailto:?subject=${encodeURIComponent("A private room for the two of us")}&body=${encodeURIComponent(`Join me in our private space on Sexualsync:\n\n${url}`)}`}
          >
            <span className="onboarding-share-icon" aria-hidden="true">✉</span>
            Email
          </a>
          <a
            className="onboarding-share-btn"
            href={`sms:?&body=${encodeURIComponent(`Join me in our private space on Sexualsync: ${url}`)}`}
          >
            <span className="onboarding-share-icon" aria-hidden="true">💬</span>
            Messages
          </a>
          <button
            type="button"
            className="onboarding-share-btn"
            onClick={() => void props.onShare(url, partnerLabel)}
          >
            <span className="onboarding-share-icon" aria-hidden="true">…</span>
            More
          </button>
        </div>

        {props.submitError && (
          <p className="onboarding-error" role="alert">{props.submitError}</p>
        )}

        <div className="onboarding-share-actions">
          <button type="button" className="btn-primary onboarding-submit" onClick={props.onGoToRoom}>
            Open the room
          </button>
          <button
            type="button"
            className="btn-ghost onboarding-secondary"
            disabled={props.busy}
            onClick={() => void props.onRegenerate(workspace.id, stage.inviteId)}
          >
            {props.busy ? "Regenerating..." : "Revoke & regenerate link"}
          </button>
        </div>

        <p className="onboarding-foot">
          Tell {partnerLabel} the passphrase too — separately from this link. Without it, neither of you can open the room, and it can&rsquo;t be recovered.
        </p>
        <p className="onboarding-foot">
          Expires in 14 days · only the first person to open the link claims the seat.<br />
          Sent by accident? Regenerate above to void the old link.
        </p>
      </div>
    </div>
  );
}

function hasActivePartner(workspace: Workspace, myEmail: string): boolean {
  const me = myEmail.toLowerCase();
  return (workspace.members || []).some((member) => {
    return member.status === "active" && (member.email || "").toLowerCase() !== me;
  });
}

function buildShareUrl(inviteId: string): string {
  if (typeof window === "undefined") return `/signin?invite=${inviteId}`;
  const origin = window.location.origin;
  return `${origin}/signin?invite=${encodeURIComponent(inviteId)}`;
}
