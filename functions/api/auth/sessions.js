import {
  getAuthenticatedIdentity,
  jsonResponse,
  normalizeEmail
} from "../_auth.js";
import {
  clearSessionCookie,
  revokeAllAppSessionsForEmail,
  revokeCurrentAppSession
} from "../_app_session.js";

function withClearSessionCookie(response) {
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", clearSessionCookie());
  return new Response(response.body, {
    status: response.status,
    headers
  });
}

async function readJson(request) {
  try { return await request.json(); }
  catch { return {}; }
}

export async function onRequest(context) {
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;

  const method = context.request.method.toUpperCase();
  if (method === "GET") {
    return jsonResponse(200, {
      current: {
        email: normalizeEmail(identity.email),
        provider: identity.provider || "",
        sessionId: identity.sessionId || "",
        issuedAt: identity.issuedAt || 0,
        expiresAt: identity.expiresAt || 0,
        revocable: Boolean(identity.revocable)
      }
    });
  }

  if (method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const payload = await readJson(context.request);
  const action = String(payload.action || "").trim().toLowerCase();
  if (action === "revoke_current") {
    const revoked = await revokeCurrentAppSession(context.request, context.env);
    return withClearSessionCookie(jsonResponse(200, {
      ok: true,
      revoked: "current",
      revocable: Boolean(revoked?.revocable)
    }));
  }

  if (action === "revoke_all") {
    await revokeAllAppSessionsForEmail(context.env, identity.email);
    return withClearSessionCookie(jsonResponse(200, {
      ok: true,
      revoked: "all"
    }));
  }

  return jsonResponse(400, { error: "Unsupported session action." });
}
