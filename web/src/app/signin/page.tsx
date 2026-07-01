"use client";

/*  Sexualsync sign-in — stacked-wave edition.
    Also handles deep-link invite landings via /signin?invite=<id>:
      - Signed-out + invite param  → "You've been invited" hero, OAuth returnTo preserves the invite
      - Signed-in  + invite param  → invite preview with Accept / Decline
      - Signed-in  + has workspace → redirect to /sexboard (existing behavior)
      - Signed-in  + no workspace  → redirect to /onboarding (new)
*/

import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import BrandWordmark from "@/components/BrandWordmark";
import SplashScreen from "@/components/SplashScreen";
import { useDeploymentConfig } from "@/lib/deployment-config";
import {
  acceptInvite,
  ApiUnauthorizedError,
  clearPwaReconnectAttempt,
  declineInvite,
  getBootstrap,
  getInvitePreview,
  localPasswordSignIn,
  maybeReconnectStandalonePwa,
  rememberGoogleAuthProvider,
  type InvitePreview,
  startEmailSignIn,
  verifyEmailSignIn,
} from "@/lib/api";
import { hasIntentionalSignOut } from "@/lib/auth-state";
import "../signin.css";

const DEFAULT_RETURN_TO = "/sexboard";
const DEFAULT_SIGN_IN_URL = signInUrlForReturnTo(DEFAULT_RETURN_TO);
const LEGAL_ACCEPTANCE_ERROR = "Confirm you are 18+ and agree to the Terms and Privacy Policy first.";

// On PWA cold-launch, hold the SplashScreen for at least this long even if
// the bootstrap check finishes faster. Without a floor, the splash flashes
// by in ~200ms on a warm cache, which doesn't read as a deliberate boot —
// it reads as another flicker. 600ms gives the brand mark presence without
// adding dead time for users on warm caches.
const MIN_PWA_SPLASH_MS = 600;

function isPwaColdLaunch(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (new URL(window.location.href).searchParams.get("source") === "pwa") {
      return true;
    }
  } catch {
    // ignore malformed URL — fall through to display-mode check
  }
  return window.matchMedia?.("(display-mode: standalone)")?.matches === true
    || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
}

type Mode =
  | { kind: "marketing" }                                  // signed-out, no invite — default hero
  | { kind: "loading" }                                    // bootstrap in flight
  | { kind: "signed-out-invite"; inviteId: string }        // signed-out, has invite param
  | { kind: "preview"; invite: InvitePreview }             // signed-in, has invite, preview ready
  | { kind: "preview-error"; message: string };            // signed-in, invite lookup failed

function readInviteParam(): string {
  if (typeof window === "undefined") return "";
  try {
    const value = new URL(window.location.href).searchParams.get("invite") || "";
    return value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  } catch {
    return "";
  }
}

function readReviewParam(): string {
  if (typeof window === "undefined") return "";
  try {
    const params = new URL(window.location.href).searchParams;
    return (params.get("review") || params.get("token") || "").trim().slice(0, 256);
  } catch {
    return "";
  }
}

function signInUrlForReturnTo(returnTo: string): string {
  return `/api/auth/google?${new URLSearchParams({ returnTo }).toString()}`;
}

function signInUrlForInvite(inviteId: string): string {
  const returnTo = inviteId ? `/signin?invite=${encodeURIComponent(inviteId)}` : "/sexboard";
  return signInUrlForReturnTo(returnTo);
}

function reviewReturnToForToken(token: string): string {
  return `/review?token=${encodeURIComponent(token.slice(0, 256))}`;
}

function signInUrlForReview(token: string): string {
  return signInUrlForReturnTo(reviewReturnToForToken(token));
}

function sameOriginReturnTo(value: string): string {
  if (!value) return DEFAULT_RETURN_TO;
  try {
    const url = new URL(value, "https://sexualsync.local");
    if (url.origin !== "https://sexualsync.local") return DEFAULT_RETURN_TO;
    if (!url.pathname.startsWith("/") || url.pathname.startsWith("/api/auth/")) return DEFAULT_RETURN_TO;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}

function readReturnToParam(): string {
  if (typeof window === "undefined") return "";
  try {
    return sameOriginReturnTo(new URL(window.location.href).searchParams.get("returnTo") || "");
  } catch {
    return "";
  }
}

function readSigninMode(): string {
  if (typeof window === "undefined") return "";
  try {
    return new URL(window.location.href).searchParams.get("signin") || "";
  } catch {
    return "";
  }
}

function isPwaLaunchSource(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URL(window.location.href).searchParams.get("source") === "pwa";
  } catch {
    return false;
  }
}

