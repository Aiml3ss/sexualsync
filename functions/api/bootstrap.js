import {
  getAuthenticatedIdentity,
  jsonResponse
} from "./_auth.js";
import {
  ensurePlatformIdentity,
  legacyPeopleFromWorkspace,
  legacyWorkspaceFromList,
  workspaceIdsForDataAccess
} from "./_workspaces.js";
import { readActsForWorkspace } from "./approved-acts.js";
import { readBoundariesForWorkspace } from "./boundaries.js";
import { readFantasyBacklogForWorkspace, scheduleKinkNudges } from "./fantasy-backlog.js";
import { buildProfileResponse, peekNextPoolPrompt } from "./profile.js";
import { readRequestBoardForWorkspace } from "./request-board.js";

function emptyBootstrap() {
  return {
    workspaceId: "",
    requests: { requests: [], activeRequests: [], history: [] },
    fantasy: { ideas: [], graveyard: [] },
    boundaries: { boundaries: [] },
    acts: { acts: [] }
  };
}

async function attachPromptBundle(env, response) {
  const workspaceId = response.activeWorkspace?.id;
  if (!workspaceId) return response;
  try {
    const [confidence, curiosity] = await Promise.all([
      peekNextPoolPrompt(env, workspaceId, "confidence"),
      peekNextPoolPrompt(env, workspaceId, "curiosity")
    ]);
    if (confidence || curiosity) {
      response.prompts = {
        confidence: confidence || "",
        curiosity: curiosity || ""
      };
    }
  } catch {}
  return response;
}

export async function onRequest(context) {
  const auth = await getAuthenticatedIdentity(context);
  if (!auth.ok) return auth.response;

  const request = context.request;
  if (request.method.toUpperCase() !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const env = context.env;
  const { profiles, workspaces, invites } = await ensurePlatformIdentity(env, auth.email, { ensureLegacy: true });

  const profileResponse = await attachPromptBundle(env, buildProfileResponse({
    profiles,
    workspaces,
    invites,
    auth
  }));

  const workspaceId = profileResponse.activeWorkspace?.id || "";
  if (!workspaceId) {
    return jsonResponse(200, {
      ...profileResponse,
      bootstrap: emptyBootstrap()
    });
  }
  const legacyWorkspace = legacyWorkspaceFromList(workspaces);
  const dataWorkspaceIds = workspaceIdsForDataAccess(
    profileResponse.activeWorkspace,
    auth.email,
    legacyWorkspace
  );
  // Derive legacyPeople from the platform state already loaded above; pass it to
  // every branch so none re-runs legacyPeopleForEnv() -> readPlatformState()
  // (it would otherwise fire 5x per request — prefix + 4 branches). Pure dedup
  // of an existing read: same data, same ciphertext, no writes.
  const legacyPeople = legacyPeopleFromWorkspace(legacyWorkspace);

  const [requests, fantasy, boundaries, acts] = await Promise.all([
    readRequestBoardForWorkspace(env, workspaceId, { expireInMemory: true, workspaceIds: dataWorkspaceIds, legacyPeople }),
    readFantasyBacklogForWorkspace(env, workspaceId, auth.email, { workspaceIds: dataWorkspaceIds, legacyPeople }),
    readBoundariesForWorkspace(env, workspaceId, { workspaceIds: dataWorkspaceIds, legacyPeople }),
    readActsForWorkspace(env, workspaceId, { workspaceIds: dataWorkspaceIds, legacyPeople })
  ]);
  scheduleKinkNudges(context, profileResponse.activeWorkspace, auth.email, fantasy.ideas || [], dataWorkspaceIds);

  return jsonResponse(200, {
    ...profileResponse,
    bootstrap: {
      workspaceId,
      requests,
      fantasy,
      boundaries,
      acts
    }
  });
}
