// Placeholder — `scripts/build.mjs` rewrites this literal in `dist/sw.js`
// with the build timestamp + git short SHA. Release checks verify the
// placeholder is present in source and absent in dist after build.
const APP_VERSION = "__SW_VERSION__";
const CACHE_NAME = `sexualsync-shell-${APP_VERSION}`;
const CORE_ASSETS = [
  "/",
  "/signin",
  "/offline",
  "/thank-you",
  "/manifest.webmanifest",
  "/app-icon.svg",
  "/brand/marks/app-icon-180.png",
  "/brand/marks/app-icon-192.png",
  "/brand/marks/app-icon-512.png",
  "/brand/marks/favicon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    })
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (event.data?.type === "GET_VERSION" && event.source) {
    event.source.postMessage({ type: "SW_VERSION", version: APP_VERSION });
  }
});

// ---- Web Push -----------------------------------------------------------

function notificationUrl(value) {
  try {
    const url = new URL(value || "/", self.registration.scope);
    const scope = new URL(self.registration.scope);
    if (url.origin !== scope.origin) return "/";
    return `${url.pathname}${url.search}${url.hash}` || "/";
  } catch {
    return "/";
  }
}

self.addEventListener("push", (event) => {
  // Defaults are lock-screen-safe: no product name, no partner name, no
  // intimacy context. Final guardrail if a server callsite forgets to scrub.
  let data = { title: "New notification", body: "Tap to view." };
  try {
    if (event.data) {
      data = { ...data, ...event.data.json() };
    }
  } catch {
    // payload wasn't JSON; fall back to defaults
  }
  const title = data.title || "New notification";
  const actionUrls = {};
  if (Array.isArray(data.actions)) {
    data.actions.forEach((action) => {
      if (action?.action && action?.url) actionUrls[String(action.action).slice(0, 32)] = notificationUrl(action.url);
    });
  }
  const options = {
    body: data.body || "Tap to view.",
    // Raster, not SVG: Android Chrome renders SVG notification icons as the
    // generic bell. iOS ignores both and uses the app icon.
    icon: "/brand/marks/app-icon-192.png",
    badge: "/brand/marks/app-icon-192.png",
    tag: data.tag || "sexualsync",
    renotify: true,
    data: { url: notificationUrl(data.url), actions: actionUrls }
  };
  if (Array.isArray(data.actions)) {
    options.actions = data.actions.slice(0, 2).map((action) => ({
      action: String(action.action || "").slice(0, 32),
      title: String(action.title || "").slice(0, 48)
    })).filter((action) => action.action && action.title);
  }
  const tasks = [self.registration.showNotification(title, options)];
  // App-icon badge (the home-screen count). When the server includes a numeric
  // `badge` in the push payload (the recipient's current "needs you" count), set
  // it here so the icon stays live while the app is closed. Forward-compatible:
  // dormant until the server sends `badge`. A count is never content, so it's
  // lock-screen-safe. setAppBadge is available on installed PWAs (iOS 16.4+).
  if (typeof data.badge === "number" && self.navigator && typeof self.navigator.setAppBadge === "function") {
    const n = Math.max(0, Math.floor(data.badge));
    if (n > 0) {
      tasks.push(self.navigator.setAppBadge(n).catch(() => {}));
    } else if (typeof self.navigator.clearAppBadge === "function") {
      tasks.push(self.navigator.clearAppBadge().catch(() => {}));
    }
  }
  event.waitUntil(Promise.all(tasks));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.action && event.notification.data?.actions?.[event.action])
    || (event.notification.data && event.notification.data.url)
    || "/";
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Focus any open window first. WindowClient.navigate() rejects for
    // uncontrolled clients and is flaky on iOS standalone, so fall back to a
    // fresh window instead of silently landing on the wrong page.
    for (const client of clients) {
      if (client.url.includes(self.registration.scope) && "focus" in client) {
        try {
          const focused = await client.focus();
          await (focused || client).navigate(url);
          return;
        } catch {
          break;
        }
      }
    }
    try {
      await self.clients.openWindow(url);
    } catch {
      // No gesture context / popup blocked — nothing further we can do.
    }
  })());
});

