// v2 · Sprint F · Test push — fires a real server push to the caller so they
// can verify the end-to-end delivery path from Settings.

import { getStore } from "./_kv.js";
import {
  getAuthenticatedIdentity,
  jsonResponse,
  normalizeEmail,
} from "./_auth.js";
import {
  authorizeWorkspaceAccess,
  workspaceIdFromRequest
} from "./_workspaces.js";
import { pushToWorkspace } from "./_push.js";

const STATS_STORE_NAME = "sexualsync-push-stats";

async function recordTest(env, workspaceId, email) {
  try {
    const store = getStore(env, STATS_STORE_NAME);
    const key = `last-test:${workspaceId}:${email}`;
    await store.setJSON(key, { at: new Date().toISOString() });
  } catch {}
}

export async function onRequest(context) {
  const method = context.request.method.toUpperCase();
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;
  const env = context.env;
  let body = {};
  if (method === "POST") {
    try { body = await context.request.json(); } catch {}
  }
  const workspaceId = workspaceIdFromRequest(context.request) || body.workspaceId || "";
  const access = await authorizeWorkspaceAccess(context, identity, workspaceId);
  if (!access.ok) return access.response;
  const actorEmail = normalizeEmail(identity.email);

  if (method === "GET") {
    // Return last-delivered + last-test timestamps for the diagnostic row.
    try {
      const store = getStore(env, STATS_STORE_NAME);
      const [lastDelivered, lastTest] = await Promise.all([
        store.get(`last-delivered:${access.workspace.id}`, { type: "json" }).catch(() => null),
        store.get(`last-test:${access.workspace.id}:${actorEmail}`, { type: "json" }).catch(() => null),
      ]);
      return jsonResponse(200, {
        lastDelivered: lastDelivered?.at || null,
        lastTest: lastTest?.at || null,
      });
    } catch { return jsonResponse(200, { lastDelivered: null, lastTest: null }); }
  }

  if (method !== "POST") return jsonResponse(405, { error: "Method not allowed." });

  // Push to the workspace; onlyEmail filter delivers ONLY to the caller (not partner).
  // Sprint 0.2 — title and body kept lock-screen-safe. Test push is the only
  // push that's allowed to say "test" in the body since it's clearly a user-
  // initiated diagnostic and contains no relationship content.
  await pushToWorkspace(env, access.workspace.id, "__test__", {
    title: "Sexualsync",
    body: "Test notification — looking good.",
    tag: "push-test",
    url: "/",
    onlyEmail: actorEmail,
  }).catch(() => {});
  await recordTest(env, access.workspace.id, actorEmail);
  return jsonResponse(200, { ok: true });
}
