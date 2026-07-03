"use client";

/**
 * Add-private-video composer at the top of the Vault page.
 *
 * Encrypts the chosen file in the browser with a passphrase-derived key,
 * then uploads the ciphertext + encrypted title. The plaintext title and
 * passphrase never leave the device (the passphrase is even dropped from
 * local state as soon as the AES-GCM key is derived). Discrete progress
 * meter ticks the user through encrypt → upload → save.
 *
 * Split out of `vault/page.tsx` as part of H-1.
 */

import { type FormEvent, useRef, useState } from "react";
import { uploadVaultClip } from "@/lib/api";
import type { VaultResponse } from "@/lib/types";
import {
  deriveVaultUnlockKey,
  encryptVaultBlobWithKey,
  encryptVaultTextWithKey,
  randomBase64,
  vaultAad,
  VAULT_CRYPTO_VERSION,
  VAULT_KDF_ITERATIONS,
} from "@/lib/vault-crypto";
import {
  VAULT_IOS_FILE_UNREADABLE_MESSAGE,
  readVideoDurationMs,
  rememberVaultTitle,
  vaultMediaTypeForFile,
  vaultUploadErrorMessage,
} from "./_vault-helpers";
import { stripVideoLocationMetadata } from "@/lib/video-location-strip";

const MAX_VAULT_ORIGINAL_VIDEO_BYTES = 100 * 1024 * 1024 - 1024;

