import { captureException, sentryEnabled } from "./_sentry.js";
import { clearSessionCookie, verifyAppSession } from "./api/_app_session.js";
import { getAuthenticatedIdentity } from "./api/_auth.js";

const RETIRED_PATHS = new Set([
  "/app-shell.js",
  "/velvet.css",
  "/legacy.html",
  "/vendor/supabase.js"
]);

const NO_STORE_ASSET_PATHS = new Set([
  "/sw.js"
]);

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PROTECTED_APP_PATHS = [
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
  "/onboarding",
  "/review",
  "/sexboard",
  "/share",
  "/space",
  "/tonight",
  "/welcome"
];

// Per-request CSP nonce. Generated for every navigation, injected into every
// inline <script> and <style> tag the response carries, and woven into the
// Content-Security-Policy header that goes back on the same response. The
// static fallback CSP in `_headers` still applies to assets that don't pass
// through this middleware (e.g. some static html paths).
function generateNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/g, "");
}

function buildCspHeader(nonce) {
  // `'strict-dynamic'` together with the nonce means: only inline scripts that
  // carry this exact nonce can execute, and any further scripts they load are
  // trusted too. We intentionally do NOT put `'unsafe-inline'` in script-src:
  // CSP3 browsers ignore it whenever a nonce/'strict-dynamic' is present, and on
  // a pre-CSP3 browser it would be the single gap that lets an injected inline
  // <script> run — which on this app means reading the room E2EE keys cached in
  // sessionStorage. Every inline script we ship is nonce-stamped by
  // chainInject() below, so dropping it costs nothing on modern browsers and
  // closes the legacy hole.
  //
  // Style-src keeps `'unsafe-inline'` because Next.js + the editorial
  // typography emit inline style attributes we can't realistically nonce. The
  // XSS containment win is on scripts; styles are aesthetic.
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' https://www.bellesa.co",
    "img-src 'self' data: blob: https://*.redgifs.com https://c.bellesa.co",
    "media-src 'self' blob: https://*.redgifs.com https://s.bellesa.co",
    "font-src 'self' data:",
    "frame-src 'self' https://www.redgifs.com",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "upgrade-insecure-requests"
  ].join("; ");
}

// Inject the nonce into every <script>, <style>, and <link> tag in an HTML body.
// Next emits script preloads as <link rel="preload" as="script">; with
// `strict-dynamic`, those preloads also need the nonce or the browser blocks
// the corresponding chunk before React can finish hydrating. Tags that already
// carry a `nonce=` attribute are left alone. Done with a
// targeted regex rather than a full HTML parser — Cloudflare Workers have
// no DOM and pulling in a parser per request is wasteful. The opening tag
// shape is consistent enough that this regex is reliable; if anything is
// missed the browser blocks it with a clear CSP violation in DevTools.
function chainInject(html, tags, nonce) {
  let out = html;
  for (const tag of tags) {
    out = out.replace(new RegExp(`<${tag}(?![^>]*\\snonce=)([\\s>])`, "g"), `<${tag} nonce="${nonce}"$1`);
  }
  return out;
}

// Defense-in-depth CSRF guard on top of the SameSite=Lax session cookie. For
// state-changing /api requests that carry a browser Origin header, require it
// to match this deployment's own origin. Requests without an Origin header
// (Bearer-token API clients, the room worker's token-gated cron) are allowed —
// they are not cookie-driven and thus not CSRF-able.
function isCrossOriginApiMutation(request, url) {
  if (!url.pathname.startsWith("/api/")) return false;
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return origin !== url.origin;
}

function genericServerError() {
  return new Response(JSON.stringify({ error: "Something went wrong. Please try again." }), {
    status: 500,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function isProtectedAppNavigation(request, url) {
  if (request.method.toUpperCase() !== "GET") return false;
  if (url.pathname.startsWith("/api/")) return false;
  if (url.pathname.startsWith("/_next/")) return false;
  if (url.pathname.includes(".")) return false;
  return PROTECTED_APP_PATHS.some((path) => {
    return url.pathname === path || url.pathname.startsWith(`${path}/`);
  });
}

function appSigninRedirect(request, url, clearSession = false) {
  const redirectUrl = new URL("/signin", request.url);
  if (clearSession) redirectUrl.searchParams.set("access", "private-preview");
  redirectUrl.searchParams.set("returnTo", `${url.pathname}${url.search}${url.hash}`);
  const headers = new Headers({
    Location: redirectUrl.toString(),
    "cache-control": "no-store"
  });
  if (clearSession) headers.append("Set-Cookie", clearSessionCookie());
  return new Response(null, { status: 302, headers });
}

async function protectedAppNavigationResponse(context, url) {
  if (!isProtectedAppNavigation(context.request, url)) return null;
  const identity = await getAuthenticatedIdentity(context);
  if (identity.ok) return null;
  const session = await verifyAppSession(context.request, context.env);
  const clearSession = Boolean(session?.email && identity.response?.status === 403);
  return appSigninRedirect(context.request, url, clearSession);
}

function noStoreAssetResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store, max-age=0, must-revalidate");
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (RETIRED_PATHS.has(url.pathname)) {
    return new Response("Not found", {
      status: 404,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8"
      }
    });
  }

  if (isCrossOriginApiMutation(context.request, url)) {
    return new Response(JSON.stringify({ error: "Cross-origin request blocked." }), {
      status: 403,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8"
      }
    });
  }

  try {
    const gated = await protectedAppNavigationResponse(context, url);
    if (gated) return gated;

    const response = await context.next();
    if (NO_STORE_ASSET_PATHS.has(url.pathname)) {
      return noStoreAssetResponse(response);
    }
    // Per-request CSP nonce: only for HTML navigations. Rewriting binary
    // responses or JSON is a waste of CPU + RAM.
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/html") && context.request.method.toUpperCase() === "GET") {
      const nonce = generateNonce();
      const body = await response.text();
      const patched = chainInject(body, ["script", "style", "link"], nonce);
      const headers = new Headers(response.headers);
      // Rewriting HTML changes the byte length. Keep stale length/encoding out
      // of the Node self-host path so browsers do not truncate the RSC stream.
      headers.delete("content-length");
      headers.delete("content-encoding");
      headers.set("content-security-policy", buildCspHeader(nonce));
      // Expose the nonce so client code that needs to dynamically inject
      // a script tag can read it from a <meta> if added there in future.
      headers.set("x-csp-nonce", nonce);
      return new Response(patched, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }
    return response;
  } catch (error) {
    // Log structurally so wrangler tail surfaces it; forward to Sentry if the
    // server-side DSN is configured. Errors never reach the client verbatim.
    const path = `${url.pathname}${url.search ? "?_=_" : ""}`;
    console.error(JSON.stringify({
      level: "error",
      event: "middleware.unhandled",
      method: context.request.method,
      path,
      message: String(error?.message || error || "unknown-error").slice(0, 200)
    }));
    if (sentryEnabled(context.env)) {
      captureException(context, error, { path, method: context.request.method });
    }
    return genericServerError();
  }
}
