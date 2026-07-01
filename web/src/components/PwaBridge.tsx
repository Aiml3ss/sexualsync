"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useVaultLightbox } from "@/app/space/vault/_VaultClipLightbox";
import { clearAllNamespacedLocalState } from "@/lib/local-storage-sweep";
import { markIntentionalSignOut } from "@/lib/auth-state";
import { clearRoomE2eeKeyCache } from "@/lib/room-crypto";
import { clearVaultKeyCache } from "@/lib/vault-crypto";
import { clearResourceCache } from "@/lib/resource-cache";
import { installOfflineQueueListeners } from "@/lib/offline-queue";
import { getPwaEnvironment, type PwaEnvironment } from "@/lib/pwa-environment";

const PRIMARY_ROUTE_SHELLS = [
  "/admin",
  "/sexboard",
  "/ask",
  "/inspiration",
  "/games",
  "/space",
  "/space/vault",
  "/inspiration/shelf",
];

function warmPrimaryRoutes() {
  if (navigator.onLine === false) return;
  // Don't flood a genuinely metered/slow link. Only skip on an explicit
  // Save-Data signal or a truly slow effectiveType — "3g" is a coarse bucket
  // that's reported for plenty of usable links, and skipping the warm there
  // made primary routes load cold. Shells stay `no-cache` so the warm pulls the
  // latest version on the links that do warm.
  const conn = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  if (conn?.saveData || ["slow-2g", "2g"].includes(conn?.effectiveType || "")) return;
  PRIMARY_ROUTE_SHELLS.forEach((route) => {
    fetch(route, {
      credentials: "same-origin",
      cache: "no-cache",
    }).catch(() => {});
  });
}

