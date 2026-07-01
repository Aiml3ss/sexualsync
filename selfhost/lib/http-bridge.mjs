// Bridges Node's http req/res to the Web Request/Response objects the
// Cloudflare Pages handlers expect. Node 20+ exposes Request/Response/Headers
// (undici) and stream <-> web conversions, so the handlers need no changes.

import { Readable } from "node:stream";

function headerValue(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function firstHeaderToken(value) {
  return String(value || "").split(",")[0].trim();
}

function cleanHeaderValue(value, max = 240) {
  return String(value || "").trim().replace(/[\r\n]/g, "").slice(0, max);
}

function socketRemoteAddress(req) {
  return cleanHeaderValue(req.socket?.remoteAddress || req.connection?.remoteAddress || "", 120);
}

function canonicalClientIp(req, { trustProxy = false } = {}) {
  const proxyIp = trustProxy
    ? firstHeaderToken(headerValue(req, "x-forwarded-for"))
      || cleanHeaderValue(headerValue(req, "x-real-ip"), 120)
      || cleanHeaderValue(headerValue(req, "cf-connecting-ip"), 120)
    : "";
  return cleanHeaderValue(proxyIp || socketRemoteAddress(req) || "global", 120);
}

function requestProto(req, trustProxy) {
  const proto = trustProxy ? firstHeaderToken(headerValue(req, "x-forwarded-proto")) : "";
  return proto === "https" || proto === "http" ? proto : "http";
}

function requestHost(req, trustProxy, allowedHosts) {
  const forwarded = trustProxy ? firstHeaderToken(headerValue(req, "x-forwarded-host")) : "";
  const direct = req.headers.host || "localhost";
  if (forwarded) {
    // Defense in depth against X-Forwarded-Host injection. When the operator has
    // declared their public origin(s) — PUBLIC_BASE_URL / AUTH_BASE_URL, surfaced
    // here as `allowedHosts` — only honor a forwarded host that matches one of
    // them. A correctly-configured proxy always matches; a spoofed value (or a
    // proxy that passes the client's header through unsanitised) is ignored in
    // favour of the direct Host. With no allowlist configured (zero-config /
    // local), behaviour is unchanged so existing trusted-proxy setups that never
    // set a base URL keep working.
    const hasAllowlist = allowedHosts && allowedHosts.size > 0;
    if (!hasAllowlist || allowedHosts.has(forwarded.toLowerCase())) {
      return cleanHeaderValue(forwarded, 240);
    }
  }
  return cleanHeaderValue(direct, 240);
}

/**
 * Convert an incoming Node request into a Web Request.
 *
 * Origin is derived from the Host header. When `trustProxy` is set (the app is
 * behind a reverse proxy / load balancer), X-Forwarded-Proto and
 * X-Forwarded-Host take precedence so OAuth redirect URIs and same-origin CSRF
 * checks see the public origin, not the internal one. `allowedHosts` (a Set of
 * lower-cased host[:port] values derived from the configured base URLs) gates
 * which X-Forwarded-Host values are trusted; an empty/omitted set preserves the
 * legacy "trust any forwarded host" behaviour.
 */
export function nodeRequestToWeb(req, { trustProxy = false, allowedHosts = null } = {}) {
  const proto = requestProto(req, trustProxy);
  const host = requestHost(req, trustProxy, allowedHosts);
  const url = `${proto}://${host}${req.url}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === "cf-connecting-ip") continue;
    if (!trustProxy && (lower === "x-forwarded-for" || lower === "x-real-ip")) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }
  headers.set("cf-connecting-ip", canonicalClientIp(req, { trustProxy }));

  const method = (req.method || "GET").toUpperCase();
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }
  return new Request(url, init);
}

/**
 * Stream a Web Response back through Node's res. Preserves multiple Set-Cookie
 * headers (auth flows append more than one), which a naive header copy drops.
 */
export async function sendWebResponse(res, webRes) {
  if (res.headersSent) return;
  res.statusCode = webRes.status;

  const setCookies = typeof webRes.headers.getSetCookie === "function" ? webRes.headers.getSetCookie() : [];
  webRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    res.setHeader(key, value);
  });
  if (setCookies.length) res.setHeader("set-cookie", setCookies);

  if (!webRes.body) {
    res.end();
    return;
  }
  try {
    const nodeStream = Readable.fromWeb(webRes.body);
    nodeStream.on("error", () => res.destroy());
    nodeStream.pipe(res);
  } catch {
    const buf = Buffer.from(await webRes.arrayBuffer());
    res.end(buf);
  }
}