// CacheStorage reads can reject under private-mode/zero-quota conditions; a
// failed match must degrade to "not cached", never break the response path.
async function safeMatch(request, options) {
  try {
    return await caches.match(request, options);
  } catch {
    return undefined;
  }
}

// Cache writes are best-effort: tie them to the event so iOS doesn't kill the
// SW mid-put, and swallow quota failures (private mode) — the response was
// already returned to the page either way.
function cachePut(event, request, response) {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.put(request, response)).catch(() => {})
  );
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Same-origin only: a cross-origin GET whose pathname happens to collide
  // with a shell path must not be intercepted or written into the shell cache.
  if (url.origin !== self.location.origin) return;

  // Never intercept API calls, CF Access endpoints, or function-style routes.
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/cdn-cgi/")) return;

  // Content-hashed build assets (`/_next/static/*`) are immutable: Next puts a
  // content hash in every chunk/CSS/media filename, so a given URL never changes
  // bytes. Cache-first is therefore safe and is the cold-launch win — an iOS
  // standalone PWA reopens as a fresh process and would otherwise re-download the
  // whole JS/CSS payload over the network every launch. A new build requests new
  // hashed URLs; the versioned CACHE_NAME drops the stale set on activate.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith((async () => {
      const cached = await safeMatch(event.request);
      if (cached) return cached;
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          cachePut(event, event.request, response.clone());
        }
        return response;
      } catch {
        return Response.error();
      }
    })());
    return;
  }

  // HTML stays network-first. Static shell assets are stale-while-revalidate so
  // repeat opens paint from cache while the new version warms in the background.
  const requestPath = `${url.pathname}${url.search}`;
  const isShellAsset = CORE_ASSETS.includes(requestPath) || CORE_ASSETS.includes(url.pathname);
  const isNavigation = event.request.mode === "navigate";

  const isStaticShellAsset = isShellAsset && !isNavigation && url.pathname !== "/";
  if (isStaticShellAsset) {
    event.respondWith((async () => {
      const cached = await safeMatch(event.request) || await safeMatch(url.pathname);
      const update = fetch(event.request).then((response) => {
        if (response.ok) cachePut(event, event.request, response.clone());
        return response;
      }).catch(() => null);
      return cached || await update || Response.error();
    })());
    return;
  }

  // ALL same-origin navigations — not just the precached shell paths. This is
  // what lets a cold offline launch of the installed PWA (start_url is
  // /signin?source=pwa, and users live on /sexboard, /chat, /space/...) paint
  // a cached page or the neutral /offline fallback instead of the browser's
  // raw connection-error screen.
  if (!isNavigation) return;

  event.respondWith((async () => {
    // Network-first, but don't hang on lie-fi. A connected-but-stalled link
    // (high-latency 3G/edge) would otherwise block on the browser's ~30-90s
    // TCP timeout before the catch fires, so the shell looks frozen exactly
    // when it should degrade. Race the fetch against a short timeout and fall
    // back to cache. The orphaned fetch is harmless — it just won't be used.
    const NAV_TIMEOUT_MS = 3000;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("slow-network")), NAV_TIMEOUT_MS);
    });
    try {
      const response = await Promise.race([fetch(event.request), timeout]);
      clearTimeout(timer);
      // Only cache good responses: a cached 500/404 would replay as the
      // "offline" experience for that route until the next deploy.
      if (response.ok) cachePut(event, event.request, response.clone());
      return response;
    } catch {
      clearTimeout(timer);
      // ignoreSearch so /signin?source=pwa (and any ?source=shortcut route)
      // matches the cached copy of its base path.
      const cached = await safeMatch(event.request, { ignoreSearch: true });
      if (cached) return cached;
      // Offline/timed-out navigations get a dedicated neutral fallback rather
      // than "/" (the signin/marketing shell), which would make an
      // authenticated user look logged out.
      return (await safeMatch("/offline")) || Response.error();
    }
  })());
});