function readSigninNotice(): string {
  if (typeof window === "undefined") return "";
  try {
    const params = new URL(window.location.href).searchParams;
    if (params.get("access") === "private-preview") {
      return "Sexualsync is in private preview. Public sign-ups are closed for now.";
    }
    if (params.get("auth")) {
      return "Sign-in couldn't finish. Please try again.";
    }
    return "";
  } catch {
    return "";
  }
}

function inviteErrorMessage(_error: unknown): string {
  // Single neutral string so the UX doesn't leak "expired vs revoked vs
  // never existed" to anyone probing invite IDs.
  return "This invite link doesn't work. Ask the sender for a fresh one.";
}

export default function SignInPage() {
  const router = useRouter();
  const { selfHost, googleAuthEnabled, emailAuthEnabled, localPasswordAuthEnabled } = useDeploymentConfig();
  const [mode, setMode] = useState<Mode>({ kind: "loading" });
  const [busy, setBusy] = useState<"" | "accept" | "decline">("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [emailOpen, setEmailOpen] = useState(() => readSigninMode() === "email");
  const [emailStage, setEmailStage] = useState<"email" | "code">("email");
  const [emailAddress, setEmailAddress] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailBusy, setEmailBusy] = useState<"" | "send" | "verify">("");
  const [emailError, setEmailError] = useState(() => readSigninNotice());
  const [emailMessage, setEmailMessage] = useState("");
  const [localMode, setLocalMode] = useState<"login" | "register">(() => readSigninMode() === "register" ? "register" : "login");
  const [localEmail, setLocalEmail] = useState("");
  const [localPassword, setLocalPassword] = useState("");
  const [localName, setLocalName] = useState("");
  const [localBusy, setLocalBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const [legalAccepted, setLegalAccepted] = useState(false);

  // Bootstrap + invite-param routing.
  // AbortController abort()'s every in-flight fetch when this effect
  // unmounts (route change, page navigation). The `cancelled` flag still
  // guards setState calls against races — abort lands at the fetch layer
  // but a resolved promise may already be queued.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const inviteId = readInviteParam();
    const reviewToken = readReviewParam();
    const reviewReturnTo = reviewToken ? reviewReturnToForToken(reviewToken) : "";
    // Only enforce a splash floor on PWA cold-launch; a regular browser
    // visit to "/" still shows the marketing CTA as fast as bootstrap can
    // resolve.
    const splashDeadline = isPwaColdLaunch() ? Date.now() + MIN_PWA_SPLASH_MS : 0;
    const waitForSplashFloor = () => {
      const remaining = splashDeadline - Date.now();
      return remaining > 0
        ? new Promise<void>((resolve) => window.setTimeout(resolve, remaining))
        : Promise.resolve();
    };

    (async () => {
      try {
        if (hasIntentionalSignOut()) {
          await waitForSplashFloor();
          if (cancelled) return;
          setMode(inviteId ? { kind: "signed-out-invite", inviteId } : { kind: "marketing" });
          return;
        }
        const profile = await getBootstrap(controller.signal, { suppressPwaReconnect: true });
        if (cancelled) return;
        if (inviteId) {
          try {
            const preview = await getInvitePreview(inviteId, controller.signal);
            if (cancelled) return;
            await waitForSplashFloor();
            if (cancelled) return;
            setMode({ kind: "preview", invite: preview.invite });
          } catch (error) {
            if (cancelled) return;
            // Don't echo server-supplied error strings — they vary between
            // "expired", "revoked", "already claimed", and "never existed",
            // which gives a token-guessing attacker a side channel. Collapse
            // every failure to one neutral user message.
            const message = inviteErrorMessage(error);
            await waitForSplashFloor();
            if (cancelled) return;
            setMode({ kind: "preview-error", message });
          }
          return;
        }
        if (profile.activeWorkspace) {
          clearPwaReconnectAttempt();
          await waitForSplashFloor();
          if (cancelled) return;
          // Use client-side router navigation so the document — and the
          // surrounding gates (MobileAccessGate, RoomEncryptionGate) — don't
          // re-mount. This eliminates the white-flash + CSS/font re-init
          // that a full window.location swap would cause during PWA cold
          // launch.
          router.replace(reviewReturnTo || readReturnToParam() || DEFAULT_RETURN_TO);
          return;
        }
        // Signed in, no workspace, no invite — go set up a room.
        clearPwaReconnectAttempt();
        await waitForSplashFloor();
        if (cancelled) return;
        router.replace("/onboarding");
      } catch (error) {
        if (cancelled) return;
        // AbortError = the effect was torn down. Don't render anything.
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!(error instanceof ApiUnauthorizedError)) {
          // Network or other unexpected — fall back to marketing so the page
          // is at least usable; the user can still hit "Continue with Google".
          await waitForSplashFloor();
          if (cancelled) return;
          if (inviteId) {
            setMode({ kind: "signed-out-invite", inviteId });
          } else {
            setMode({ kind: "marketing" });
          }
          return;
        }
        if (inviteId) {
          await waitForSplashFloor();
          if (cancelled) return;
          setMode({ kind: "signed-out-invite", inviteId });
          return;
        }
        await waitForSplashFloor();
        if (cancelled) return;
        setMode({ kind: "marketing" });
        maybeReconnectStandalonePwa(reviewReturnTo || readReturnToParam() || DEFAULT_RETURN_TO, {
          preferBrowserSession: isPwaLaunchSource(),
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [router]);

  async function onAccept(inviteId: string) {
    if (busy) return;
    setBusy("accept");
    setActionError(null);
    try {
      await acceptInvite(inviteId);
      clearPwaReconnectAttempt();
      router.replace("/welcome");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Couldn't accept this invite.");
      setBusy("");
    }
  }

  async function onDecline(inviteId: string) {
    if (busy) return;
    setBusy("decline");
    setActionError(null);
    try {
      await declineInvite(inviteId);
      router.replace("/onboarding");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Couldn't decline this invite.");
      setBusy("");
    }
  }

  async function onSendEmailCode(event: FormEvent<HTMLFormElement>, returnTo: string) {
    event.preventDefault();
    if (emailBusy) return;
    if (!legalAccepted) {
      setEmailError(LEGAL_ACCEPTANCE_ERROR);
      return;
    }
    setEmailBusy("send");
    setEmailError("");
    setEmailMessage("");
    try {
      await startEmailSignIn({
        email: emailAddress,
        returnTo,
      });
      setEmailStage("code");
      setEmailCode("");
      setEmailMessage("Code sent. Check your email.");
    } catch (error) {
      setEmailError(error instanceof Error ? error.message : "Couldn't send a code.");
    } finally {
      setEmailBusy("");
    }
  }

  async function onVerifyEmailCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (emailBusy) return;
    setEmailBusy("verify");
    setEmailError("");
    setEmailMessage("");
    try {
      const result = await verifyEmailSignIn({
        email: emailAddress,
        code: emailCode,
      });
      window.location.assign(sameOriginReturnTo(result.returnTo || DEFAULT_RETURN_TO));
    } catch (error) {
      setEmailError(error instanceof Error ? error.message : "That code didn't work.");
      setEmailBusy("");
    }
  }

  async function onLocalPasswordSubmit(event: FormEvent<HTMLFormElement>, returnTo: string) {
    event.preventDefault();
    if (localBusy) return;
    if (!legalAccepted) {
      setLocalError(LEGAL_ACCEPTANCE_ERROR);
      return;
    }
    setLocalBusy(true);
    setLocalError("");
    setEmailError("");
    try {
      const result = await localPasswordSignIn({
        mode: localMode,
        email: localEmail,
        password: localPassword,
        name: localName,
        returnTo,
      });
      window.location.assign(sameOriginReturnTo(result.returnTo || DEFAULT_RETURN_TO));
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Sign-in failed.");
      setLocalBusy(false);
    }
  }

  function onGoogleSignIn(event: MouseEvent<HTMLAnchorElement>) {
    if (!legalAccepted) {
      event.preventDefault();
      setEmailMessage("");
      setEmailError(LEGAL_ACCEPTANCE_ERROR);
      return;
    }
    rememberGoogleAuthProvider();
  }

  if (mode.kind === "preview") {
    return <InvitePreviewScreen invite={mode.invite} busy={busy} actionError={actionError} onAccept={onAccept} onDecline={onDecline} />;
  }
  if (mode.kind === "preview-error") {
    return <InviteErrorScreen message={mode.message} />;
  }
  if (mode.kind === "loading" && isPwaColdLaunch()) {
    // Only show the calm branded splash on actual PWA cold-launches —
    // browser visitors to / get the marketing hero immediately so the
    // sign-in CTA appears as fast as bootstrap can resolve.
    return <SplashScreen />;
  }

  // marketing / signed-out-invite / loading (non-PWA) all use the candlelight hero.
  const isInviteHero = mode.kind === "signed-out-invite";
  const isStillLoading = mode.kind === "loading";
  // Even during "loading" (non-PWA), honor an invite param so the sign-in
  // CTA preserves it through OAuth. Without this, a user who taps Continue
  // with Google before bootstrap resolves loses the invite id and lands on
  // /sexboard with no way back to the invite.
  const pendingInviteId = isStillLoading ? readInviteParam() : "";
  const reviewTokenForCta = !isInviteHero ? readReviewParam() : "";
  const ctaUrl = isInviteHero
    ? signInUrlForInvite(mode.inviteId)
    : pendingInviteId
      ? signInUrlForInvite(pendingInviteId)
      : reviewTokenForCta
        ? signInUrlForReview(reviewTokenForCta)
        : DEFAULT_SIGN_IN_URL;
  const ctaLabel = isInviteHero ? "Continue with Google to claim" : "Continue with Google";
  const emailReturnTo = isInviteHero
    ? `/signin?invite=${encodeURIComponent(mode.inviteId)}`
    : pendingInviteId
      ? `/signin?invite=${encodeURIComponent(pendingInviteId)}`
      : reviewTokenForCta
        ? reviewReturnToForToken(reviewTokenForCta)
        : readReturnToParam() || DEFAULT_RETURN_TO;
  const showLocalPassword = selfHost && localPasswordAuthEnabled;
  const showGoogle = !selfHost || googleAuthEnabled;
  const showEmail = !selfHost || emailAuthEnabled;

  return (
    <main
      className={`signin signin-cl min-h-screen${isStillLoading ? " is-bootstrap-loading" : ""}`}
      data-bootstrap-loading={isStillLoading ? "true" : undefined}
    >
      {/* Purely decorative atmosphere. `inert` removes them from the tab /
         focus tree on top of `aria-hidden`; older browsers fall back to the
         aria-hidden behavior. The atmosphere paints right away even while
         bootstrap is in flight so a signed-in user lands on the candlelit
         frame, not on the marketing hero, before redirect. The hero text /
         CTA below are hidden until bootstrap resolves. */}
      <div className="cl-candle" aria-hidden="true" inert />
      <div className="cl-floor"  aria-hidden="true" inert />

      <div className="cl-wave" aria-hidden="true" inert>
        <svg viewBox="0 0 400 200" preserveAspectRatio="xMidYMid meet">
          <path d="M 0,100 C 50,30 130,30 200,100 C 270,170 350,170 400,100" />
          <path d="M 0,130 C 50,60 130,60 200,130 C 270,200 350,200 400,130" opacity="0.6" />
        </svg>
      </div>

      <BrandWordmark className="cl-wordmark" />

      {isInviteHero ? (
        <h1 className="cl-headline">
          <span className="quiet">You&apos;ve been</span>
          <br />
          <span className="glow">invited.</span>
        </h1>
      ) : (
        <h1 className="cl-headline">
          <span className="quiet">Some things are</span>
          <br />
          <em>easier</em> to type
          <br />
          <span className="quiet">than</span>{" "}
          <span className="glow">say.</span>
        </h1>
      )}

      <p className="cl-sub">
        {isInviteHero
          ? "Someone set up a private room and saved one seat for you. Sign in to see who."
          : "A room for two. No feed, no scroll — just the conversation."}
      </p>

      <div className="cl-actions">
        {!isInviteHero && (
          <p className="cl-tagline">
            Get curious. <span className="glow">Get in sync.</span>
          </p>
        )}

        <label className="legal-acceptance">
          <input
            type="checkbox"
            checked={legalAccepted}
            onChange={(event) => {
              setLegalAccepted(event.target.checked);
              if (event.target.checked && emailError === LEGAL_ACCEPTANCE_ERROR) setEmailError("");
              if (event.target.checked && localError === LEGAL_ACCEPTANCE_ERROR) setLocalError("");
            }}
          />
          <span>
            I am 18+ and agree to the <a href="/terms.html">Terms</a> and <a href="/privacy.html">Privacy Policy</a>.
          </span>
        </label>

        {showLocalPassword && (
          <div className="local-auth">
            <div className="local-auth-tabs" role="group" aria-label="Local account mode">
              <button
                type="button"
                className={localMode === "login" ? "is-active" : ""}
                onClick={() => {
                  setLocalMode("login");
                  setLocalError("");
                }}
              >
                Sign in
              </button>
              <button
                type="button"
                className={localMode === "register" ? "is-active" : ""}
                onClick={() => {
                  setLocalMode("register");
                  setLocalError("");
                }}
              >
                Create account
              </button>
            </div>
            <form className="local-auth-form" onSubmit={(event) => void onLocalPasswordSubmit(event, emailReturnTo)}>
              {localMode === "register" && (
                <>
                  <label className="sr-only" htmlFor="local-auth-name">Display name</label>
                  <input
                    id="local-auth-name"
                    className="email-auth-input local-auth-input-wide"
                    type="text"
                    autoComplete="name"
                    placeholder="Display name"
                    value={localName}
                    onChange={(event) => setLocalName(event.target.value)}
                    disabled={localBusy}
                  />
                </>
              )}
              <label className="sr-only" htmlFor="local-auth-email">Email address</label>
              <input
                id="local-auth-email"
                className="email-auth-input local-auth-input-wide"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="Email address"
                value={localEmail}
                onChange={(event) => setLocalEmail(event.target.value)}
                disabled={localBusy}
                required
              />
              <label className="sr-only" htmlFor="local-auth-password">Password</label>
              <input
                id="local-auth-password"
                className="email-auth-input"
                type="password"
                autoComplete={localMode === "register" ? "new-password" : "current-password"}
                placeholder="Password"
                minLength={8}
                maxLength={200}
                value={localPassword}
                onChange={(event) => setLocalPassword(event.target.value)}
                disabled={localBusy}
                required
              />
              <button type="submit" className="email-auth-submit pressable" disabled={localBusy || !legalAccepted}>
                {localBusy ? "Working..." : localMode === "register" ? "Create" : "Sign in"}
              </button>
            </form>
            {localError && <p className="email-auth-error" role="alert">{localError}</p>}
          </div>
        )}

        {showGoogle && (
          <a
            className={`pa-cta pressable${legalAccepted ? "" : " is-disabled"}`}
            href={ctaUrl}
            aria-disabled={!legalAccepted}
            onClick={onGoogleSignIn}
          >
            <span className="pa-cta-glyph" aria-hidden="true">G</span>
            {ctaLabel}
          </a>
        )}

        {showEmail && (
          <div className="email-auth">
            {!emailOpen ? (
              <button
                type="button"
                className="email-auth-toggle pressable"
                onClick={() => {
                  setEmailOpen(true);
                  setEmailError("");
                  setEmailMessage("");
                }}
              >
                Use email instead
              </button>
            ) : emailStage === "email" ? (
              <form className="email-auth-form" onSubmit={(event) => void onSendEmailCode(event, emailReturnTo)}>
                <label className="sr-only" htmlFor="email-auth-address">Email address</label>
                <input
                  id="email-auth-address"
                  className="email-auth-input"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="Email address"
                  value={emailAddress}
                  onChange={(event) => setEmailAddress(event.target.value)}
                  disabled={emailBusy !== ""}
                  required
                />
                <button type="submit" className="email-auth-submit pressable" disabled={emailBusy !== "" || !legalAccepted}>
                  {emailBusy === "send" ? "Sending..." : "Send code"}
                </button>
              </form>
            ) : (
              <form className="email-auth-form" onSubmit={(event) => void onVerifyEmailCode(event)}>
                <label className="sr-only" htmlFor="email-auth-code">Sign-in code</label>
                <input
                  id="email-auth-code"
                  className="email-auth-input email-auth-input--code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="6-digit code"
                  value={emailCode}
                  onChange={(event) => setEmailCode(event.target.value.replace(/\D+/g, "").slice(0, 6))}
                  disabled={emailBusy !== ""}
                  required
                />
                <button type="submit" className="email-auth-submit pressable" disabled={emailBusy !== "" || emailCode.length < 6}>
                  {emailBusy === "verify" ? "Checking..." : "Confirm"}
                </button>
                <button
                  type="button"
                  className="email-auth-resend"
                  disabled={emailBusy !== ""}
                  onClick={() => {
                    setEmailStage("email");
                    setEmailCode("");
                    setEmailMessage("");
                    setEmailError("");
                  }}
                >
                  Use a different email
                </button>
              </form>
            )}
            {emailMessage && <p className="email-auth-message">{emailMessage}</p>}
            {emailError && <p className="email-auth-error" role="alert">{emailError}</p>}
          </div>
        )}

        <p className="cl-foot">
          <span>18+</span>
          {!selfHost && (
            <>
              <span className="sep">·</span>
              <span>Beta / early access</span>
            </>
          )}
          <span className="sep">·</span>
          <a href="/privacy.html">Trust</a>
          <span className="sep">·</span>
          <a href="/terms.html">Terms</a>
        </p>
      </div>

      <div className="cl-grain"    aria-hidden="true" inert />
      <div className="cl-vignette" aria-hidden="true" inert />
    </main>
  );
}

function InvitePreviewScreen({
  invite,
  busy,
  actionError,
  onAccept,
  onDecline,
}: {
  invite: InvitePreview;
  busy: "" | "accept" | "decline";
  actionError: string | null;
  onAccept: (id: string) => Promise<void>;
  onDecline: (id: string) => Promise<void>;
}) {
  const inviterName = invite.inviterName?.split(" ")[0] || "Someone";
  const roomLabel = invite.workspaceName || "their room";
  return (
    <main className="surface signin signin-b min-h-screen">
      <div className="atmosphere" aria-hidden="true">
        <div className="atm-top" />
        <div className="atm-bottom" />
        <div className="grain" />
      </div>
      <div className="invite-preview-stage">
        <p className="pa-eyebrow signin-eyebrow">Invite from {inviterName}</p>
        <h1 className="invite-preview-title">Join {inviterName}&apos;s room?</h1>
        <p className="invite-preview-sub">
          {inviterName} set up a private space and is waiting for one other person. The two of you can share kinks, fantasies, and asks &mdash; nobody else will ever see it.
        </p>
        <ul className="invite-preview-list">
          <li><span aria-hidden="true">✓</span>Private to the two of you</li>
          <li><span aria-hidden="true">✓</span>You can leave anytime</li>
          <li><span aria-hidden="true">✓</span>No public profile, no feed</li>
        </ul>

        <p className="invite-preview-sub">
          One thing to have ready: the room is end-to-end encrypted, so {inviterName} will share a room passphrase with you separately. You&apos;ll need it to unlock the room after you join.
        </p>

        {actionError && <p className="invite-preview-error" role="alert">{actionError}</p>}

        <div className="invite-preview-actions">
          <button
            type="button"
            className="btn-primary invite-preview-cta"
            onClick={() => void onAccept(invite.id)}
            disabled={busy !== ""}
          >
            {busy === "accept" ? "Joining..." : `Join ${inviterName}'s room`}
          </button>
          <button
            type="button"
            className="btn-ghost invite-preview-decline"
            onClick={() => void onDecline(invite.id)}
            disabled={busy !== ""}
          >
            {busy === "decline" ? "Declining..." : "Not me — decline"}
          </button>
        </div>
        <p className="pa-foot invite-preview-foot">
          Room: <em>{roomLabel}</em>
        </p>
      </div>
    </main>
  );
}

function InviteErrorScreen({ message }: { message: string }) {
  return (
    <main className="surface signin signin-b min-h-screen">
      <div className="atmosphere" aria-hidden="true">
        <div className="atm-top" />
        <div className="atm-bottom" />
        <div className="grain" />
      </div>
      <div className="invite-preview-stage">
        <p className="pa-eyebrow signin-eyebrow">Invite link</p>
        <h1 className="invite-preview-title">This link doesn&apos;t work.</h1>
        <p className="invite-preview-sub">
          {message || "It may have expired, been revoked, or already been claimed. Ask the person who sent it for a fresh link."}
        </p>
        <div className="invite-preview-actions">
          <a className="btn-primary invite-preview-cta" href="/sexboard">Open the app</a>
        </div>
      </div>
    </main>
  );
}
