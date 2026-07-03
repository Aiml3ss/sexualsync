// RedGifs API client — fetches the direct video URL (mp4/webm) for a gif id
// so we can render content in our own <video> element with our own chrome.
// Avoids the cross-origin iframe approach which leaked the creator handle,
// share/expand buttons, and a "Watch on RedGifs" tap target that pushed
// users out of Sexualsync.
//
// API surface:
//   await redgifsDirectUrl(env, gifId) → { hd, sd, poster } | null
//
// Auth flow (RedGifs v2 / api.redgifs.com):
//   GET  https://api.redgifs.com/v2/auth/temporary  → { token }
//   GET  https://api.redgifs.com/v2/gifs/{id}       (Authorization: Bearer token)
// Every request needs a non-empty User-Agent (see fetchWithRetry) — RedGifs
// started 400/401-ing empty-UA calls, which is what silently emptied search.
//
// Token is cached in KV (shared across the workspace, not per-user) with
// a 12-hour TTL even though RedGifs gives them ~24h, so we refresh
// proactively before they go stale mid-request.

import { getStore } from "./_kv.js";

const REDGIFS_CACHE_STORE = "sexualsync-redgifs-cache";
// The RedGifs Bearer token is a credential, so it lives in a dedicated store
// that's encrypted at rest (audit L1). The circuit-breaker + GIF-metadata cache
// also use encrypted JSON storage because GIF ids/direct URLs can reveal what a
// private room touched.
const TOKEN_CACHE_STORE = "sexualsync-redgifs-token";
const TOKEN_KEY    = "redgifs:v2:token";
const TOKEN_TTL_S  = 12 * 60 * 60;     // refresh after 12h
const CIRCUIT_KEY  = "redgifs:v2:circuit";
const CIRCUIT_OPEN_MS = 10 * 60 * 1000;
const GIF_CACHE_KEY = (id) => `redgifs:v2:gif:${id}`;
const GIF_CACHE_TTL_S = 60 * 60 * 24 * 30; // 30 days; direct URLs are pretty stable

const RG_API = "https://api.redgifs.com/v2";
const RG_WATCH = "https://www.redgifs.com/watch";

// RedGifs tags each clip's `sexuality`; we drop these orientations from search
// results (no server-side filter is honoured). Straight / lesbian / untagged stay.
const EXCLUDE_SEXUALITY = new Set(["gay", "trans", "transgender", "transsexual", "shemale"]);

// RedGifs blocks Cloudflare's datacenter IPs from its API (auth + search). When
// REDGIFS_PROXY is set, route api.redgifs.com calls through that operator-run
// byte-proxy (URL shape `https://host/path?url=<encoded target>`), which
// egresses from an unblocked IP and forwards our request headers (incl.
// Authorization). Self-host leaves it unset and calls RedGifs directly. Only
// api.redgifs.com calls are proxied; the public watch-page fallback
// (www.redgifs.com) stays direct — it already works from every IP.
function rgApiUrl(env, apiUrl) {
  const proxy = String(env?.REDGIFS_PROXY || "").trim();
  return proxy ? `${proxy}${encodeURIComponent(apiUrl)}` : apiUrl;
}
const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

