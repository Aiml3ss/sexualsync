import {
  getAuthenticatedIdentity,
  jsonResponse,
  normalizeEmail
} from "./_auth.js";
import {
  ensurePlatformIdentity,
  legacyPeopleFromWorkspace,
  legacyWorkspaceFromList,
  workspaceIdsForDataAccess
} from "./_workspaces.js";
import { readActivity } from "./_activity.js";
import { readBlindRevealResponse } from "./blind-reveals.js";
import { readFantasyBacklogForWorkspace, scheduleKinkNudges } from "./fantasy-backlog.js";
import { readPileResponse } from "./pile.js";
import { buildProfileResponse } from "./profile.js";
import { readRequestBoardForWorkspace } from "./request-board.js";
import { readPresenceResponse } from "./space/presence.js";
import { readSexQuizStatus } from "./sex-quiz.js";
import { readGreenLightsStatus } from "./green-lights.js";

function emptySexboard() {
  return {
    workspaceId: "",
    board: { workspaceId: "", requests: [], activeRequests: [], history: [] },
    pile: null,
    pileSessions: [],
    blindReveal: null,
    blindReveals: [],
    fantasy: { workspaceId: "", reactionCatalog: [], ideas: [], graveyard: [] },
    presence: null,
    activity: { workspaceId: "", items: [], unreadTotal: 0, unreadByResource: {}, readState: { all: "", resources: {} } },
    sexQuiz: null,
    greenLights: null
  };
}

export function sexboardVisiblePile(pile, nowMs = Date.now()) {
  if (!pile) return null;
  if (pile.isRevealed) return pile;
  const revealAt = new Date(pile.revealAt || "").getTime();
  if (Number.isFinite(revealAt) && revealAt <= nowMs) return null;
  return pile;
}

export async function onRequest(context) {
  const auth = await getAuthenticatedIdentity(context);
  if (!auth.ok) return auth.response;

  const request = context.request;
  if (request.method.toUpperCase() !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const env = context.env;
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const { profiles, workspaces, invites } = await ensurePlatformIdentity(env, auth.email, { ensureLegacy: true });

  const profileResponse = buildProfileResponse({
    profiles,
    workspaces,
    invites,
    auth
  });

  const workspace = profileResponse.activeWorkspace;
  const workspaceId = workspace?.id || "";
  if (!workspaceId) {
    return jsonResponse(200, {
      ...profileResponse,
      sexboard: emptySexboard()
    });
  }

  const actorEmail = normalizeEmail(auth.email);
  const actorName = workspace.members?.find((member) => normalizeEmail(member.email) === actorEmail)?.displayName
    || auth.person
    || "";
  const legacyWorkspace = legacyWorkspaceFromList(workspaces);
  const dataWorkspaceIds = workspaceIdsForDataAccess(workspace, actorEmail, legacyWorkspace);
  // Derive legacyPeople from the platform-state already loaded by
  // ensurePlatformIdentity above, and pass it down. Otherwise the request-board
  // and fantasy-backlog readers each call legacyPeopleForEnv() -> readPlatformState(),
  // re-reading the SAME cold-KV record (it would fire 3x per request). Pure
  // dedup of an existing read — same data, same ciphertext, no writes.
  const legacyPeople = legacyPeopleFromWorkspace(legacyWorkspace);

  // Foreground-gate the presence stamp: a backgrounded or realtime-driven
  // refetch (the client appends ?bg=1 when document.hidden) still READS presence
  // but must not mark the caller "active". Otherwise background polls keep them
  // perpetually active and _notification_policy.js suppresses every real push to
  // them — exactly why a manual push-test (suppression-exempt) arrives while
  // live chat/request notifications silently do not.
  const stampPresence = new URL(request.url).searchParams.get("bg") !== "1";

  const [board, pile, blindReveal, fantasy, presence, activity, sexQuiz, greenLights] = await Promise.all([
    readRequestBoardForWorkspace(env, workspaceId, { expireInMemory: true, workspaceIds: dataWorkspaceIds, legacyPeople }),
    readPileResponse(env, workspace, actorEmail, actorName, { workspaceIds: dataWorkspaceIds, context }),
    readBlindRevealResponse(env, workspace, actorEmail, now),
    readFantasyBacklogForWorkspace(env, workspaceId, actorEmail, { workspaceIds: dataWorkspaceIds, legacyPeople }),
    readPresenceResponse(env, workspace, actorEmail, { stamp: stampPresence }).catch(() => null),
    readActivity(env, workspaceId, actorEmail),
    readSexQuizStatus(env, workspace, actorEmail).catch(() => null),
    readGreenLightsStatus(env, workspace, actorEmail).catch(() => null)
  ]);
  scheduleKinkNudges(context, workspace, actorEmail, fantasy.ideas || [], dataWorkspaceIds);

  return jsonResponse(200, {
    ...profileResponse,
    sexboard: {
      workspaceId,
      board,
      pile: sexboardVisiblePile(pile.pile, nowDate.getTime()),
      pileSessions: pile.sessions || [],
      blindReveal: blindReveal.activeReveal,
      blindReveals: blindReveal.reveals || [],
      fantasy,
      presence,
      activity,
      sexQuiz,
      greenLights
    }
  });
}
