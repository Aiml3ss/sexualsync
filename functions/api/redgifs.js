// GET /api/redgifs?url=<redgifs link>   (or ?id=<gifId>)
//
// Resolves a RedGifs link to its direct video URLs so the Sext composer can
// render the clip in its own muted <video> — the same anonymized treatment the
// shelf uses (see _redgifs.js). A pasted RedGifs link (incl. the Share-button
// format) goes through the SAME candidate extraction the shelf resolver uses, so
// chat GIFs resolve exactly like shelf GIFs. We try each candidate until one
// resolves; resolution must happen server-side because RedGifs CORS-blocks the
// gif endpoint from the browser.
//
// Authenticated + rate-limited. Token, 30-day cache, circuit breaker, and the
// public-page fallback all live in _redgifs.js.

import { getAuthenticatedIdentity, jsonResponse } from "./_auth.js";
import { checkRateLimit, rateLimitResponse } from "./_rate_limit.js";
import { redgifsDirectUrl, redgifsCandidatesFromText, redgifsSearch } from "./_redgifs.js";

export async function onRequestGet(context) {
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;

  const { env, request } = context;
  const params = new URL(request.url).searchParams;

  // GIF picker search: ?action=search&q=<terms>. Returns poster + video URLs
  // for the composer's GIF grid. Own rate-limit bucket (each keystroke can
  // search, so it's chattier than single-gif resolves) — the client debounces.
  if ((params.get("action") || "") === "search") {
    const limited = await checkRateLimit(env, {
      bucket: "redgifs-search",
      key: identity.email || "anon",
      limit: 90,
      windowSeconds: 5 * 60,
    });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { results, pages } = await redgifsSearch(env, params.get("q") || "", {
      order: params.get("order") || "trending",
      page: Number(params.get("page")) || 1,
    });
    return jsonResponse(200, { ok: true, results, pages });
  }

  // Prefer the full URL (yields several candidates); fall back to a bare id.
  const candidates = redgifsCandidatesFromText(
    `${params.get("url") || ""} ${params.get("id") || ""}`,
  ).slice(0, 5);
  if (!candidates.length) return jsonResponse(400, { error: "No RedGifs id" });

  const limited = await checkRateLimit(env, {
    bucket: "redgifs",
    key: identity.email || "anon",
    limit: 120,
    windowSeconds: 5 * 60,
  });
  if (!limited.ok) return rateLimitResponse(limited.retryAfter);

  for (const id of candidates) {
    const direct = await redgifsDirectUrl(env, id);
    if (direct && (direct.hd || direct.sd)) {
      return jsonResponse(200, {
        ok: true,
        hd: direct.hd || "",
        sd: direct.sd || "",
        poster: direct.poster || "",
      });
    }
  }
  // None resolved (gif removed, RedGifs unreachable). The client shows a plain
  // "open the link" affordance rather than a broken embed.
  return jsonResponse(404, { ok: false });
}
