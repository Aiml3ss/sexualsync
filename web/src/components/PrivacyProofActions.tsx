"use client";

import { useState } from "react";
import Link from "next/link";
import { downloadCurrentWorkspaceData } from "@/lib/data-export";

export default function PrivacyProofActions() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function downloadData() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await downloadCurrentWorkspaceData();
      setMessage("Export prepared on this device.");
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "Could not prepare the export.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="settings-card privacy-proof-card">
        <button type="button" className="settings-link pressable" onClick={() => void downloadData()} disabled={busy}>
          <span>
            Download my data
            <span className="settings-link-sub">JSON export of profile, shared room data, Vault metadata, and private notes from this browser.</span>
          </span>
          <span className="settings-link-chev">{busy ? "..." : "›"}</span>
        </button>
        <Link href="/space/notes" className="settings-link pressable">
          <span>
            What stays on this device
            <span className="settings-link-sub">Open local private notes; they are not synced unless you share one.</span>
          </span>
          <span className="settings-link-chev">›</span>
        </Link>
        <Link href="/space/vault" className="settings-link pressable">
          <span>
            What is encrypted
            <span className="settings-link-sub">Open Vault, where media and private text are encrypted before upload.</span>
          </span>
          <span className="settings-link-chev">›</span>
        </Link>
        <Link href="/more" className="settings-link pressable">
          <span>
            How deletion works
            <span className="settings-link-sub">Closing the space gives both partners seven days to undo before room data is purged.</span>
          </span>
          <span className="settings-link-chev">›</span>
        </Link>
      </div>
      {(message || error) && (
        <p className={`privacy-proof-status ${error ? "is-error" : ""}`} role="status">
          {error || message}
        </p>
      )}
    </>
  );
}