// Extract ordered RedGifs id candidates from raw text (a pasted URL or a bare
// id). Mirrors the shelf resolver (functions/api/shelf.js redgifsIdCandidates /
// redgifsLookupIds) so a Sext GIF resolves exactly like a shelf one — including
// Share-button links with an unexpected path or a dashed slug. The caller tries
// each candidate until one resolves; the RedGifs API id is case-insensitive.
function redgifsSegmentCandidates(value) {
  const raw = String(value || "").toLowerCase().trim();
  if (!raw) return [];
  const segment = raw.split(/[/?#]/)[0].replace(/[^a-z0-9-]/g, "");
  if (!segment) return [];
  const out = [];
  if (/^[a-z0-9]+$/.test(segment)) out.push(segment);
  const parts = segment.split("-").filter(Boolean);
  if (parts.length > 1) {
    out.push(parts[parts.length - 1]);
    out.push(segment.replace(/-/g, ""));
  } else if (segment.includes("-")) {
    out.push(segment.replace(/-/g, ""));
  }
  return out;
}

export function redgifsCandidatesFromText(text) {
  const source = String(text || "");
  const candidates = [];
  const add = (value) => {
    for (const id of redgifsSegmentCandidates(value)) {
      if (id && !candidates.includes(id)) candidates.push(id);
    }
  };
  // RedGifs page URLs: watch / ifr / detail, or any /<word>/<id> path.
  for (const m of source.matchAll(/redgifs\.com\/(?:watch\/|ifr\/|detail\/|[a-z]+\/)([a-z0-9-]+)/ig)) add(m[1]);
  // Direct media / thumbs URLs.
  for (const m of source.matchAll(/(?:media|thumbs\d*)\.redgifs\.com\/([a-z0-9]+)/ig)) add(m[1]);
  // A bare id pasted on its own — only when it isn't a URL (no slash/dot) and
  // has no RedGifs host, so a non-RedGifs link doesn't yield a junk candidate.
  if (!/redgifs\.com/i.test(source) && !/[/.]/.test(source.trim())) add(source);
  return candidates;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt, response) {
  const retryAfter = Number(response?.headers?.get?.("retry-after") || 0);
  if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter < 60) {
    return retryAfter * 1000;
  }
  return 250 * Math.pow(2, attempt) + Math.floor(Math.random() * 120);
}

// RedGifs now rejects an EMPTY User-Agent (auth mint → 400, search/gif → 401),
// which is what broke GIF search: our calls set only `accept`, and an empty
// User-Agent can reach RedGifs when the request runtime (or an operator proxy,
// where one is configured) forwards a blank value — token mint then fails and
// every search returns zero. A real UA passes; no header at all also passes.
// Send an explicit browser UA on every api.redgifs.com call. All RedGifs
// fetches in this file go through here, so this covers mint, search, gif
// lookup, and the watch-page fallback in one place.
const RG_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

async function fetchWithRetry(url, init = {}, { retries = 2 } = {}) {
  const withUa = {
    ...init,
    headers: { "user-agent": RG_USER_AGENT, ...(init.headers || {}) },
  };
  let lastResponse = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, withUa);
      lastResponse = res;
      if (res.ok || !RETRY_STATUSES.has(res.status) || attempt === retries) {
        return res;
      }
      await sleep(retryDelayMs(attempt, res));
    } catch (error) {
      if (attempt === retries) throw error;
      await sleep(retryDelayMs(attempt, null));
    }
  }
  return lastResponse;
}

async function readCircuit(env) {
  try {
    const v = await getStore(env, REDGIFS_CACHE_STORE).get(CIRCUIT_KEY, { type: "json" });
    if (v && typeof v === "object" && v.openUntil && Date.now() < v.openUntil) return v;
  } catch {}
  return null;
}

async function openCircuit(env, reason, status = 0) {
  try {
    await getStore(env, REDGIFS_CACHE_STORE).setJSON(
      CIRCUIT_KEY,
      {
        reason: String(reason || "unavailable").slice(0, 80),
        status: Number(status) || 0,
        openedAt: Date.now(),
        openUntil: Date.now() + CIRCUIT_OPEN_MS
      },
      { expirationTtl: Math.ceil(CIRCUIT_OPEN_MS / 1000) }
    );
  } catch {}
}

function shouldOpenCircuit(res) {
  return res && (res.status === 429 || res.status >= 500);
}

// ---- Token management -----------------------------------------------------

async function readCachedToken(env) {
  try {
    const v = await getStore(env, TOKEN_CACHE_STORE).get(TOKEN_KEY, { type: "json" });
    if (v && typeof v === "object" && v.token && v.expiresAt) {
      if (Date.now() < v.expiresAt - 60_000) return v.token; // 1-min safety margin
    }
  } catch {}
  return null;
}

async function writeCachedToken(env, token) {
  try {
    await getStore(env, TOKEN_CACHE_STORE).setJSON(
      TOKEN_KEY,
      { token, expiresAt: Date.now() + TOKEN_TTL_S * 1000 },
      { expirationTtl: TOKEN_TTL_S }
    );
  } catch {}
}

async function fetchFreshToken(env) {
  try {
    const res = await fetchWithRetry(rgApiUrl(env, `${RG_API}/auth/temporary`), {
      method: "GET",
      headers: { "accept": "application/json" }
    });
    if (shouldOpenCircuit(res)) return { token: "", circuit: true, status: res.status };
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || typeof data.token !== "string") return null;
    return { token: data.token };
  } catch {
    return { token: "", circuit: true, status: 0 };
  }
}

