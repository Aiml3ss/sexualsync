import { jsonResponse } from "./_auth.js";
import { readPlatformState } from "./_workspaces.js";

function isCoupleWorkspace(workspace) {
  const status = String(workspace?.status || "active").toLowerCase();
  const mode = String(workspace?.productMode || "couples").toLowerCase();
  const activeMemberCount = Array.isArray(workspace?.members)
    ? workspace.members.filter((member) => String(member?.status || "active").toLowerCase() === "active").length
    : 0;

  return status === "active" && mode.includes("couples") && activeMemberCount >= 2;
}

export function countCouplesInSync(workspaces = []) {
  return workspaces.filter(isCoupleWorkspace).length;
}

export async function onRequest(context) {
  if (context.request.method !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const { workspaces } = await readPlatformState(context.env || {});
  return jsonResponse(200, {
    couplesInSync: countCouplesInSync(workspaces)
  });
}
