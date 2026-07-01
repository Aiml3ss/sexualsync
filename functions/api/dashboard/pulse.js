// v2 · Sprint C · Dashboard pulse — server picks the moments that should
// surface in the dashboard so the client doesn't have to scrape all of state
// just to find one fresh approval.

import {
  getAuthenticatedIdentity,
  jsonResponse,
  normalizeEmail
} from "../_auth.js";
import {
  authorizeWorkspaceAccess,
  workspaceIdsForDataAccess,
  workspaceIdFromRequest
} from "../_workspaces.js";
import { readRequests } from "../request-board.js";
import { readIdeasForIds } from "../fantasy-backlog.js";

export async function onRequest(context) {
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;
  const env = context.env;
  const workspaceId = workspaceIdFromRequest(context.request);
  const access = await authorizeWorkspaceAccess(context, identity, workspaceId);
  if (!access.ok) return access.response;
  const ws = access.workspace;
  const actorEmail = normalizeEmail(identity.email);
  const dataWorkspaceIds = access.dataWorkspaceIds;

  const requests = (await readRequests(env, dataWorkspaceIds)).filter(
    (r) => dataWorkspaceIds.includes(r.workspaceId || "legacy-couple")
  );
  const ideas = (await readIdeasForIds(env, dataWorkspaceIds)).filter(
    (i) => dataWorkspaceIds.includes(i.workspaceId || "legacy-couple")
  );

  // Fresh approvals: requests user sent where decisions include a Yes.
  const freshApprovals = requests
    .filter((r) => normalizeEmail(r.requesterEmail) === actorEmail)
    .filter((r) => ["reviewed", "on_deck"].includes(String(r.status || "").toLowerCase()))
    .filter((r) => Array.isArray(r.decisions) && r.decisions.some((d) => /^yes$/i.test(d.decision || "")))
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  // Fresh positive reactions on the user's fantasies that haven't been acked.
  const freshReactions = ideas
    .filter((i) => normalizeEmail(i.addedByEmail) === actorEmail)
    .flatMap((idea) => (Array.isArray(idea.reactions) ? idea.reactions : []).map((r) => ({ idea, reaction: r })))
    .filter(({ reaction }) => reaction.tone === "positive" && !reaction.seenByAuthorAt && normalizeEmail(reaction.by) !== actorEmail)
    .sort((a, b) => new Date(b.reaction.createdAt || 0) - new Date(a.reaction.createdAt || 0));

  // Partner's most recent fantasy (within last 72h).
  const members = (ws.members || []).filter((m) => m.status === "active");
  const partner = members.find((m) => normalizeEmail(m.email) !== actorEmail);
  const partnerEmail = partner ? normalizeEmail(partner.email) : "";
  const cutoff = Date.now() - 1000 * 60 * 60 * 72;
  const partnerIdeas = ideas
    .filter((i) => normalizeEmail(i.addedByEmail) === partnerEmail)
    .filter((i) => new Date(i.createdAt || 0).getTime() > cutoff)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const latestPartnerIdea = partnerIdeas[0] || null;

  return jsonResponse(200, {
    freshApprovals: freshApprovals.slice(0, 6).map((r) => ({
      id: r.id,
      requestId: r.id,
      acts: (r.decisions || []).filter((d) => /^yes$/i.test(d.decision)).map((d) => d.label),
      feedback: r.feedback || "",
      updatedAt: r.updatedAt,
      partnerName: r.reviewerName || "",
    })),
    freshReactions: freshReactions.slice(0, 6).map(({ idea, reaction }) => ({
      ideaId: idea.id,
      ideaText: idea.text,
      reaction: {
        by: reaction.by,
        glyph: reaction.glyph,
        label: reaction.label,
        tone: reaction.tone,
        note: reaction.note || "",
        createdAt: reaction.createdAt,
      },
    })),
    latestPartnerIdea: latestPartnerIdea
      ? { id: latestPartnerIdea.id, text: latestPartnerIdea.text, createdAt: latestPartnerIdea.createdAt, addedByName: latestPartnerIdea.addedByName }
      : null,
  });
}
