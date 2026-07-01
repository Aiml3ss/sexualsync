// Server-side "needs you" count for the PWA home-screen badge (Badging API).
// The push path (_notification_policy.notifyWorkspaceEvent) attaches this as
// `badge` so the service worker can keep the icon count live while the app is
// closed. The foreground badge (Sexboard) trues the icon to the FULL needsYou
// set on the next app open; this push count mirrors that set so the icon
// matches what the app shows in "Needs you":
//   - Asks awaiting your reply (you're the reviewer, still pending/sent)
//   - Kinks needing your response (authored by your partner, no reply from you)
//   - Pile needing you (revealed, or you haven't dropped your acts yet)
//   - Blind Reveal needing you (open, and you haven't answered yet)
// Unread chat is the only needsYou contributor intentionally NOT counted here
// yet — it converges on the next open. The Pile / Blind Reveal conditions
// mirror buildHandoffs() in web/src/app/sexboard/_sexboard-body.tsx and reuse
// the SAME readers the live Sexboard does (sexboard.js), so they can't drift.
//
// Dynamic import() of the readers avoids a static init-time cycle: request-
// board.js, fantasy-backlog.js, pile.js and blind-reveals.js all statically
// import _notification_policy.js, which imports this module.

import { normalizeEmail } from "./_auth.js";
import { ensurePlatformIdentity, findWorkspace } from "./_workspaces.js";

const REPLYABLE_STATUSES = new Set(["pending", "sent"]);

// Mirrors web/src/app/sexboard/_sexboard-helpers.ts `hasKinkResponseFrom`: a
// kink counts as "answered by me" if I appear in its status history, reactions,
// comments, or as the status author.
function kinkAnsweredBy(idea, me) {
  if ((idea.statusHistory || []).some((entry) => normalizeEmail(entry?.email) === me)) return true;
  if ((idea.reactions || []).some((reaction) => normalizeEmail(reaction?.by) === me)) return true;
  if ((idea.comments || []).some((comment) => normalizeEmail(comment?.email) === me)) return true;
  return normalizeEmail(idea.statusByEmail) === me;
}

export async function attentionCountFor(env, workspaceId, recipientEmail) {
  const me = normalizeEmail(recipientEmail);
  if (!me || !workspaceId) return 0;
  let count = 0;

  // Asks awaiting your reply — you are the reviewer, it's still pending/sent,
  // and you didn't author it.
  try {
    const { readRequests } = await import("./request-board.js");
    const requests = await readRequests(env, workspaceId);
    count += (requests || []).filter((request) =>
      request
      && REPLYABLE_STATUSES.has(request.status)
      && normalizeEmail(request.reviewerEmail) === me
      && normalizeEmail(request.requesterEmail) !== me
    ).length;
  } catch {
    // Best-effort: a badge miscount must never break notification delivery.
  }

  // Kinks needing your response — authored by your partner, not yet answered by
  // you. readFantasyBacklogForWorkspace already drops archived/tombstoned ideas.
  try {
    const { readFantasyBacklogForWorkspace } = await import("./fantasy-backlog.js");
    const fantasy = await readFantasyBacklogForWorkspace(env, workspaceId, me, { workspaceIds: workspaceId });
    count += (fantasy.ideas || []).filter((idea) =>
      idea
      && normalizeEmail(idea.addedByEmail) !== me
      && !kinkAnsweredBy(idea, me)
    ).length;
  } catch {
    // Best-effort.
  }

  // Pile + Blind Reveal needing you. These readers need the workspace object,
  // so load it once for the recipient (on a 2-person room, one extra platform
  // read). Each contributor is independently guarded — a miscount must never
  // break notification delivery.
  try {
    const { workspaces } = await ensurePlatformIdentity(env, me, { ensureLegacy: true });
    const workspace = findWorkspace(workspaces, workspaceId);
    if (workspace) {
      // Pile: needs you if revealed, or you haven't dropped any acts yet.
      try {
        const { readPileResponse } = await import("./pile.js");
        const { sexboardVisiblePile } = await import("./sexboard.js");
        const pileResponse = await readPileResponse(env, workspace, me);
        const pile = sexboardVisiblePile(pileResponse?.pile);
        if (pile && (pile.isRevealed || (pile.mine?.length || 0) === 0)) count += 1;
      } catch {
        // Best-effort.
      }
      // Blind Reveal: needs you if it's open and you haven't answered yet.
      try {
        const { readBlindRevealResponse } = await import("./blind-reveals.js");
        const blindReveal = (await readBlindRevealResponse(env, workspace, me)).activeReveal;
        if (blindReveal && blindReveal.status !== "revealed" && !blindReveal.mySubmitted) count += 1;
      } catch {
        // Best-effort.
      }
      // Sex Quiz / Green Lights: needs you if your partner finished and you haven't.
      try {
        const { readSexQuizStatus } = await import("./sex-quiz.js");
        const quiz = await readSexQuizStatus(env, workspace, me);
        if (quiz && quiz.partnerSubmitted && !quiz.mySubmitted) count += 1;
      } catch {
        // Best-effort.
      }
      try {
        const { readGreenLightsStatus } = await import("./green-lights.js");
        const gl = await readGreenLightsStatus(env, workspace, me);
        if (gl && gl.partnerSubmitted && !gl.mySubmitted) count += 1;
      } catch {
        // Best-effort.
      }
    }
  } catch {
    // Best-effort: never break notification delivery for a badge miscount.
  }

  return count;
}
