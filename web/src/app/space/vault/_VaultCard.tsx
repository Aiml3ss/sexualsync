"use client";

/**
 * One Vault clip card. Owns the unlock-with-passphrase flow, the
 * decrypt-on-unlock pipeline (video + comments + moments + title), the
 * optimistic reaction toggle, the moment editor, and the title editor.
 *
 * Extracted from `vault/page.tsx` as part of H-1 so that page.tsx can stay
 * a thin route shell. The clip + moment lightboxes were already split
 * (see _VaultClipLightbox.tsx / _VaultMomentLightbox.tsx).
 */

import { type FormEvent, memo, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  addVaultComment,
  addVaultMoment,
  deleteVaultItem,
  deleteVaultMoment,
  getVaultMedia,
  setVaultReaction,
  updateVaultMomentTitle,
  updateVaultTitle,
} from "@/lib/api";
import type {
  ShelfReactionOption,
  VaultComment,
  VaultItem,
  VaultMoment,
  VaultResponse,
} from "@/lib/types";
import { normalizeEmail } from "@/lib/workspace";
import { confirmAction } from "@/lib/confirm-dialog";
import {
  decryptVaultBlobWithKey,
  decryptVaultTextWithKey,
  deriveVaultUnlockKey,
  encryptVaultBlobWithKey,
  encryptVaultTextWithKey,
  vaultAad,
} from "@/lib/vault-crypto";
import {
  frameFromVideo,
  reactionCaption,
  readVaultTitleCache,
  relativeAge,
  rememberVaultTitle,
  sizeLabel,
} from "./_vault-helpers";
// The full-screen clip + moment lightboxes are below-the-fold: they only
// mount once the user opens one. Code-split them (ssr:false — both are
// portal + Pointer Events viewers that decrypt blobs into object URLs) so
// they don't ship in the initial card bundle.
const VaultClipLightbox = dynamic(
  () => import("./_VaultClipLightbox").then((m) => m.VaultClipLightbox),
  { ssr: false },
);
const VaultMomentLightbox = dynamic(
  () => import("./_VaultMomentLightbox").then((m) => m.VaultMomentLightbox),
  { ssr: false },
);

export type DecryptedComment = VaultComment & { text: string };
export type DecryptedMoment = VaultMoment & { titleText: string; noteText: string; frameUrl: string };