export function VaultComposer({
  workspaceId,
  onVaultChange,
}: {
  workspaceId: string;
  onVaultChange: (vault: VaultResponse) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  // Keep a small status history so multi-step flows (encrypt → upload → save)
  // don't visually collapse to the last message. Render the most recent
  // message prominently and the prior step or two underneath, fading out.
  const [statusHistory, setStatusHistory] = useState<string[]>([]);
  // Discrete progress meter for the encrypt → upload → save flow. We can't
  // get real upload % out of fetch() and we don't time PBKDF2/encrypt
  // accurately enough to interpolate, so the bar advances in three steps.
  // Better than a spinner because the user can see what stage they're on.
  const [progressPct, setProgressPct] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function setStatus(message: string) {
    setStatusHistory((current) => {
      if (!message) return [];
      const recent = current.slice(-2);
      // Drop adjacent duplicates so accidental double-set doesn't show twice.
      if (recent[recent.length - 1] === message) return recent;
      return [...recent, message];
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || busy) return;
    if (!passphrase.trim()) {
      setStatus("Enter the shared Vault passphrase first.");
      return;
    }
    if (file.size <= 0) {
      setStatus(VAULT_IOS_FILE_UNREADABLE_MESSAGE);
      return;
    }
    if (file.size > MAX_VAULT_ORIGINAL_VIDEO_BYTES) {
      setStatus("Vault clips need to be under 100 MB.");
      return;
    }
    let mediaType = "";
    try {
      mediaType = await vaultMediaTypeForFile(file);
    } catch {
      setStatus(VAULT_IOS_FILE_UNREADABLE_MESSAGE);
      return;
    }
    if (!mediaType) {
      setStatus("Use an MP4, MOV, or WebM video file.");
      return;
    }
    setBusy(true);
    setProgressPct(5);
    setStatus("Encrypting on this device.");
    try {
      // Blank GPS location atoms (©xyz / com.apple.quicktime.location.*)
      // inside MP4/MOV containers BEFORE encryption — iPhone clips otherwise
      // carry the recording coordinates into the partner's decrypted copy.
      // Same-size in-place patch; any parse anomaly falls back to the
      // original bytes so an unusual file can never be corrupted.
      // Skip only the Matroska family (different container, geotags absent);
      // every ISO-BMFF MIME variant (mp4/quicktime/x-m4v/...) goes through,
      // and the stripper returns the original for anything it can't parse.
      let uploadSource: Blob = file;
      if (mediaType !== "video/webm" && mediaType !== "video/x-matroska") {
        uploadSource = (await stripVideoLocationMetadata(file)).blob;
      }
      const salt = randomBase64(16);
      const itemId = crypto.randomUUID();
      // Derive once, then drop the passphrase string from local state so the
      // hot path only carries an opaque non-extractable CryptoKey.
      const composerKey = await deriveVaultUnlockKey(passphrase, salt, VAULT_KDF_ITERATIONS);
      setPassphrase("");
      setProgressPct(25);
      const encryptedVideo = await encryptVaultBlobWithKey(
        uploadSource,
        composerKey,
        salt,
        VAULT_KDF_ITERATIONS,
        vaultAad({ workspaceId, itemId, purpose: "video" }),
      );
      const encryptedTitle = title.trim()
        ? await encryptVaultTextWithKey(title.trim(), composerKey, vaultAad({ workspaceId, itemId, purpose: "title" }))
        : { ciphertext: "", iv: "" };
      setProgressPct(55);
      setStatus("Uploading encrypted clip.");
      // Plaintext clip title is never sent — the server pins displayTitle to
      // "Private Clip" and stores only the encrypted title we hand it here.
      const vault = await uploadVaultClip({
        workspaceId,
        id: itemId,
        file: encryptedVideo.blob,
        mediaType,
        originalName: file.name,
        originalSize: file.size,
        durationMs: await readVideoDurationMs(file),
        salt,
        videoIv: encryptedVideo.iv,
        encryptionVersion: encryptedVideo.version || VAULT_CRYPTO_VERSION,
        iterations: encryptedVideo.iterations,
        titleCiphertext: encryptedTitle.ciphertext,
        titleIv: encryptedTitle.iv,
        titleVersion: encryptedTitle.v,
      });
      if (vault.item?.id) void rememberVaultTitle(workspaceId, vault.item.id, title.trim());
      onVaultChange(vault);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setTitle("");
      setPassphrase("");
      setProgressPct(100);
      setStatus("Encrypted clip saved.");
    } catch (error) {
      setProgressPct(0);
      setStatus(vaultUploadErrorMessage(error));
    } finally {
      setBusy(false);
      // Hold the full bar for a beat so the user registers success, then drop
      // it back so the next upload starts fresh.
      window.setTimeout(() => setProgressPct(0), 1200);
    }
  }

  return (
    <section className="vault-section vault-upload">
      <p className="eyebrow">Add private video</p>
      <form className="vault-upload-form" onSubmit={submit}>
        <label className="vault-file-picker pressable">
          <span>{file ? file.name : "Choose video"}</span>
          <input
            ref={fileInputRef}
            type="file"
            accept="video/mp4,video/quicktime,video/webm,video/3gpp,video/3gpp2,.mp4,.m4v,.mov,.qt,.webm,.3gp,.3g2,video/*"
            onChange={(event) => {
              const nextFile = event.target.files?.[0] || null;
              setFile(nextFile);
              if (nextFile) setStatus("");
            }}
          />
        </label>
        <input
          className="input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Private title"
          aria-label="Private title"
          maxLength={120}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
        />
        <input
          className="input"
          type="password"
          name="ss-vault-passphrase-no-save"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          placeholder="Shared Vault passphrase"
          aria-label="Shared Vault passphrase"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore="true"
          data-lpignore="true"
        />
        <p className="vault-passphrase-hint">Don&apos;t save this to iCloud Keychain or a password manager.</p>
        <button type="submit" className="btn-primary pressable vault-upload-submit" disabled={!file || !passphrase.trim() || busy}>
          {busy ? "Saving" : "Encrypt and save"}
        </button>
        {(busy || progressPct > 0) && (
          <div className="vault-progress-row" role="status" aria-live="polite">
            <progress
              className="vault-progress"
              value={progressPct}
              max={100}
              aria-label={`Upload progress ${progressPct}%`}
            />
            <span className="vault-progress-percent">{progressPct}%</span>
          </div>
        )}
        {statusHistory.length > 0 && (
          <ul className="vault-status-stack" aria-live="polite">
            {statusHistory.map((message, index) => {
              const isCurrent = index === statusHistory.length - 1;
              return (
                <li key={`${index}-${message}`} className={isCurrent ? "vault-status vault-status-current" : "vault-status vault-status-past"}>
                  {message}
                </li>
              );
            })}
          </ul>
        )}
      </form>
    </section>
  );
}
