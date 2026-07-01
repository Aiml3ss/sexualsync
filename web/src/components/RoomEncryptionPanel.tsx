"use client";

import { useEffect, useState } from "react";
import { getActiveRoomKdfVersion, recoverRoomE2eeFromServerData, updateWorkspaceSettings } from "@/lib/api";
import { getProfileCached } from "@/lib/profile-cache";
import {
  createRoomE2eeVerifier,
  disableRoomE2ee,
  generateRoomPassphrase,
  hasUnlockedRoomE2eeKey,
  isRoomEncryptedBox,
  isRoomE2eeEnabled,
  lockRoomE2ee,
  ROOM_E2EE_DEVICE_UNLOCK_DAYS,
  setRoomE2eeEnabled as setRoomFlag,
  type RoomEncryptedBox,
  unlockRoomE2ee,
} from "@/lib/room-crypto";

interface PanelState {
  workspaceId: string;
  workspaceName: string;
  enabled: boolean;
  serverEnabled: boolean;
  verifier?: RoomEncryptedBox;
  unlocked: boolean;
}

function emptyState(): PanelState {
  return {
    workspaceId: "",
    workspaceName: "",
    enabled: false,
    serverEnabled: false,
    verifier: undefined,
    unlocked: false,
  };
}

function readVerifier(value: unknown): RoomEncryptedBox | undefined {
  return isRoomEncryptedBox(value) ? value : undefined;
}

