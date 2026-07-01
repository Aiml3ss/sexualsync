import {
  getAuthenticatedIdentity,
  jsonResponse
} from "./_auth.js";
import {
  authorizeWorkspaceAccess,
  cleanText,
  workspaceIdFromPayload,
  workspaceIdFromRequest
} from "./_workspaces.js";
import { clearActivity, dismissActivityItems, markActivityRead, readActivity } from "./_activity.js";

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export async function onRequest(context) {
  const method = context.request.method.toUpperCase();
  if (!["GET", "POST", "PATCH"].includes(method)) {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;

  const payload = method === "GET" ? {} : await readJson(context.request);
  const requestedWorkspaceId = method === "GET"
    ? workspaceIdFromRequest(context.request)
    : workspaceIdFromPayload(payload, workspaceIdFromRequest(context.request));
  const access = await authorizeWorkspaceAccess(context, identity, requestedWorkspaceId);
  if (!access.ok) return access.response;

  if (method === "GET") {
    return jsonResponse(200, await readActivity(context.env, access.workspace.id, identity.email));
  }

  const action = cleanText(payload.action, 40);
  if (action === "mark_read") {
    const resource = cleanText(payload.resource || "", 64);
    const body = await markActivityRead(context.env, access.workspace.id, identity.email, resource);
    return jsonResponse(200, body);
  }

  if (action === "dismiss") {
    const ids = Array.isArray(payload.ids) ? payload.ids : [];
    const body = await dismissActivityItems(context.env, access.workspace.id, identity.email, ids);
    return jsonResponse(200, body);
  }

  if (action === "clear") {
    const body = await clearActivity(context.env, access.workspace.id, identity.email);
    return jsonResponse(200, body);
  }

  return jsonResponse(400, { error: "Unsupported activity action." });
}
