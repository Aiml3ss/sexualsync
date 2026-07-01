"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { ApiUnauthorizedError, recoverRoomE2eeFromServerData, updateWorkspaceSettings } from "@/lib/api";
import { markIntentionalSignOut } from "@/lib/auth-state";
import { ensureLaunchAuthenticated, launchReauthRecentlyAttempted, markLaunchAuthenticated, recordLaunchReauthAttempt } from "@/lib/launch-auth";
import { getProfileCached } from "@/lib/profile-cache";
import {
  clearRoomE2eeKeyCache,
  createRoomE2eeVerifier,
  hasUnlockedRoomE2eeKey,
  isRoomEncryptedBox,
  isRoomE2eeEnabled,
  lockRoomE2ee,
  markRoomE2eeAway,
  ROOM_E2EE_DEVICE_UNLOCK_DAYS,
  ROOM_E2EE_SESSION_RELOCK_MS,
  restoreRoomE2eeSession,
  setRoomE2eeEnabled,
  unlockRoomE2ee,
  clearRoomE2eeAway,
} from "@/lib/room-crypto";
import type { Workspace } from "@/lib/types";
import { clearVaultKeyCache } from "@/lib/vault-crypto";
import "./lock-overlay.css";

const PROTECTED_PREFIXES = [
  "/admin",
  "/ask",
  "/ask-detail",
  "/chat",
  "/games",
  "/ideas",
  "/inspiration",
  "/limits",
  "/more",
  "/mutual",
  "/review",
  "/sexboard",
  "/space",
  "/tonight",
];

type GateState =
  | { kind: "checking" }
  | { kind: "open" }
  | { kind: "locked"; workspace: Workspace };