export default function RoomEncryptionPanel() {
  const [state, setState] = useState<PanelState>(emptyState);
  const [passphrase, setPassphrase] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoverExpanded, setRecoverExpanded] = useState(false);
  const [recoveryPassphrase, setRecoveryPassphrase] = useState("");
  // Whether the passphrase form is revealed while turning encryption on. Once
  // enabled, the form's visibility is driven by lock state instead.
  const [expanded, setExpanded] = useState(false);

  function refresh(
    workspaceId = state.workspaceId,
    workspaceName = state.workspaceName,
    serverEnabled = state.serverEnabled,
    verifier = state.verifier,
  ) {
    if (!workspaceId) {
      setState(emptyState());
      return;
    }
    if (serverEnabled && !isRoomE2eeEnabled(workspaceId)) {
      setRoomFlag(workspaceId, true);
    }
    const localEnabled = isRoomE2eeEnabled(workspaceId);
    setState({
      workspaceId,
      workspaceName,
      enabled: serverEnabled || localEnabled,
      serverEnabled,
      verifier,
      unlocked: hasUnlockedRoomE2eeKey(workspaceId),
    });
  }

  useEffect(() => {
    let cancelled = false;
    getProfileCached()
      .then((profile) => {
        if (cancelled) return;
        const workspace = profile.activeWorkspace;
        refresh(
          workspace?.id || "",
          workspace?.displayName || workspace?.name || "Your room",
          Boolean(workspace?.settings?.roomE2eeEnabled),
          readVerifier(workspace?.settings?.roomE2eeVerifier),
        );
      })
      .catch(() => {
        if (!cancelled) setStatus("Sign in and choose a room first.");
      });

    function onChange(event: Event) {
      const detail = (event as CustomEvent<{ workspaceId?: string }>).detail;
      if (!detail?.workspaceId || detail.workspaceId === state.workspaceId) refresh(detail?.workspaceId);
    }
    window.addEventListener("ss:room-e2ee-change", onChange);
    return () => {
      cancelled = true;
      window.removeEventListener("ss:room-e2ee-change", onChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.workspaceId]);

  async function unlock() {
    if (!state.workspaceId || busy) return;
    setBusy(true);
    setStatus("");
    try {
      // Turning encryption on (no verifier yet) mints the room at this deploy's
      // active KDF version; unlocking an existing room ignores it and derives at
      // the version frozen into the stored verifier.
      const kdfVersion = state.verifier ? "v1" : await getActiveRoomKdfVersion();
      let nextVerifier = state.verifier;
      let recovered = 0;
      try {
        await unlockRoomE2ee(state.workspaceId, passphrase, state.verifier, kdfVersion);
        nextVerifier = state.verifier || await createRoomE2eeVerifier(state.workspaceId);
      } catch (unlockError) {
        if (!state.verifier) throw unlockError;
        const result = await recoverRoomE2eeFromServerData(state.workspaceId, passphrase);
        recovered = result.verified;
        nextVerifier = await createRoomE2eeVerifier(state.workspaceId);
      }
      if (!nextVerifier) throw new Error("Couldn't create the room verifier.");
      if (!state.serverEnabled || !state.verifier || recovered) {
        await updateWorkspaceSettings({
          workspaceId: state.workspaceId,
          roomE2eeEnabled: true,
          roomE2eeVerifier: nextVerifier,
        });
      }
      const profile = await getProfileCached({ force: true });
      const workspace = profile.activeWorkspace;
      const profileVerifier = readVerifier(workspace?.settings?.roomE2eeVerifier);
      setPassphrase("");
      setExpanded(false);
      refresh(
        state.workspaceId,
        workspace?.id === state.workspaceId
          ? workspace.displayName || workspace.name || state.workspaceName
          : state.workspaceName,
        workspace?.id === state.workspaceId ? Boolean(workspace.settings?.roomE2eeEnabled) : true,
        profileVerifier || nextVerifier,
      );
      setStatus(recovered
        ? `Recovered Room Encryption (${recovered} encrypted checks matched). This device stays unlocked for ${ROOM_E2EE_DEVICE_UNLOCK_DAYS} days unless you lock it.`
        : `Room Encryption is on. This device stays unlocked for ${ROOM_E2EE_DEVICE_UNLOCK_DAYS} days unless you lock it.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn't unlock Room Encryption.");
    } finally {
      setBusy(false);
    }
  }

  function lock() {
    if (!state.workspaceId) return;
    lockRoomE2ee(state.workspaceId);
    refresh();
    setStatus("Room Encryption locked on this device.");
  }

  function suggestPassphrase() {
    setPassphrase(generateRoomPassphrase());
    setExpanded(true);
    setStatus("");
  }

  async function recoverOldData() {
    if (!state.workspaceId || busy) return;
    setBusy(true);
    setStatus("");
    try {
      const result = await recoverRoomE2eeFromServerData(state.workspaceId, recoveryPassphrase);
      const nextVerifier = await createRoomE2eeVerifier(state.workspaceId);
      await updateWorkspaceSettings({
        workspaceId: state.workspaceId,
        roomE2eeEnabled: true,
        roomE2eeVerifier: nextVerifier,
      });
      const profile = await getProfileCached({ force: true });
      const workspace = profile.activeWorkspace;
      const profileVerifier = readVerifier(workspace?.settings?.roomE2eeVerifier);
      setPassphrase("");
      setRecoveryPassphrase("");
      setRecoverExpanded(false);
      setExpanded(false);
      refresh(
        state.workspaceId,
        workspace?.id === state.workspaceId
          ? workspace.displayName || workspace.name || state.workspaceName
          : state.workspaceName,
        true,
        profileVerifier || nextVerifier,
      );
      setStatus(`Recovered Room Encryption with your old passphrase (${result.verified} encrypted checks matched). Refresh the data page.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn't recover encrypted room data.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!state.workspaceId || busy) return;
    setBusy(true);
    setStatus("");
    try {
      await updateWorkspaceSettings({
        workspaceId: state.workspaceId,
        roomE2eeEnabled: false,
      });
      disableRoomE2ee(state.workspaceId);
      const profile = await getProfileCached({ force: true });
      const workspace = profile.activeWorkspace;
      const profileVerifier = readVerifier(workspace?.settings?.roomE2eeVerifier);
      setPassphrase("");
      setExpanded(false);
      refresh(
        state.workspaceId,
        workspace?.id === state.workspaceId
          ? workspace.displayName || workspace.name || state.workspaceName
          : state.workspaceName,
        false,
        profileVerifier || state.verifier,
      );
      setStatus("Room Encryption is off for new writes. Existing encrypted items still need the passphrase.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn't turn off Room Encryption.");
    } finally {
      setBusy(false);
    }
  }

  function onToggle() {
    if (busy || !state.workspaceId) return;
    setStatus("");
    if (state.enabled) {
      // Flipping the switch off turns encryption off for new writes.
      void disable();
    } else {
      // Can't enable without a passphrase — reveal the form to capture one.
      setExpanded((value) => !value);
    }
  }

  // The form shows when the user is turning encryption on (expanded) or when
  // it's on but locked on this device and needs the passphrase to unlock.
  const showForm = (!state.enabled && expanded) || (state.enabled && !state.unlocked);
  const switchOn = state.enabled || expanded;

  const subText = state.enabled
    ? state.unlocked
      ? `On · unlocked on this device for ${ROOM_E2EE_DEVICE_UNLOCK_DAYS} days.`
      : "On · locked on this device."
    : "End-to-end encrypt new room writes. Only the passphrase can read them — not us.";

  return (
    <div className={`settings-card room-encryption-card ${state.enabled ? "is-enabled" : ""} ${state.unlocked ? "is-unlocked" : ""}`}>
      <div className="settings-row room-encryption-row">
        <span>
          <span className="settings-row-title">Room Encryption</span>
          <span className="settings-row-sub">{subText}</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={switchOn}
          aria-label="Room Encryption"
          className={`switch pressable ${switchOn ? "is-on" : ""}`}
          disabled={busy || !state.workspaceId}
          onClick={onToggle}
        >
          <span className="switch-thumb" />
        </button>
      </div>

      {showForm && (
        <div className="room-encryption-reveal">
          <p className="room-encryption-hint">
            {state.enabled
              ? "Enter the room passphrase to unlock it on this device."
              : state.verifier
                ? "Enter the existing room passphrase to turn Room Encryption back on."
              : "Pick a passphrase. Every device in the room enters the same one — we never see it."}
          </p>
          <div className="room-encryption-form">
            <input
              className="input room-encryption-input"
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder={state.enabled || state.verifier ? "Room passphrase" : "Create room passphrase"}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
            />
            <button type="button" className="btn-primary pressable room-encryption-primary" disabled={!passphrase.trim() || busy || !state.workspaceId} onClick={unlock}>
              {state.enabled ? "Unlock" : "Turn on"}
            </button>
          </div>
          {!state.enabled && !state.verifier && (
            <button
              type="button"
              className="btn-ghost pressable room-encryption-generate"
              disabled={busy || !state.workspaceId}
              onClick={suggestPassphrase}
            >
              Suggest a strong passphrase
            </button>
          )}
        </div>
      )}

      {state.workspaceId && (
        <div className="room-encryption-reveal">
          {state.enabled && state.unlocked && (
            <button type="button" className="btn-ghost pressable room-encryption-lock" disabled={busy} onClick={lock}>
              Lock this device
            </button>
          )}
          <button
            type="button"
            className="btn-ghost pressable room-encryption-lock"
            disabled={busy}
            onClick={() => {
              setRecoverExpanded((value) => !value);
              setStatus("");
            }}
          >
            Recover old encrypted data
          </button>
          {recoverExpanded && (
            <>
              <p className="room-encryption-hint">
                Use this if old items still say &quot;Encrypted - unlock in Privacy.&quot; Your passphrase stays in this browser and repairs the room verifier.
              </p>
              <div className="room-encryption-form">
                <input
                  className="input room-encryption-input"
                  type="password"
                  value={recoveryPassphrase}
                  onChange={(event) => setRecoveryPassphrase(event.target.value)}
                  placeholder="Old room passphrase"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn-primary pressable room-encryption-primary"
                  disabled={!recoveryPassphrase.trim() || busy || !state.workspaceId}
                  onClick={recoverOldData}
                >
                  Recover
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {status && <p className="room-encryption-message">{status}</p>}
    </div>
  );
}
