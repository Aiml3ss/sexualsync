/**
 * Top-level container for every authenticated screen.
 * - Caps width at 440px (mobile-first; design at 390px per the brief).
 * - Reserves room for the bottom tab bar.
 */
import type { ReactNode } from "react";
import LiveActivityToast, { LiveApprovalSplashRedirect } from "./LiveActivityToast";
import TabBar from "./TabBar";

export default function AppShell({
  children,
  hideTabBar = false,
}: {
  children: ReactNode;
  hideTabBar?: boolean;
}) {
  return (
    <div className="min-h-screen bg-bg">
      <div className={`surface app-shell ${hideTabBar ? "app-shell-no-tabbar" : "app-shell-with-tabbar"}`}>
        <div className="atmosphere" aria-hidden="true">
          <div className="atm-top" />
          <div className="atm-bottom" />
          <div className="grain" />
        </div>
        {/* tabIndex={-1}: RouteAnnouncer (root layout) moves focus here on
            client-side navigations so keyboard/SR users land on the new
            screen instead of staying on the old link. */}
        <main id="app-main" tabIndex={-1} className="app-shell-main route-enter">{children}</main>
        <LiveApprovalSplashRedirect />
        <LiveActivityToast />
        {!hideTabBar && <TabBar />}
      </div>
    </div>
  );
}