export function VaultCard({
  item,
  workspaceId,
  catalog,
  me,
  onVaultChange,
  highlighted,
  highlightedFromActivity,
}: {
  item: VaultItem;
  workspaceId: string;
  catalog: ShelfReactionOption[];
  me: string;
  onVaultChange: (vault: VaultResponse) => void;
  highlighted: boolean;
  highlightedFromActivity: boolean;
}) {
  const [passphrase, setPassphrase] = useState("");
  // We hold a non-extractable CryptoKey after the first decrypt instead of
  // the passphrase string. A heap dump or hostile extension can no longer
  // recover the passphrase from this component's state. `passphrase` itself
  // is cleared on successful unlock; only the input element transiently
  // carries the string while the user types.
  const [unlockKey, setUnlockKey] = useState<CryptoKey | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [title, setTitle] = useState(item.displayTitle || "");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [comments, setComments] = useState<DecryptedComment[]>([]);
  const [moments, setMoments] = useState<DecryptedMoment[]>([]);
  const [commentDraft, setCommentDraft] = useState("");
  const [momentTitle, setMomentTitle] = useState("");
  const [editingMomentTitleId, setEditingMomentTitleId] = useState("");
  const [momentTitleDraft, setMomentTitleDraft] = useState("");
  const [activeMomentId, setActiveMomentId] = useState("");
  const [clipLightboxOpen, setClipLightboxOpen] = useState(false);
  const [clipLightboxStart, setClipLightboxStart] = useState(0);
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const videoUrlRef = useRef("");
  const frameUrlsRef = useRef<string[]>([]);
  // Track the last item.id we seeded the local title from, plus the
  // editing flag without subscribing. Lets us only resync the base title
  // when the clip actually changes — server-driven prop refreshes for
  // unrelated fields (reactions, comments) no longer clobber an in-flight
  // title edit.
  const lastSeededItemIdRef = useRef<string>("");
  const editingTitleRef = useRef(false);
  const myEmail = normalizeEmail(me);
  // Optimistic reaction state. We render this over the prop until the server
  // response lands so the button flashes lit immediately instead of after a
  // 500-1500 ms round trip. `pendingReaction === undefined` means "defer to
  // the prop"; any other value (string id or null) overrides until reconciled.
  const [pendingReaction, setPendingReaction] = useState<string | null | undefined>(undefined);
  const propReaction = item.reactions?.[myEmail] || null;
  const myReaction = pendingReaction !== undefined ? pendingReaction : propReaction;
  const partnerEntry = Object.entries(item.reactions || {}).find(([email]) => normalizeEmail(email) !== myEmail);
  const partnerReaction = partnerEntry ? catalog.find((option) => option.id === partnerEntry[1]) : null;
  const active = myReaction ? catalog.find((option) => option.id === myReaction) : null;

  useEffect(() => {
    // Reconcile: once the server-driven prop matches our optimistic value,
    // drop the override so future re-renders pick up directly from the prop.
    if (pendingReaction !== undefined && pendingReaction === propReaction) {
      queueMicrotask(() => setPendingReaction(undefined));
    }
  }, [pendingReaction, propReaction]);
  const isMine = normalizeEmail(item.addedByEmail) === myEmail;
  const canEditTitle = isMine;
  const activeMoment = activeMomentId ? moments.find((moment) => moment.id === activeMomentId) || null : null;

  useEffect(() => {
    if (!highlighted) return;
    const timer = window.setTimeout(() => cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 260);
    return () => window.clearTimeout(timer);
  }, [highlighted]);

  useEffect(() => { editingTitleRef.current = editingTitle; }, [editingTitle]);

  useEffect(() => {
    // Clip switched → always re-seed and drop any draft. Same clip + server
    // refresh → only re-seed if the user isn't editing right now, so unrelated
    // partner-side changes (reactions, comments) don't clobber an in-flight
    // title edit.
    //
    // The server-side C-9 fix pins item.displayTitle to "Private Clip" for
    // every clip, so it is no longer a useful signal for "what should I
    // show in the UI?". Prefer the locally cached decrypted title first;
    // fall back to the placeholder only when nothing else is known. That
    // way the user's real title persists across re-renders driven by
    // unrelated prop changes (partner reactions, comments, etc.), and the
    // user's just-typed title from saveClipTitle isn't clobbered when the
    // server response comes back with displayTitle="Private Clip".
    //
    // The title cache is encrypted at rest now (device-cipher), so the read is
    // async. Seed the placeholder synchronously on a clip switch only — same-
    // clip refreshes (partner reactions/comments) must NOT reset to the
    // placeholder, or the title would flicker on every partner action. Swap in
    // the decrypted cached title once it resolves, guarded so a clip switch or
    // an in-flight edit mid-decrypt can't clobber the field.
    const firstSeed = lastSeededItemIdRef.current !== item.id;
    if (firstSeed) {
      lastSeededItemIdRef.current = item.id;
      setEditingTitle(false);
      setTitle(item.displayTitle);
    }
    if (firstSeed || !editingTitleRef.current) {
      let cancelled = false;
      readVaultTitleCache(workspaceId, item.id).then((cached) => {
        if (cancelled || !cached || editingTitleRef.current) return;
        setTitle(cached);
      });
      return () => { cancelled = true; };
    }
  }, [item.displayTitle, item.id, workspaceId]);

  useEffect(() => {
    if (!unlockKey) return;
    decryptItemSidecars(item, unlockKey, workspaceId)
      .then(({ titleText, decryptedComments, decryptedMoments }) => {
        // After the C-9 fix item.displayTitle is always the placeholder, so
        // the previous gate (`!item.displayTitle && titleText`) never fired
        // and the decrypted title never reached the UI. Show the decrypted
        // title whenever we have one and the user isn't actively editing.
        if (titleText && !editingTitleRef.current) setTitle(titleText);
        void rememberVaultTitle(workspaceId, item.id, titleText);
        setComments(decryptedComments);
        replaceFrameUrls(decryptedMoments.map((moment) => moment.frameUrl));
        setMoments(decryptedMoments);
        setStatus("");
      })
      .catch(() => {
        setStatus("Couldn't decrypt the latest Vault details with this passphrase.");
      });
    // Deliberately tracking granular fields instead of `item` itself: the
    // parent re-renders pass a fresh object reference even when nothing the
    // decrypt depends on changed, and decryption is expensive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.displayTitle, item.updatedAt, item.comments.length, item.moments.length, unlockKey, workspaceId]);

  useEffect(() => {
    // Reset the active-moment selection when the selected moment disappears
    // from the list (deleted by the partner via real-time push). Without
    // this, the lightbox would dangle pointing at a missing moment.
    if (activeMomentId && !moments.some((moment) => moment.id === activeMomentId)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveMomentId("");
    }
  }, [activeMomentId, moments]);

  useEffect(() => {
    if (!videoUrl) return;
    const video = videoRef.current;
    if (!video) return;
    video.defaultMuted = true;
    video.muted = true;
  }, [videoUrl]);

  useEffect(() => {
    return () => {
      if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
      frameUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  function replaceVideoUrl(url: string) {
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    videoUrlRef.current = url;
    setVideoUrl(url);
  }

  function replaceFrameUrls(urls: string[]) {
    frameUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    frameUrlsRef.current = urls;
  }

  async function unlockClip() {
    const secret = passphrase.trim();
    if (!secret || busy) return;
    setBusy("unlock");
    setStatus("Decrypting on this device.");
    try {
      // Derive the AES-GCM key once. From here we keep only the
      // non-extractable CryptoKey; the passphrase string is dropped from
      // local state immediately so it can be GC'd.
      const derivedKey = await deriveVaultUnlockKey(
        secret,
        item.encryption.salt,
        item.encryption.iterations,
      );
      const encrypted = await getVaultMedia({ workspaceId, id: item.id });
      const decrypted = await decryptVaultBlobWithKey(
        encrypted,
        derivedKey,
        item.encryption.videoIv,
        item.mediaType || "video/mp4",
        vaultAad({ workspaceId, itemId: item.id, purpose: "video" }),
      );
      replaceVideoUrl(URL.createObjectURL(decrypted));
      const { titleText, decryptedComments, decryptedMoments } =
        await decryptItemSidecars(item, derivedKey, workspaceId);
      replaceFrameUrls(decryptedMoments.map((moment) => moment.frameUrl));
      // displayTitle is now always the "Private Clip" placeholder; surface
      // the decrypted title from the encrypted ciphertext whenever we have
      // one. Legacy clips uploaded before the C-9 fix won't have a
      // ciphertext to decrypt, so the placeholder still shows for them
      // until the user renames the clip once.
      if (titleText) setTitle(titleText);
      void rememberVaultTitle(workspaceId, item.id, titleText);
      setComments(decryptedComments);
      setMoments(decryptedMoments);
      setUnlockKey(derivedKey);
      setPassphrase("");
      setStatus("Unlocked on this device.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn't unlock this clip.");
      setUnlockKey(null);
    } finally {
      setBusy("");
    }
  }

  function openClipLightbox() {
    if (!videoUrl) return;
    const video = videoRef.current;
    setClipLightboxStart(video?.currentTime || 0);
    video?.pause();
    setClipLightboxOpen(true);
  }

  function closeClipLightbox(currentTime = clipLightboxStart) {
    const video = videoRef.current;
    if (video && Number.isFinite(currentTime)) {
      video.currentTime = currentTime;
      video.defaultMuted = true;
      video.muted = true;
    }
    setClipLightboxOpen(false);
  }

  async function saveClipTitle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isMine || busy) return;
    if (!unlockKey) {
      // The server pins displayTitle and requires an encrypted title body for
      // every rename, so the clip must be unlocked first. Without the
      // derived key we can't produce that ciphertext.
      setStatus("Unlock this clip before renaming it.");
      return;
    }
    const cleanTitle = titleDraft.trim();
    setBusy("title-save");
    try {
      const encryptedTitle = await encryptVaultTextWithKey(
        cleanTitle,
        unlockKey,
        vaultAad({ workspaceId, itemId: item.id, purpose: "title" }),
      );
      const vault = await updateVaultTitle({
        workspaceId,
        id: item.id,
        titleCiphertext: encryptedTitle.ciphertext,
        titleIv: encryptedTitle.iv,
        titleVersion: encryptedTitle.v,
      });
      setTitle(cleanTitle);
      void rememberVaultTitle(workspaceId, item.id, cleanTitle);
      setEditingTitle(false);
      onVaultChange(vault);
      setStatus(cleanTitle ? "Title saved." : "Title cleared.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn't save that title.");
    } finally {
      setBusy("");
    }
  }

  async function react(option: ShelfReactionOption) {
    if (busy) return;
    // Snapshot the prior state so we can roll back on server error.
    const prior = propReaction;
    const next = myReaction === option.id ? null : option.id;
    setPendingReaction(next);
    setBusy(`reaction-${option.id}`);
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      try { navigator.vibrate(next ? [6, 16, 8] : 4); } catch { /* ignore */ }
    }
    try {
      const vault = await setVaultReaction({
        workspaceId,
        id: item.id,
        reaction: next,
      });
      onVaultChange(vault);
      // pendingReaction will clear automatically once the new prop arrives —
      // see the reconcile effect above. No need to clear here.
    } catch {
      // Server rejected the write. Roll back to whatever the prop said before
      // the optimistic flip.
      setPendingReaction(prior);
    } finally {
      setBusy("");
    }
  }

  async function submitComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = commentDraft.trim();
    if (!text || !unlockKey || busy) return;
    setBusy("comment");
    try {
      const commentId = crypto.randomUUID();
      const encrypted = await encryptVaultTextWithKey(
        text,
        unlockKey,
        vaultAad({ workspaceId, itemId: item.id, purpose: "comment", subId: commentId }),
      );
      const vault = await addVaultComment({
        workspaceId,
        id: item.id,
        commentId,
        commentCiphertext: encrypted.ciphertext,
        commentIv: encrypted.iv,
        commentVersion: encrypted.v,
      });
      setCommentDraft("");
      onVaultChange(vault);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn't send that comment.");
    } finally {
      setBusy("");
    }
  }

  async function captureMoment() {
    if (!unlockKey || busy) return;
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      setStatus("Play the clip before saving a moment.");
      return;
    }
    setBusy("moment");
    try {
      const momentId = crypto.randomUUID();
      const frame = await frameFromVideo(video);
      const encryptedFrame = await encryptVaultBlobWithKey(
        frame,
        unlockKey,
        item.encryption.salt,
        item.encryption.iterations,
        vaultAad({ workspaceId, itemId: item.id, purpose: "moment-frame", subId: momentId }),
      );
      const encryptedTitle = momentTitle.trim()
        ? await encryptVaultTextWithKey(
            momentTitle.trim(),
            unlockKey,
            vaultAad({ workspaceId, itemId: item.id, purpose: "moment-title", subId: momentId }),
          )
        : { ciphertext: "", iv: "" };
      const vault = await addVaultMoment({
        workspaceId,
        id: item.id,
        momentId,
        frame: encryptedFrame.blob,
        frameIv: encryptedFrame.iv,
        frameVersion: encryptedFrame.version,
        timestampMs: Math.round(video.currentTime * 1000),
        titleCiphertext: encryptedTitle.ciphertext,
        titleIv: encryptedTitle.iv,
        titleVersion: encryptedTitle.v,
      });
      setMomentTitle("");
      onVaultChange(vault);
      setStatus("Moment saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn't save that moment.");
    } finally {
      setBusy("");
    }
  }

  async function removeClip() {
    if (!isMine || busy) return;
    setBusy("delete");
    try {
      const vault = await deleteVaultItem({ workspaceId, id: item.id });
      onVaultChange(vault);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn't delete this clip.");
    } finally {
      setBusy("");
    }
  }

  function canDeleteMoment(moment: DecryptedMoment) {
    return isMine || normalizeEmail(moment.createdByEmail) === myEmail;
  }

  function startClipTitleEdit() {
    if (!canEditTitle) return;
    setTitleDraft(title);
    setEditingTitle(true);
  }

  function startMomentTitleEdit(moment: DecryptedMoment) {
    if (!canDeleteMoment(moment)) return;
    setEditingMomentTitleId(moment.id);
    setMomentTitleDraft(moment.titleText || "");
  }

  async function saveMomentTitle(event: FormEvent<HTMLFormElement>, moment: DecryptedMoment) {
    event.preventDefault();
    if (!unlockKey || !canDeleteMoment(moment) || busy) return;
    const cleanTitle = momentTitleDraft.trim();
    setBusy(`moment-title-${moment.id}`);
    try {
      const encryptedTitle = cleanTitle
        ? await encryptVaultTextWithKey(
            cleanTitle,
            unlockKey,
            vaultAad({ workspaceId, itemId: item.id, purpose: "moment-title", subId: moment.id }),
          )
        : { ciphertext: "", iv: "" };
      const vault = await updateVaultMomentTitle({
        workspaceId,
        id: item.id,
        momentId: moment.id,
        titleCiphertext: encryptedTitle.ciphertext,
        titleIv: encryptedTitle.iv,
        titleVersion: encryptedTitle.v,
      });
      setMoments((current) => current.map((entry) => entry.id === moment.id ? { ...entry, titleText: cleanTitle } : entry));
      setEditingMomentTitleId("");
      onVaultChange(vault);
      setStatus(cleanTitle ? "Moment title saved." : "Moment title cleared.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn't save that moment title.");
    } finally {
      setBusy("");
    }
  }

  async function removeMoment(moment: DecryptedMoment) {
    if (!canDeleteMoment(moment) || busy) return;
    const confirmed = await confirmAction({
      title: "Delete this moment?",
      body: "The saved screenshot, title, and note are removed for both partners.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(`moment-delete-${moment.id}`);
    try {
      const vault = await deleteVaultMoment({ workspaceId, id: item.id, momentId: moment.id });
      if (activeMomentId === moment.id) setActiveMomentId("");
      onVaultChange(vault);
      setStatus("Moment deleted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn't delete that moment.");
    } finally {
      setBusy("");
    }
  }

  return (
    <article
      ref={cardRef}
      className={`vault-card ${highlighted ? "is-activity-highlight" : ""} enter-rise`}
      data-activity-highlight={highlighted ? "true" : undefined}
    >
      <div className="vault-card-head">
        <div>
          {editingTitle ? (
            <form className="vault-title-editor" onSubmit={saveClipTitle}>
              <input
                className="input"
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                placeholder="Clip title"
                aria-label="Clip title"
                maxLength={120}
                autoFocus
                autoCapitalize="sentences"
                autoCorrect="on"
                spellCheck
                inputMode="text"
              />
              <div className="vault-title-actions">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    setTitleDraft(title);
                    setEditingTitle(false);
                  }}
                  disabled={Boolean(busy)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={Boolean(busy)}>
                  {busy === "title-save" ? "Saving" : "Save title"}
                </button>
              </div>
            </form>
          ) : (
            <div className="vault-title-row">
              {canEditTitle && (
                <button
                  type="button"
                  className="vault-card-title vault-title-edit-trigger pressable"
                  onClick={startClipTitleEdit}
                  aria-label="Edit Vault clip title"
                >
                  {title || "Private Clip"}
                </button>
              )}
              {!canEditTitle && <p className="vault-card-title">{title || "Private Clip"}</p>}
            </div>
          )}
          <p className="vault-card-meta">{item.addedByName || "Partner"} · {relativeAge(item.addedAt)} · {sizeLabel(item.originalSize || item.mediaSize)}</p>
        </div>
        {highlightedFromActivity && <span className="activity-arrival-badge">New in Activity</span>}
      </div>

      <div className={`vault-player ${videoUrl ? "is-unlocked" : ""}`}>
        {videoUrl ? (
          <div className="vault-video-shell">
            <video
              ref={videoRef}
              src={videoUrl}
              controls
              muted
              playsInline
              preload="metadata"
              controlsList="nodownload noplaybackrate"
              disablePictureInPicture
              onClick={(event) => {
                // The native control strip sits at the bottom of the video.
                // We want a click in the upper region to open the lightbox,
                // but a click on the control row to do its native thing.
                // Estimate the control strip height from the rendered video
                // height so we stop hardcoding 56 px (which over-reserves on
                // small phones in landscape, where the strip is closer to
                // 32 px).
                const rect = event.currentTarget.getBoundingClientRect();
                const controlStripPx = Math.min(56, Math.max(32, Math.round(rect.height * 0.18)));
                if (rect.bottom - event.clientY > controlStripPx) openClipLightbox();
              }}
            />
            <button
              type="button"
              className="vault-player-open pressable"
              onClick={openClipLightbox}
              aria-label="Open clip full screen"
            >
              Full screen
            </button>
          </div>
        ) : (
          <div className="vault-locked">
            <span className="vault-lock-mark" aria-hidden="true">••</span>
            <input
              className="input"
              type="password"
              name="ss-vault-passphrase-no-save"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder="Vault passphrase"
              aria-label="Vault passphrase"
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              spellCheck={false}
            />
            <button type="button" className="btn-primary pressable" onClick={unlockClip} disabled={!passphrase.trim() || busy === "unlock"}>
              {busy === "unlock" ? "Unlocking" : "Unlock"}
            </button>
          </div>
        )}
      </div>
      {isMine && (
        <div className="vault-clip-actions">
          <button type="button" className="vault-remove-clip pressable" onClick={removeClip} disabled={Boolean(busy)}>
            {busy === "delete" ? "Removing" : "Remove clip"}
          </button>
        </div>
      )}

      {unlockKey && (
        <>
          {partnerReaction && (
            <div className="partner-strip" role="status">
              <span className="partner-pulse" aria-hidden="true" />
              <span className="partner-text">
                <strong>Partner</strong>
                <span className="partner-react">
                  <span className="partner-react-emoji" aria-hidden="true">{partnerReaction.emoji}</span>
                  <em>{partnerReaction.label.toLowerCase()}</em>
                </span>
              </span>
            </div>
          )}

          <div className="live-caption" aria-live="polite">
            {active ? reactionCaption(active, "You") : "Choose how this lands."}
          </div>
          <div className="tray-wrap">
            <div className="tray" role="group" aria-label="React to this Vault clip">
              {catalog.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`reaction pressable ${myReaction === option.id ? "is-active" : ""} ${option.tone === "pass" ? "is-pass" : ""}`}
                  onClick={() => react(option)}
                  aria-pressed={myReaction === option.id}
                  aria-label={option.label}
                  disabled={Boolean(busy)}
                >
                  <span className="reaction-emoji">{option.emoji}</span>
                </button>
              ))}
            </div>
          </div>

          <section className="vault-moment-tools">
            <p className="eyebrow">Moment editor</p>
            <input
              className="input"
              value={momentTitle}
              onChange={(event) => setMomentTitle(event.target.value)}
              placeholder="Moment title"
              aria-label="Moment title"
              maxLength={120}
              autoCapitalize="none"
              autoCorrect="on"
              spellCheck
              inputMode="text"
            />
            <button type="button" className="btn-ghost pressable" onClick={captureMoment} disabled={Boolean(busy)}>
              {busy === "moment" ? "Saving moment" : "Save current moment"}
            </button>
          </section>
        </>
      )}

      {moments.length > 0 && (
        <section className="vault-moments">
          <p className="eyebrow">Moments · <em>{moments.length}</em></p>
          <div className="vault-moment-grid">
            {moments.map((moment) => (
              <figure key={moment.id} className="vault-moment">
                <button
                  type="button"
                  className="vault-moment-preview"
                  onClick={() => setActiveMomentId(moment.id)}
                  aria-label="Open saved moment"
                >
                  {/* next/image can't serve a blob: URL — moment frames are
                      client-decrypted from E2E-encrypted R2 bytes, so there's
                      no static URL the optimizer could reach. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {moment.frameUrl && <img src={moment.frameUrl} alt="" />}
                </button>
                {editingMomentTitleId === moment.id ? (
                  <form className="vault-moment-title-editor" onSubmit={(event) => saveMomentTitle(event, moment)}>
                    <input
                      className="input"
                      value={momentTitleDraft}
                      onChange={(event) => setMomentTitleDraft(event.target.value)}
                      placeholder="Moment title"
                      aria-label="Moment title"
                      maxLength={120}
                      autoFocus
                      autoCapitalize="sentences"
                      autoCorrect="on"
                      spellCheck
                      inputMode="text"
                    />
                    <div className="vault-moment-title-actions">
                      <button type="button" className="btn-ghost" onClick={() => setEditingMomentTitleId("")} disabled={Boolean(busy)}>
                        Cancel
                      </button>
                      <button type="submit" className="btn-primary" disabled={Boolean(busy)}>
                        {busy === `moment-title-${moment.id}` ? "Saving" : "Save"}
                      </button>
                    </div>
                  </form>
                ) : (moment.titleText || canDeleteMoment(moment)) && (
                  <figcaption>
                    {moment.titleText && <em>{moment.titleText}</em>}
                    {canDeleteMoment(moment) && (
                      <span className="vault-moment-actions">
                        <button
                          type="button"
                          className="vault-moment-delete"
                          onClick={() => startMomentTitleEdit(moment)}
                          disabled={Boolean(busy)}
                        >
                          {moment.titleText ? "Edit" : "Add title"}
                        </button>
                        <button
                          type="button"
                          className="vault-moment-delete"
                          onClick={() => removeMoment(moment)}
                          disabled={Boolean(busy)}
                        >
                          {busy === `moment-delete-${moment.id}` ? "Deleting" : "Delete"}
                        </button>
                      </span>
                    )}
                  </figcaption>
                )}
              </figure>
            ))}
          </div>
        </section>
      )}

      {unlockKey && (
        <section className="vault-comments">
          <p className="eyebrow">Comments · <em>{item.comments.length}</em></p>
          <div className="kd-thread">
            {comments.map((comment) => (
              <VaultCommentRow
                key={comment.id}
                comment={comment}
                mine={normalizeEmail(comment.email) === myEmail}
              />
            ))}
            <form className="kd-reply-form" onSubmit={submitComment}>
              <textarea
                className="input min-h-[92px] resize-none"
                value={commentDraft}
                onChange={(event) => setCommentDraft(event.target.value)}
                placeholder="+ Add a comment"
                aria-label="Add a comment"
                autoCapitalize="none"
                autoCorrect="on"
                spellCheck
                inputMode="text"
              />
              <div className="kd-reply-actions">
                <button type="submit" className="btn-ghost kd-comment-submit" disabled={!commentDraft.trim() || Boolean(busy)}>
                  {busy === "comment" ? "Adding" : "Add comment"}
                </button>
              </div>
            </form>
          </div>
        </section>
      )}

      {status && <p className="vault-status" role="status" aria-live="polite">{status}</p>}
      {clipLightboxOpen && videoUrl && (
        <VaultClipLightbox
          src={videoUrl}
          title={title || "Private Clip"}
          initialTime={clipLightboxStart}
          onClose={closeClipLightbox}
        />
      )}
      {activeMoment && (
        <VaultMomentLightbox
          moment={activeMoment}
          canDelete={canDeleteMoment(activeMoment)}
          deleting={busy === `moment-delete-${activeMoment.id}`}
          onClose={() => setActiveMomentId("")}
          onDelete={() => removeMoment(activeMoment)}
        />
      )}
    </article>
  );
}

// One decrypted comment in the thread. Memoized because the parent card
// re-renders on every optimistic reaction flash and prop refresh, but a
// given comment's rendered output only depends on its own (immutable) text
// and the `mine` flag — so identical re-renders can be skipped.
const VaultCommentRow = memo(function VaultCommentRow({
  comment,
  mine,
}: {
  comment: DecryptedComment;
  mine: boolean;
}) {
  return (
    <div className={`kd-msg ${mine ? "kd-msg-you" : "kd-msg-her"}`}>
      <p className="kd-msg-author">{comment.name || (mine ? "You" : "Partner")} · {relativeAge(comment.at)}</p>
      <p className="kd-msg-body">{comment.text}</p>
    </div>
  );
});

async function decryptItemSidecars(item: VaultItem, key: CryptoKey, workspaceId: string) {
  const [titleText, decryptedComments, decryptedMoments] = await Promise.all([
    decryptVaultTextWithKey(item.title, key, vaultAad({ workspaceId, itemId: item.id, purpose: "title" })).catch(() => ""),
    Promise.all((item.comments || []).map(async (comment) => ({
      ...comment,
      text: await decryptVaultTextWithKey(
        comment.body,
        key,
        vaultAad({ workspaceId, itemId: item.id, purpose: "comment", subId: comment.id }),
      ),
    }))),
    Promise.all((item.moments || []).map(async (moment) => {
      const [frameBlob, titleText, noteText] = await Promise.all([
        getVaultMedia({ workspaceId, id: item.id, kind: "moment", momentId: moment.id })
          .then((encrypted) => decryptVaultBlobWithKey(
            encrypted,
            key,
            moment.frameIv,
            "image/png",
            vaultAad({ workspaceId, itemId: item.id, purpose: "moment-frame", subId: moment.id }),
          )),
        decryptVaultTextWithKey(
          moment.title,
          key,
          vaultAad({ workspaceId, itemId: item.id, purpose: "moment-title", subId: moment.id }),
        ).catch(() => ""),
        decryptVaultTextWithKey(
          moment.note,
          key,
          vaultAad({ workspaceId, itemId: item.id, purpose: "moment-note", subId: moment.id }),
        ).catch(() => ""),
      ]);
      return {
        ...moment,
        titleText: titleText || noteText,
        noteText,
        frameUrl: URL.createObjectURL(frameBlob),
      };
    })),
  ]);
  return { titleText, decryptedComments, decryptedMoments };
}
