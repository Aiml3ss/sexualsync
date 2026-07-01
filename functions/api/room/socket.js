import {
  getAuthenticatedIdentity,
  jsonResponse,
  normalizeEmail
} from "../_auth.js";
import {
  authorizeWorkspaceAccess,
  workspaceIdFromRequest
} from "../_workspaces.js";
import {
  liveRoomProxyRequest,
  liveRoomStub,
  liveRoomUnavailableResponse
} from "../_live_room.js";

export async function onRequest(context) {
  const method = context.request.method.toUpperCase();
  if (method !== "GET") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;

  const workspaceId = workspaceIdFromRequest(context.request);
  const access = await authorizeWorkspaceAccess(context, identity, workspaceId);
  if (!access.ok) return access.response;

  const stub = liveRoomStub(context.env, access.workspace.id);
  if (!stub) return liveRoomUnavailableResponse();

  if (context.request.headers.get("Upgrade") !== "websocket") {
    return jsonResponse(200, { realtime: true, workspaceId: access.workspace.id });
  }

  const actorEmail = normalizeEmail(identity.email);
  const actorName = access.actorName
    || access.workspace.members?.find((member) => normalizeEmail(member.email) === actorEmail)?.displayName
    || identity.displayName
    || "";

  return stub.fetch(liveRoomProxyRequest(context, {
    workspaceId: access.workspace.id,
    actorEmail,
    actorName
  }));
}