function isProtectedPath(pathname: string) {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function roomRequiresUnlock(workspace: Workspace | null | undefined) {
  if (!workspace?.id) return false;
  return Boolean(workspace.settings?.roomE2eeEnabled) || isRoomE2eeEnabled(workspace.id);
}

function beginLaunchReauth() {
  clearRoomE2eeKeyCache();
  clearVaultKeyCache();
  markIntentionalSignOut();
  window.location.replace("/api/auth/logout");
}

export default function RoomEncryptionGate({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/";
  const [state, setState] = useState<GateState>({ kind: "checking" });
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const workspaceRef = useRef<Workspace | null>(null);
  const awayStartedAtRef = useRef<number | null>(null);
  const heroStageRef = useRef<HTMLDivElement | null>(null);
  const heroSvgRef = useRef<SVGSVGElement | null>(null);
  const hasResolvedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      if (!isProtectedPath(pathname)) {
        hasResolvedRef.current = true;
        setState({ kind: "open" });
        return;
      }
      // Only blank to "checking" on the very first resolution (cold load).
      // Re-entering it on every navigation unmounted the whole page tree —
      // children mounted, swapped for the holding div, then mounted again —
      // which double-fired every page's data fetch and reconnected the live
      // room socket per nav. Staying on the current state while this check
      // runs keeps children mounted; a failed check still flips to "locked"
      // (and the visibility/relock listeners cover key drops between navs).
      if (!hasResolvedRef.current) setState({ kind: "checking" });
      try {
        const profile = await getProfileCached();
        if (cancelled) return;
        const workspace = profile.activeWorkspace;
        workspaceRef.current = workspace;
        if (!ensureLaunchAuthenticated()) {
          // Reauth at most once per launch — never loop. If we already forced a
          // reauth moments ago (the launch marker didn't survive in this PWA,
          // e.g. partitioned sessionStorage), trust the still-valid session and
          // proceed instead of logging out again into an endless sign-in loop.
          if (workspace?.settings?.reauthOnLaunch !== false && !launchReauthRecentlyAttempted()) {
            recordLaunchReauthAttempt();
            beginLaunchReauth();
            return;
          }
          markLaunchAuthenticated();
        }
        const hasRoomKey = workspace
          ? hasUnlockedRoomE2eeKey(workspace.id) || await restoreRoomE2eeSession(workspace.id)
          : false;
        if (workspace?.settings?.roomE2eeEnabled) setRoomE2eeEnabled(workspace.id, true);
        hasResolvedRef.current = true;
        if (roomRequiresUnlock(workspace) && workspace && !hasRoomKey) {
          setState({ kind: "locked", workspace });
          return;
        }
        setState({ kind: "open" });
      } catch (caught) {
        if (cancelled) return;
        hasResolvedRef.current = true;
        if (caught instanceof ApiUnauthorizedError) {
          setState({ kind: "open" });
          return;
        }
        setState({ kind: "open" });
      }
    }
    check();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  useEffect(() => {
    function relock() {
      const workspace = workspaceRef.current;
      if (!workspace?.id || !roomRequiresUnlock(workspace)) return;
      lockRoomE2ee(workspace.id);
      if (isProtectedPath(window.location.pathname)) {
        setState({ kind: "locked", workspace });
      }
    }

    function stampAway() {
      const workspace = workspaceRef.current;
      if (!workspace?.id || !roomRequiresUnlock(workspace)) return;
      awayStartedAtRef.current = Date.now();
      markRoomE2eeAway();
    }

    function reconcile() {
      const workspace = workspaceRef.current;
      if (!workspace?.id || !roomRequiresUnlock(workspace)) return;
      if (!hasUnlockedRoomE2eeKey(workspace.id)) {
        if (isProtectedPath(window.location.pathname)) setState({ kind: "locked", workspace });
        return;
      }
      const awayStartedAt = awayStartedAtRef.current;
      awayStartedAtRef.current = null;
      if (awayStartedAt && Date.now() - awayStartedAt > ROOM_E2EE_SESSION_RELOCK_MS) {
        relock();
        return;
      }
      clearRoomE2eeAway();
    }

    function onVisibility() {
      if (document.visibilityState === "hidden") stampAway();
      else reconcile();
    }

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", stampAway);
    window.addEventListener("freeze", stampAway);
    window.addEventListener("blur", stampAway);
    window.addEventListener("pageshow", reconcile);
    window.addEventListener("focus", reconcile);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", stampAway);
      window.removeEventListener("freeze", stampAway);
      window.removeEventListener("blur", stampAway);
      window.removeEventListener("pageshow", reconcile);
      window.removeEventListener("focus", reconcile);
    };
  }, []);

  useEffect(() => {
    function onRoomEncryptionChange(event: Event) {
      const detail = (event as CustomEvent<{ workspaceId?: string; enabled?: boolean }>).detail;
      const workspace = workspaceRef.current;
      if (!workspace?.id) return;
      if (detail?.workspaceId && detail.workspaceId !== workspace.id) return;
      if (!isProtectedPath(window.location.pathname)) return;

      if (detail?.enabled === false) {
        getProfileCached({ force: true })
          .then((profile) => {
            workspaceRef.current = profile.activeWorkspace;
            setState({ kind: "open" });
          })
          .catch(() => setState({ kind: "open" }));
        return;
      }

      if (roomRequiresUnlock(workspace) && !hasUnlockedRoomE2eeKey(workspace.id)) {
        setState({ kind: "locked", workspace });
      }
    }

    window.addEventListener("ss:room-e2ee-change", onRoomEncryptionChange);
    return () => {
      window.removeEventListener("ss:room-e2ee-change", onRoomEncryptionChange);
    };
  }, []);

  // Drives the locked-screen brand hero: seeds each stroke's dash length so it
  // can "draw on", and runs a damped pointer parallax on the whole surface so
  // the wave mark tilts toward the cursor. No-op until the locked view mounts.
  useEffect(() => {
    if (state.kind !== "locked") return;
    heroSvgRef.current
      ?.querySelectorAll<SVGGeometryElement>("[data-draw]")
      .forEach((node) => node.style.setProperty("--L", String(Math.ceil(node.getTotalLength()))));

    const stage = heroStageRef.current;
    const surface = stage?.closest<HTMLElement>(".lock-overlay") ?? stage;
    if (!stage || !surface) return;

    const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = reduceQuery.matches;
    let raf = 0;
    let tx = 0;
    let ty = 0;
    let cx = 0;
    let cy = 0;
    const settle = () => {
      tx = ty = cx = cy = 0;
      stage.style.setProperty("--tx", "0");
      stage.style.setProperty("--ty", "0");
    };
    const onMotionChange = () => {
      reduced = reduceQuery.matches;
      if (reduced) settle();
    };
    const onMove = (event: PointerEvent) => {
      if (reduced) return;
      const rect = surface.getBoundingClientRect();
      tx = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
      ty = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
    };
    const tick = () => {
      if (!reduced) {
        cx += (tx - cx) * 0.06;
        cy += (ty - cy) * 0.06;
        stage.style.setProperty("--tx", cx.toFixed(3));
        stage.style.setProperty("--ty", cy.toFixed(3));
      }
      raf = requestAnimationFrame(tick);
    };

    surface.addEventListener("pointermove", onMove);
    surface.addEventListener("pointerleave", settle);
    reduceQuery.addEventListener("change", onMotionChange);
    raf = requestAnimationFrame(tick);
    return () => {
      surface.removeEventListener("pointermove", onMove);
      surface.removeEventListener("pointerleave", settle);
      reduceQuery.removeEventListener("change", onMotionChange);
      cancelAnimationFrame(raf);
    };
  }, [state.kind]);

  async function unlock() {
    if (state.kind !== "locked" || busy) return;
    setBusy(true);
    setError("");
    try {
      const verifier = isRoomEncryptedBox(state.workspace.settings?.roomE2eeVerifier)
        ? state.workspace.settings.roomE2eeVerifier
        : undefined;
      try {
        await unlockRoomE2ee(state.workspace.id, passphrase, verifier);
        if (!verifier && state.workspace.settings?.roomE2eeEnabled) {
          const nextVerifier = await createRoomE2eeVerifier(state.workspace.id);
          await updateWorkspaceSettings({
            workspaceId: state.workspace.id,
            roomE2eeEnabled: true,
            roomE2eeVerifier: nextVerifier,
          });
          const profile = await getProfileCached({ force: true });
          workspaceRef.current = profile.activeWorkspace;
        }
      } catch (unlockError) {
        if (!verifier) throw unlockError;
        await recoverRoomE2eeFromServerData(state.workspace.id, passphrase);
        const nextVerifier = await createRoomE2eeVerifier(state.workspace.id);
        await updateWorkspaceSettings({
          workspaceId: state.workspace.id,
          roomE2eeEnabled: true,
          roomE2eeVerifier: nextVerifier,
        });
        const profile = await getProfileCached({ force: true });
        workspaceRef.current = profile.activeWorkspace;
      }
      setPassphrase("");
      setState({ kind: "open" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't unlock or recover this room.");
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === "checking") {
    return <div className="app-lock-gate-holding" aria-hidden="true" />;
  }

  if (state.kind === "locked") {
    return (
      <div className="lock-overlay lock-overlay-room" role="dialog" aria-modal="true" aria-label="Room locked">
        <div className="lock-overlay-atmosphere" aria-hidden="true">
          <div className="lock-overlay-bloom" />
          <div className="lock-overlay-grain" />
        </div>
        <section className="lock-overlay-card">
          <div className="lock-hero" ref={heroStageRef} aria-hidden="true">
            <div className="lock-hero-tilt">
              <div className="lock-hero-aura" />
              <div className="lock-hero-bloom" />
              <div className="lock-hero-pulse" />
              <svg
                ref={heroSvgRef}
                className="lock-hero-svg"
                viewBox="0 0 200 200"
                fill="none"
                focusable="false"
                aria-hidden="true"
              >
                <circle className="lock-hero-ring-ghost" cx="100" cy="100" r="82" />
                <circle data-draw className="lock-hero-ring" cx="100" cy="100" r="82" />
                <path
                  data-draw
                  className="lock-hero-wave-back"
                  d="M 24,113 C 44,91 76,91 100,113 C 124,135 156,135 176,113"
                />
                <path
                  data-draw
                  className="lock-hero-wave"
                  d="M 24,100 C 44,78 76,78 100,100 C 124,122 156,122 176,100"
                />
                <path
                  className="lock-hero-sweep"
                  d="M 24,100 C 44,78 76,78 100,100 C 124,122 156,122 176,100"
                />
                <circle className="lock-hero-spark a" cx="100" cy="56" r="2.1" />
                <circle className="lock-hero-spark b" cx="48" cy="120" r="1.6" />
                <circle className="lock-hero-spark c" cx="152" cy="84" r="1.6" />
              </svg>
            </div>
          </div>
          <h1 className="lock-overlay-title">
            <span className="word">Room</span> <span className="word">locked.</span>
          </h1>
          <p className="lock-overlay-sub">
            Your account is verified. This passphrase decrypts the room on this device for {ROOM_E2EE_DEVICE_UNLOCK_DAYS} days.
          </p>
          <input
            className="input lock-overlay-passphrase"
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") unlock();
            }}
            placeholder="Room passphrase"
            aria-label="Room passphrase"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
          <button type="button" className="lock-overlay-cta" disabled={!passphrase.trim() || busy} onClick={unlock}>
            <svg className="lock-overlay-cta-glyph" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M7 10V7a5 5 0 0 1 9.9-1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <rect x="4" y="10" width="16" height="11" rx="2.5" stroke="currentColor" strokeWidth="2" />
              <circle cx="12" cy="15.5" r="1.6" fill="currentColor" />
            </svg>
            <span>{busy ? "Unlocking…" : "Unlock room"}</span>
          </button>
          {error && (
            <p className="lock-overlay-error" role="alert" aria-live="assertive">
              {error}
            </p>
          )}
          <p
            style={{
              margin: "16px auto 0",
              maxWidth: "30ch",
              color: "var(--cream-faint)",
              fontFamily: "var(--body)",
              fontSize: "12.5px",
              lineHeight: 1.5,
            }}
          >
            Don&apos;t have the passphrase yet? Your partner will share it with you separately — you&apos;ll need it to open the room.
          </p>
          <button
            type="button"
            onClick={beginLaunchReauth}
            disabled={busy}
            style={{
              appearance: "none",
              border: 0,
              background: "transparent",
              marginTop: "10px",
              padding: "8px 4px",
              minHeight: "44px",
              color: "var(--cream-muted)",
              fontFamily: "var(--body)",
              fontSize: "13px",
              textDecoration: "underline",
              textUnderlineOffset: "4px",
              cursor: busy ? "wait" : "pointer",
            }}
          >
            Sign out
          </button>
          <p className="lock-room-meter" aria-hidden="true">
            <span className="dot" /> End-to-end encrypted
          </p>
        </section>
      </div>
    );
  }

  return children;
}
