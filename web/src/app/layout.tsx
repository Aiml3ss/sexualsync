import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Geist, JetBrains_Mono } from "next/font/google";
import MobileAccessGate from "@/components/MobileAccessGate";
import PushReconnect from "@/components/PushReconnect";
import PwaBridge from "@/components/PwaBridge";
import RoomEncryptionGate from "@/components/RoomEncryptionGate";
import RouteAnnouncer from "@/components/RouteAnnouncer";
import "./globals.css";
import "./polish-shared.css";
import "./pwa-access.css";

// Self-host the brand webfonts via next/font so the editorial identity actually
// renders (the app previously named these families but never loaded them) and
// no request leaks to Google at runtime — important for this product.
const display = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
});

const sans = Geist({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  // The brief calls out that even a share preview shouldn't out the product
  // category. Title, description, and the iOS home-screen icon label all
  // stay generic so anyone who glances at the user's phone or sees a share
  // preview doesn't learn what kind of app this is.
  title: "Private notes",
  description: "A private notebook for two.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/brand/marks/favicon.svg", type: "image/svg+xml" },
      { url: "/brand/marks/app-icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/brand/marks/app-icon-180.png", sizes: "180x180" }],
  },
  // Don't index, ever.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#170a10",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Private" />
      </head>
      <body className="min-h-screen antialiased">
        <a
          href="#app-main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[1000] focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-ink focus:outline focus:outline-2 focus:outline-ink"
        >
          Skip to content
        </a>
        <RouteAnnouncer />
        <MobileAccessGate>
          <PwaBridge />
          <PushReconnect />
          <RoomEncryptionGate>{children}</RoomEncryptionGate>
        </MobileAccessGate>
      </body>
    </html>
  );
}
