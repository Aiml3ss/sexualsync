import { revokeCurrentAppSession } from "../_app_session.js";

const COOKIE_CLEAR_DOMAINS = [""];

function clearCookie(name, path = "/", domain = "") {
  return [
    `${name}=`,
    `Path=${path}`,
    domain ? `Domain=${domain}` : "",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Secure",
    "SameSite=Lax",
    "HttpOnly"
  ].filter(Boolean).join("; ");
}

function appendCookieClears(headers, name, path = "/") {
  for (const domain of COOKIE_CLEAR_DOMAINS) {
    headers.append("Set-Cookie", domain ? clearCookie(name, path, domain) : clearCookie(name, path));
  }
}

export async function onRequest(context) {
  const method = context.request.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed." }), {
      status: 405,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  }

  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });

  // GET must stay (the Sign out links are plain <a href> navigations), but a
  // state-changing GET bypasses the middleware CSRF guard (it only inspects
  // POST/PUT/PATCH/DELETE) and SameSite=Lax attaches the cookie on top-level
  // navigations — so a hostile page could force-logout via a cross-site link.
  // Gate the revocation on Sec-Fetch-Site: same-origin/same-site/none (direct
  // navigation) revoke as before; an explicit cross-site navigation just
  // redirects without touching the session. Browsers without the header are
  // allowed through (defense-in-depth only; logout is availability-impact).
  const fetchSite = String(context.request.headers.get("sec-fetch-site") || "").toLowerCase();
  const crossSiteGet = method === "GET" && fetchSite === "cross-site";

  if (!crossSiteGet) {
    await revokeCurrentAppSession(context.request, context.env).catch(() => null);
    appendCookieClears(headers, "sxs-session");
    appendCookieClears(headers, "sxs-refresh");
    appendCookieClears(headers, "sxs-launch");
    appendCookieClears(headers, "sxs-oauth", "/api/auth/google");
  }

  if (method === "GET") {
    headers.delete("content-type");
    headers.set("Location", "/signed-out");
    return new Response(null, { status: 303, headers });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