type BeforeInstallPromptEvent = Event & {
  platforms?: string[];
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const INSTALL_DISMISSED_KEY = "sexualsync:pwa-install-dismissed";

function readInstallDismissed() {
  try {
    return window.sessionStorage.getItem(INSTALL_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeInstallDismissed() {
  try {
    window.sessionStorage.setItem(INSTALL_DISMISSED_KEY, "1");
  } catch {
    // Ignore storage failures; this is only a soft dismissal.
  }
}

// Mirror of signout.ts: drop the offline-write queue's IndexedDB so plaintext
// request bodies don't leak to the next user on a shared device. This tab is
// reacting to another tab's cross-tab `signed-out` broadcast, so it must run
// the same wipe locally. Fire-and-forget with swallowed errors so a
// `blocked`/`error`/absent-DB event can't throw or block the relock.
function clearOfflineQueueDb() {
  if (typeof indexedDB === "undefined") return;
  try {
    const request = indexedDB.deleteDatabase("ss-offline-queue");
    request.onerror = () => {};
    request.onblocked = () => {};
  } catch {
    // deleteDatabase can throw in privacy modes / restricted webviews; the
    // queue is best-effort state, so swallow and continue relocking.
  }
}

// Install help is a modal (role="dialog" aria-modal). Split into its own
// component so `useVaultLightbox` — which locks body scroll, traps Tab, closes
// on Esc, and restores focus on unmount — can run unconditionally and only
// mount while the sheet is open. Reuses the Vault lightbox hook so both modals
// share one focus-management implementation.
function InstallInstructionsSheet({
  title,
  steps,
  onClose,
  onDismiss,
}: {
  title: string;
  steps: string[];
  onClose: () => void;
  onDismiss: () => void;
}) {
  const sheetRef = useRef<HTMLElement | null>(null);
  useVaultLightbox(onClose, sheetRef);

  return (
    <div className="pwa-install-overlay" role="presentation" onClick={onClose}>
      <section
        ref={sheetRef}
        className="pwa-install-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pwa-install-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="pwa-install-eyebrow">Home Screen</p>
        <h2 id="pwa-install-title">{title}</h2>
        <ol>
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <div className="pwa-install-sheet-actions">
          <button type="button" className="btn-primary pressable" onClick={onClose}>
            Got it
          </button>
          <button type="button" className="btn-ghost pressable" onClick={onDismiss}>
            Not now
          </button>
        </div>
      </section>
    </div>
  );
}

export default function PwaBridge() {
  const pathname = usePathname();
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installing, setInstalling] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [installDismissed, setInstallDismissed] = useState(false);
  const [environment, setEnvironment] = useState<PwaEnvironment | null>(null);
  const refreshingRef = useRef(false);

  useEffect(() => {
    // Hydration-safe browser-state read: server renders with the null defaults,
    // client picks up the real values after mount. Lazy useState would crash
    // during SSR (getPwaEnvironment touches window/navigator).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEnvironment(getPwaEnvironment());
    setInstallDismissed(readInstallDismissed());
    // Wire the offline-write queue's flush triggers (online / focus /
    // visibilitychange) once per tab. The queue itself only persists work
    // that callers opted in via `{ queueable: true }` on `request()`.
    installOfflineQueueListeners();
  }, []);

  // On-screen keyboard handling. iOS Safari overlays the keyboard on top of the
  // layout viewport without resizing it, so fixed bottom UI ends up hidden
  // behind the keyboard and focus-driven scrolls fight the keyboard animation.
  // visualViewport is the only reliable signal: track it, expose the keyboard
  // height as `--kb-inset`, and flag `<html data-kb>` so CSS can lift the
  // floating action above the keyboard and slide the tab bar out of the way.
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const root = document.documentElement;
    let lastInset = -1;
    const apply = () => {
      const raw = window.innerHeight - vv.height - vv.offsetTop;
      // Ignore dynamic-toolbar-sized deltas; only react to a real keyboard.
      const inset = raw > 120 ? Math.round(raw) : 0;
      // Only touch the DOM when the inset actually changes. Writing a :root
      // custom property invalidates computed style for the whole document, and
      // iOS fires these events on every scroll / URL-bar move — an
      // unconditional write recalculated styles on every scroll frame and
      // stalled the main thread.
      if (inset === lastInset) return;
      lastInset = inset;
      root.style.setProperty("--kb-inset", `${inset}px`);
      if (inset > 0) root.dataset.kb = "1";
      else delete root.dataset.kb;
    };
    // Keyboard show/hide is a visualViewport *resize*. We deliberately do NOT
    // listen to the high-frequency *scroll* event (fires on every page scroll
    // and URL-bar movement) — it isn't needed for the keyboard inset and was
    // the source of scroll jank.
    vv.addEventListener("resize", apply);
    apply();
    return () => {
      vv.removeEventListener("resize", apply);
      root.style.removeProperty("--kb-inset");
      delete root.dataset.kb;
    };
  }, []);

  // Cross-tab logout propagation. When tab A signs out it broadcasts a
  // `signed-out` event; every other tab on the same origin wipes its local
  // state and reloads to /. Without this, tab B would keep showing the app
  // until its next API call returned 401, which then triggers the PWA
  // reconnect flow (and potentially the /auth-blocked fallback if Safari
  // ITP is rejecting cookies). Cleaner to relock immediately.
  useEffect(() => {
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("ss:auth");
    function onMessage(event: MessageEvent) {
      if (event.data?.kind === "signed-out") {
        clearAllNamespacedLocalState();
        clearRoomE2eeKeyCache();
        clearVaultKeyCache();
        clearResourceCache();
        clearOfflineQueueDb();
        markIntentionalSignOut();
        window.location.replace("/signed-out");
      }
    }
    channel.addEventListener("message", onMessage);
    return () => {
      channel.removeEventListener("message", onMessage);
      channel.close();
    };
  }, []);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstallPrompt(null);
      setInstructionsOpen(false);
      setEnvironment(getPwaEnvironment());
    };
    const refreshEnvironment = () => setEnvironment(getPwaEnvironment());

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    window.addEventListener("resize", refreshEnvironment);
    window.addEventListener("orientationchange", refreshEnvironment);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      window.removeEventListener("resize", refreshEnvironment);
      window.removeEventListener("orientationchange", refreshEnvironment);
    };
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const isSecure = window.location.protocol === "https:" || window.location.hostname === "localhost";
    if (!isSecure) return;
    // Skip SW registration in local dev by default — a stale SW shadowing the
    // Next dev server causes weird "why is my CSS old?" loops. Opt back in
    // with `?sw=1` to actually exercise PWA behavior.
    const host = window.location.hostname;
    const isLocalHost = host === "localhost" || host === "127.0.0.1" || host.endsWith(".local");
    const swOptIn = new URLSearchParams(window.location.search).has("sw");
    if (isLocalHost && !swOptIn) return;

    let warmTimer: number | null = null;
    let registrationRef: ServiceWorkerRegistration | null = null;
    const checkForUpdates = () => {
      if (document.visibilityState === "hidden") return;
      registrationRef?.update().catch(() => {});
    };

    document.addEventListener("visibilitychange", checkForUpdates);
    window.addEventListener("focus", checkForUpdates);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshingRef.current) return;
      refreshingRef.current = true;
      window.location.reload();
    });

    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((registration) => {
      registrationRef = registration;
      registration.update().catch(() => {});
      if (registration.waiting && navigator.serviceWorker.controller) {
        setWaitingWorker(registration.waiting);
      }
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            setWaitingWorker(worker);
          }
        });
      });
      warmTimer = window.setTimeout(warmPrimaryRoutes, 1200);
    }).catch(() => {});

    return () => {
      if (warmTimer !== null) window.clearTimeout(warmTimer);
      document.removeEventListener("visibilitychange", checkForUpdates);
      window.removeEventListener("focus", checkForUpdates);
    };
  }, []);

  const showInstallPrompt = pathname === "/sexboard"
    && environment
    && !environment.standalone
    && environment.mobileLike
    && !environment.embedded
    && !installDismissed;
  const installLabel = installPrompt ? "Install app" : environment?.iosSafari ? "Add to Home Screen" : "Install help";
  const installHelpTitle = environment?.iosSafari ? "Add Sexualsync to Home Screen" : "Install Sexualsync";
  const installHelpSteps = environment?.iosSafari
    ? ["Tap Share in Safari.", "Choose Add to Home Screen.", "Open Sexualsync from the new Home Screen icon."]
    : ["Open the browser menu.", "Choose Install app or Add to Home screen.", "Open Sexualsync from the new Home Screen icon."];

  async function installApp() {
    if (!installPrompt) {
      setInstructionsOpen(true);
      return;
    }
    setInstalling(true);
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice.catch(() => null);
      setInstallPrompt(null);
    } finally {
      setInstalling(false);
    }
  }

  const closeInstructions = useCallback(() => setInstructionsOpen(false), []);

  function dismissInstall() {
    writeInstallDismissed();
    setInstallDismissed(true);
    setInstructionsOpen(false);
  }

  return (
    <>
      {showInstallPrompt && (
        <div className="pwa-install-pill" role="status" aria-live="polite">
          <span>Better from your Home Screen</span>
          <button type="button" className="pressable" onClick={installApp} disabled={installing}>
            {installing ? "Opening..." : installLabel}
          </button>
          <button
            type="button"
            className="pwa-pill-dismiss pressable"
            onClick={dismissInstall}
            aria-label="Dismiss install prompt"
          >
            Close
          </button>
        </div>
      )}

      {waitingWorker && (
        <div className="pwa-update-pill" role="status" aria-live="polite">
          <span>Update ready</span>
          <button
            type="button"
            className="pressable"
            onClick={() => {
              waitingWorker.postMessage({ type: "SKIP_WAITING" });
            }}
          >
            Refresh
          </button>
        </div>
      )}

      {instructionsOpen && (
        <InstallInstructionsSheet
          title={installHelpTitle}
          steps={installHelpSteps}
          onClose={closeInstructions}
          onDismiss={dismissInstall}
        />
      )}
    </>
  );
}
