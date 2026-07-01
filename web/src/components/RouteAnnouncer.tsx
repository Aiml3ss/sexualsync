"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// Discretion keeps document.title statically "Private notes" on every route,
// which silences Next's built-in route announcer (it only speaks when the
// title CHANGES) — so without this, every client-side navigation is a silent
// page swap for screen-reader users. This announcer lives in the persistent
// root layout (page-level AppShells remount per navigation and would reset),
// moves focus to the new screen's main region, and speaks an IN-APP screen
// name through a polite live region — the OS-visible title stays generic.
const SCREEN_NAMES: Record<string, string> = {
  "/": "Welcome",
  "/welcome": "Welcome",
  "/signin": "Sign in",
  "/signed-out": "Signed out",
  "/onboarding": "Set up your room",
  "/sexboard": "Sexboard",
  "/tonight": "Tonight",
  "/ask": "New Ask",
  "/ask-detail": "Ask details",
  "/mutual": "It's a match",
  "/space": "Space",
  "/space/acts": "Acts",
  "/space/limits": "Limits",
  "/space/notes": "Private notes",
  "/space/health": "Health",
  "/space/vault": "Vault",
  "/space/privacy": "Privacy",
  "/space/tutorial": "Tutorial",
  "/games/pile": "The Pile",
  "/games/blind-reveal": "Blind Reveal",
  "/inspiration": "Inspiration",
  "/inspiration/kink": "Kink",
  "/inspiration/shelf": "Shelf",
  "/share": "Save to Shelf",
  "/more": "More",
};

function screenNameFor(pathname: string): string {
  if (SCREEN_NAMES[pathname]) return SCREEN_NAMES[pathname];
  const segment = pathname.split("/").filter(Boolean).pop() || "Home";
  return segment.replace(/[-_]+/g, " ").replace(/^./, (char) => char.toUpperCase());
}

export default function RouteAnnouncer() {
  const pathname = usePathname();
  const [announcement, setAnnouncement] = useState("");
  const isFirstRender = useRef(true);

  useEffect(() => {
    // The initial document load is announced by the browser itself; only
    // client-side navigations need help.
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    // Land keyboard/SR focus on the new screen's content (programmatic focus
    // doesn't trigger :focus-visible, so no ring flashes for pointer users).
    const main = document.getElementById("app-main");
    if (main instanceof HTMLElement) {
      main.focus({ preventScroll: true });
    }
    setAnnouncement(screenNameFor(pathname));
  }, [pathname]);

  return (
    <div aria-live="polite" role="status" className="sr-only">
      {announcement}
    </div>
  );
}