async function getRedgifsToken(env) {
  const cached = await readCachedToken(env);
  if (cached) return cached;
  if (await readCircuit(env)) return null;
  const fresh = await fetchFreshToken(env);
  if (!fresh) return null;
  if (fresh.circuit) {
    await openCircuit(env, "auth", fresh.status);
    return null;
  }
  if (!fresh.token) return null;
  await writeCachedToken(env, fresh.token);
  return fresh.token;
}

// ---- Gif fetch ------------------------------------------------------------

async function readCachedGif(env, id) {
  try {
    const v = await getStore(env, REDGIFS_CACHE_STORE).get(GIF_CACHE_KEY(id), { type: "json" });
    if (v && typeof v === "object" && (v.hd || v.sd)) return v;
  } catch {}
  return null;
}

async function writeCachedGif(env, id, payload) {
  try {
    await getStore(env, REDGIFS_CACHE_STORE).setJSON(
      GIF_CACHE_KEY(id),
      payload,
      { expirationTtl: GIF_CACHE_TTL_S }
    );
  } catch {}
}

function htmlDecode(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function firstHtmlMatch(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return htmlDecode(match[1]);
  }
  return "";
}

function cleanMediaUrl(value, suffix = "") {
  const url = String(value || "").trim();
  if (!url || !/^https:\/\/media\.redgifs\.com\//i.test(url)) return "";
  if (suffix && !url.toLowerCase().includes(suffix)) return "";
  return url;
}

async function fetchPublicPageDirectUrl(id) {
  try {
    const res = await fetchWithRetry(`${RG_WATCH}/${encodeURIComponent(id)}`, {
      headers: { "accept": "text/html" },
    }, { retries: 1 });
    if (!res?.ok) return null;
    const html = await res.text();
    const hd = cleanMediaUrl(firstHtmlMatch(html, [
      /<meta\s+property=["']og:video["']\s+content=["']([^"']+\.mp4[^"']*)["']/i,
      /"contentUrl"\s*:\s*"([^"]+\.mp4[^"]*)"/i,
    ]), ".mp4");
    if (!hd) return null;
    const poster = cleanMediaUrl(firstHtmlMatch(html, [
      /"thumbnailUrl"\s*:\s*"([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i,
      /<meta\s+property=["']og:image["']\s+content=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/i,
      /<link\s+rel=["']preload["'][^>]+as=["']image["'][^>]+href=["']([^"']+)["']/i,
    ]));
    return { hd, sd: "", poster };
  } catch {
    return null;
  }
}

// Public — returns { hd, sd, poster } for a given gif id, or null if the
// API didn't cooperate. Both server-side cache hits and fresh fetches are
// returned in the same shape.
export async function redgifsDirectUrl(env, id, options = {}) {
  if (!id) return null;
  const cleaned = String(id).toLowerCase().trim();
  if (!cleaned) return null;

  const cached = await readCachedGif(env, cleaned);
  if (cached) return cached;
  if (options.cacheOnly) return null;
  if (await readCircuit(env)) {
    const fallback = await fetchPublicPageDirectUrl(cleaned);
    if (fallback) await writeCachedGif(env, cleaned, fallback);
    return fallback;
  }

  const token = await getRedgifsToken(env);
  if (!token) {
    const fallback = await fetchPublicPageDirectUrl(cleaned);
    if (fallback) await writeCachedGif(env, cleaned, fallback);
    return fallback;
  }

  try {
    const res = await fetchWithRetry(rgApiUrl(env, `${RG_API}/gifs/${encodeURIComponent(cleaned)}`), {
      headers: {
        "accept": "application/json",
        "authorization": `Bearer ${token}`
      }
    });
    if (res.status === 401 || res.status === 403) {
      try { await getStore(env, TOKEN_CACHE_STORE).delete(TOKEN_KEY); } catch {}
    }
    if (shouldOpenCircuit(res)) await openCircuit(env, "gif-fetch", res.status);
    if (!res.ok) {
      const fallback = await fetchPublicPageDirectUrl(cleaned);
      if (fallback) await writeCachedGif(env, cleaned, fallback);
      return fallback;
    }
    const data = await res.json().catch(() => null);
    const gif = data?.gif;
    if (!gif || !gif.urls) {
      const fallback = await fetchPublicPageDirectUrl(cleaned);
      if (fallback) await writeCachedGif(env, cleaned, fallback);
      return fallback;
    }
    // RedGifs returns urls.hd, urls.sd (both are .mp4), and urls.poster.
    // Some gifs are SD-only; degrade gracefully.
    const payload = {
      hd: typeof gif.urls.hd === "string" ? gif.urls.hd : "",
      sd: typeof gif.urls.sd === "string" ? gif.urls.sd : "",
      poster: typeof gif.urls.poster === "string" ? gif.urls.poster : "",
    };
    if (!payload.hd && !payload.sd) {
      const fallback = await fetchPublicPageDirectUrl(cleaned);
      if (fallback) await writeCachedGif(env, cleaned, fallback);
      return fallback;
    }
    await writeCachedGif(env, cleaned, payload);
    return payload;
  } catch {
    const fallback = await fetchPublicPageDirectUrl(cleaned);
    if (fallback) await writeCachedGif(env, cleaned, fallback);
    return fallback;
  }
}

// Search RedGifs for clips matching `query`, for the Sext GIF picker. Returns
// up to `count` results as { id, poster, sd, hd } — the picker shows the poster
// thumbnails and, on tap, sends the chosen clip as a normal RedGifs link, so
// resolution + the muted-<video> render reuse the single-gif path (no chrome,
// no creator-handle leak). Reuses the same Bearer token, retry, and circuit
// breaker as redgifsDirectUrl. Best-effort: returns [] on any failure so the
// composer just keeps its paste-a-link path.
export async function redgifsSearch(env, query, { order = "trending", count = 24, page = 1 } = {}) {
  const empty = { results: [], pages: 1 };
  const term = String(query || "").trim().slice(0, 80);
  if (!term) return empty;
  if (await readCircuit(env)) return empty;
  const token = await getRedgifsToken(env);
  if (!token) return empty;
  const safeCount = Math.min(40, Math.max(1, Number(count) || 24));
  const safePage = Math.min(100, Math.max(1, Number(page) || 1));
  // RedGifs filters on `query` (NOT `search_text` — that param is silently
  // ignored, returning a trending feed for every term). `order` works WITH the
  // query; only trending/top/latest are valid (best/oldest/empty return zero).
  // `page` drives infinite scroll; `pages` (total) is returned so the client
  // knows when to stop.
  const safeOrder = ["trending", "top", "latest"].includes(order) ? order : "trending";
  try {
    const res = await fetchWithRetry(
      rgApiUrl(env, `${RG_API}/gifs/search?query=${encodeURIComponent(term)}&order=${safeOrder}&count=${safeCount}&page=${safePage}`),
      { headers: { accept: "application/json", authorization: `Bearer ${token}` } },
    );
    // A rejected token is stale; drop it so the next call re-auths.
    if (res.status === 401 || res.status === 403) {
      try { await getStore(env, TOKEN_CACHE_STORE).delete(TOKEN_KEY); } catch {}
    }
    if (shouldOpenCircuit(res)) await openCircuit(env, "search", res.status);
    if (!res.ok) return empty;
    const data = await res.json().catch(() => null);
    const gifs = Array.isArray(data?.gifs) ? data.gifs : [];
    const out = [];
    for (const gif of gifs) {
      const urls = gif?.urls || {};
      const poster = typeof urls.poster === "string" ? urls.poster : "";
      const sd = typeof urls.sd === "string" ? urls.sd : "";
      const hd = typeof urls.hd === "string" ? urls.hd : "";
      // Need a poster to show in the grid and at least one video to play.
      if (!gif?.id || !poster || (!sd && !hd)) continue;
      // Straight-only: this is a private M/F couples app. RedGifs honours no
      // server-side sexuality filter, so we drop clips it tags gay / trans here.
      // Straight, lesbian, and untagged are kept.
      const sexuality = Array.isArray(gif.sexuality) ? gif.sexuality.map((s) => String(s).toLowerCase()) : [];
      if (sexuality.some((s) => EXCLUDE_SEXUALITY.has(s))) continue;
      out.push({ id: String(gif.id), poster, sd, hd });
    }
    return { results: out, pages: Math.max(1, Number(data?.pages) || 1) };
  } catch {
    return empty;
  }
}
