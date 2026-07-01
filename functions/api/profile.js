import {
  APP_NAME,
  getAuthenticatedIdentity,
  isMemberOfWorkspace,
  jsonResponse,
  normalizeEmail
} from "./_auth.js";
import {
  cleanEmail,
  cleanText,
  configuredLegacyMembers,
  defaultWorkspacePayload,
  ensureLegacyWorkspace,
  ensureProfile,
  findWorkspace,
  getUserWorkspaces,
  mutatePlatformState,
  pickActiveWorkspace,
  workspaceIdFromPayload
} from "./_workspaces.js";
import { appendAudit } from "./_audit.js";
import { cleanRoomEncryptedBox } from "./_e2ee.js";
import { getStore } from "./_kv.js";
import { checkRateLimit, rateLimitResponse } from "./_rate_limit.js";

// Pool-peek helper — reads a prompt from the existing pool architecture
// (functions/api/prompts.js) WITHOUT calling the LLM. If the pool has an
// unused entry we return it inline; the prompts endpoint itself handles
// pool initialization and refilling. This way /api/profile carries the next
// confidence + curiosity prompts so the dashboard renders WITH them — no
// separate round-trip needed.
const POOL_PREFIX = "prompts:pool:v1:";
export async function peekNextPoolPrompt(env, workspaceId, kind) {
  if (!workspaceId || !env?.STORE) return "";
  try {
    const key = `${POOL_PREFIX}${workspaceId}:${kind}`;
    const data = await getStore(env, "STORE").get(key, { type: "json" });
    if (!data || !Array.isArray(data.items)) return "";
    if (data.nextIndex >= data.items.length) return "";
    return data.items[data.nextIndex] || "";
  } catch { return ""; }
}

function publicProfile(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    email: profile.email,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    settings: profile.settings || {}
  };
}

function publicWorkspace(workspace) {
  if (!workspace) return null;
  return {
    id: workspace.id,
    name: workspace.name,
    displayName: workspace.displayName || workspace.name,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    status: workspace.status || "active",
    productMode: workspace.productMode || "couples",
    members: (workspace.members || []).map((member) => ({
      email: member.email,
      displayName: member.displayName,
      role: member.role,
      status: member.status,
      invitedAt: member.invitedAt || "",
      joinedAt: member.joinedAt || ""
    })),
    settings: workspace.settings || {},
    deletion: workspace.deletion || null
  };
}

function applyProfileUpdates(profile, payload, now) {
  if (!profile) return profile;
  const next = { ...profile, updatedAt: now };

  if (typeof payload.displayName === "string") {
    const cleaned = cleanText(payload.displayName);
    if (cleaned) next.displayName = cleaned;
  }

  const settings = { ...(profile.settings || {}) };

  if (typeof payload.theme === "string" && ["light", "dark", "system"].includes(payload.theme)) {
    settings.theme = payload.theme;
  }

  if (typeof payload.defaultWorkspaceId === "string") {
    settings.defaultWorkspaceId = payload.defaultWorkspaceId.slice(0, 64);
  }

  if (typeof payload.shareAttentionSignals === "boolean") {
    settings.shareAttentionSignals = payload.shareAttentionSignals;
  }

  next.settings = settings;
  return next;
}

export async function onRequest(context) {
  const auth = await getAuthenticatedIdentity(context);
  if (!auth.ok) return auth.response;

  const env = context.env;
  const request = context.request;
  const method = request.method.toUpperCase();

  if (!["GET", "POST"].includes(method)) {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const now = new Date().toISOString();

  let payload = {};
  if (method === "POST") {
    try { payload = await request.json(); }
    catch { return jsonResponse(400, { error: "Expected JSON body" }); }
  }

  // Rate-limit workspace creation up front — it's a side effect and an early
  // return, so it stays outside the atomic mutation.
  if (method === "POST" && payload.action === "create_workspace") {
    const limited = await checkRateLimit(env, {
      bucket: "workspace-create",
      key: auth.email,
      limit: 20,
      windowSeconds: 24 * 60 * 60
    });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
  }

  const myEmail = normalizeEmail(auth.email);
  const legacyMembers = configuredLegacyMembers(env);
  const legacyMemberEmails = new Set(legacyMembers.map((member) => member.email));
  const mutation = await mutatePlatformState(env, ({ profiles, workspaces, invites }) => {
    const audits = [];
    let profilesChanged = false;
    let workspacesChanged = false;

    const configuredName = legacyMembers.find((member) => member.email === myEmail)?.displayName || "";
    const profileResult = ensureProfile(profiles, auth.email, now, configuredName);
    let nextProfiles = profileResult.profiles;
    let nextWorkspaces = workspaces;
    if (profileResult.created) profilesChanged = true;

    if (legacyMemberEmails.has(myEmail)) {
      const legacyResult = ensureLegacyWorkspace(nextWorkspaces, now, legacyMembers);
      nextWorkspaces = legacyResult.workspaces;
      if (legacyResult.created) workspacesChanged = true;
    }

    if (method === "POST") {
      const isProfileUpdate = !payload.action || payload.action === "update_profile";

      if (isProfileUpdate) {
        nextProfiles = nextProfiles.map((profile) => {
          return normalizeEmail(profile.email) === myEmail
            ? applyProfileUpdates(profile, payload, now)
            : profile;
        });
        profilesChanged = true;

        if (typeof payload.displayName === "string") {
          const cleanedDN = cleanText(payload.displayName);
          if (cleanedDN) {
            nextWorkspaces = nextWorkspaces.map((workspace) => {
              if (!Array.isArray(workspace.members)) return workspace;
              let changed = false;
              const nextMembers = workspace.members.map((member) => {
                if (normalizeEmail(member.email) !== myEmail) return member;
                if (member.displayName === cleanedDN) return member;
                changed = true;
                return { ...member, displayName: cleanedDN };
              });
              if (!changed) return workspace;
              workspacesChanged = true;
              return { ...workspace, members: nextMembers, updatedAt: now };
            });
          }
        }
      }

      if (payload.action === "create_workspace") {
        const partnerEmail = cleanEmail(payload.partnerEmail);
        const ownerEmail = myEmail;

        if (partnerEmail && partnerEmail === ownerEmail) return { abort: jsonResponse(400, { error: "Add a partner email that is different from your own." }) };

        // Solo creation (no partnerEmail) is allowed: the owner gets a room
        // with one active member and can share a claimable invite link to
        // seat the partner later. The create is a no-op (fall through to the
        // normal response with the existing workspace) when:
        //   - a partnerEmail is supplied and the pair already shares a room
        //   - no partnerEmail is supplied and the caller is already a member
        //     of any active workspace (solo or paired, created or joined).
        // The second case prevents an already-paired user from accidentally
        // spawning a second solo workspace and losing track of their room.
        const existing = nextWorkspaces.find((workspace) => {
          if (workspace.status === "deleted") return false;
          const emails = new Set((workspace.members || []).map((member) => normalizeEmail(member.email)));
          if (!emails.has(ownerEmail)) return false;
          if (partnerEmail) return emails.has(partnerEmail);
          return true;
        });

        // If the pair already shares a workspace, this is a no-op create; fall
        // through to the normal response with the existing workspace.
        if (!existing) {
          const ownerProfile = nextProfiles.find((profile) => normalizeEmail(profile.email) === ownerEmail);
          const newWorkspace = defaultWorkspacePayload(
            ownerEmail,
            partnerEmail,
            cleanText(payload.ownerName) || ownerProfile?.displayName,
            cleanText(payload.partnerName),
            now,
            cleanText(payload.workspaceName) || APP_NAME,
            cleanText(payload.displayName)
          );

          nextWorkspaces = [newWorkspace, ...nextWorkspaces];
          workspacesChanged = true;

          nextProfiles = nextProfiles.map((profile) => {
            if (normalizeEmail(profile.email) !== ownerEmail) return profile;
            return {
              ...profile,
              settings: { ...(profile.settings || {}), defaultWorkspaceId: newWorkspace.id }
            };
          });
          profilesChanged = true;

          audits.push({ workspaceId: newWorkspace.id, event: {
            type: "workspace_created",
            actorEmail: ownerEmail,
            actorName: cleanText(payload.ownerName) || ownerProfile?.displayName || "",
            entityType: "workspace",
            entityId: newWorkspace.id,
            metadata: { memberCount: newWorkspace.members.length }
          } });
        }
      } else if (payload.action === "update_workspace") {
        const workspaceId = workspaceIdFromPayload(payload);
        const workspace = findWorkspace(nextWorkspaces, workspaceId);
        const actorProfile = nextProfiles.find((profile) => normalizeEmail(profile.email) === myEmail);
        const actorName = actorProfile?.displayName || "";

        if (!workspace) return { abort: jsonResponse(404, { error: "Workspace not found." }) };
        if (!isMemberOfWorkspace(workspace, auth.email)) return { abort: jsonResponse(403, { error: "This workspace is not yours." }) };

        const settings = { ...(workspace.settings || {}) };
        let renamed = false;
        let settingsChanged = false;
        const nextWorkspace = { ...workspace, updatedAt: now };

        if (typeof payload.displayName === "string") {
          const cleaned = cleanText(payload.displayName);
          if (cleaned && cleaned !== workspace.displayName) {
            nextWorkspace.displayName = cleaned;
            renamed = true;
          }
        }

        if (typeof payload.reauthOnLaunch === "boolean") {
          if (settings.reauthOnLaunch !== payload.reauthOnLaunch) {
            settings.reauthOnLaunch = payload.reauthOnLaunch;
            settingsChanged = true;
          }
        }

        if (typeof payload.roomE2eeEnabled === "boolean") {
          if (settings.roomE2eeEnabled !== payload.roomE2eeEnabled) {
            settings.roomE2eeEnabled = payload.roomE2eeEnabled;
            settingsChanged = true;
          }
        }

        if (Object.prototype.hasOwnProperty.call(payload, "roomE2eeVerifier")) {
          if (payload.roomE2eeVerifier === null) {
            if (payload.roomE2eeEnabled === false) {
              // Turning Room Encryption off only affects new writes. Keep the
              // verifier so existing ciphertext can still be unlocked later,
              // even if an older client sends null while disabling.
            } else if (settings.roomE2eeVerifier) {
              delete settings.roomE2eeVerifier;
              settingsChanged = true;
            }
          } else {
            const verifier = cleanRoomEncryptedBox(payload.roomE2eeVerifier, 8192);
            if (!verifier) return { abort: jsonResponse(400, { error: "Invalid room encryption verifier." }) };
            settings.roomE2eeVerifier = verifier;
            settingsChanged = true;
          }
        }

        if (payload.roomE2eeEnabled === true && !settings.roomE2eeVerifier) {
          return { abort: jsonResponse(400, { error: "Room encryption verifier required." }) };
        }

        if (settingsChanged) nextWorkspace.settings = settings;

        if (renamed || settingsChanged) {
          nextWorkspaces = nextWorkspaces.map((item) => item.id === workspace.id ? nextWorkspace : item);
          workspacesChanged = true;

          if (renamed) {
            audits.push({ workspaceId: workspace.id, event: {
              type: "workspace_renamed",
              actorEmail: auth.email,
              actorName,
              entityType: "workspace",
              entityId: workspace.id
            } });
          }
          if (settingsChanged) {
            audits.push({ workspaceId: workspace.id, event: {
              type: "workspace_settings_updated",
              actorEmail: auth.email,
              actorName,
              entityType: "workspace",
              entityId: workspace.id,
              metadata: {
                reauthOnLaunch: Boolean(settings.reauthOnLaunch),
                roomE2eeEnabled: Boolean(settings.roomE2eeEnabled),
                roomE2eeVerifier: Boolean(settings.roomE2eeVerifier)
              }
            } });
          }
        }
      }
    }

    const patch = {};
    if (profilesChanged) patch.profiles = nextProfiles;
    if (workspacesChanged) patch.workspaces = nextWorkspaces;
    return { ...patch, result: { audits } };
  });

  if (!mutation.ok) return mutation.abort;
  for (const entry of mutation.result.audits) {
    await appendAudit(env, entry.workspaceId, entry.event);
  }

  const { profiles, workspaces, invites } = mutation.state;
  const baseResponse = buildProfileResponse({ profiles, workspaces, invites, auth });
  // Speed: bundle next prompts in the profile response so the dashboard
  // doesn't pay a second round-trip to fetch them. Cheap KV reads, no LLM.
  const activeWsId = baseResponse.activeWorkspace?.id;
  if (activeWsId) {
    try {
      const [confidence, curiosity] = await Promise.all([
        peekNextPoolPrompt(env, activeWsId, "confidence"),
        peekNextPoolPrompt(env, activeWsId, "curiosity"),
      ]);
      if (confidence || curiosity) {
        baseResponse.prompts = {
          confidence: confidence || "",
          curiosity:  curiosity  || "",
        };
      }
    } catch {}
  }

  return jsonResponse(200, baseResponse);
}

export function buildProfileResponse({ profiles, workspaces, invites, auth }) {
  const profile = profiles.find((item) => normalizeEmail(item.email) === normalizeEmail(auth.email));
  const userWorkspaces = getUserWorkspaces(workspaces, auth.email);
  const activeWorkspace = pickActiveWorkspace(workspaces, profile);
  const userInvites = (invites || []).filter((invite) => {
    return normalizeEmail(invite.inviteeEmail) === normalizeEmail(auth.email) && invite.status === "pending";
  });

  return {
    profile: publicProfile(profile),
    workspaces: userWorkspaces.map(publicWorkspace),
    activeWorkspaceId: activeWorkspace?.id || "",
    activeWorkspace: publicWorkspace(activeWorkspace),
    pendingInvites: userInvites.map((invite) => ({
      id: invite.id,
      workspaceId: invite.workspaceId,
      workspaceName: invite.workspaceDisplayName || invite.workspaceName || APP_NAME,
      inviterEmail: invite.inviterEmail,
      inviterName: invite.inviterName || "",
      inviteeEmail: invite.inviteeEmail,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      status: invite.status
    })),
    auth: {
      email: auth.email,
      person: auth.person,
      isKnownCoupleMember: Boolean(auth.isKnownCoupleMember),
      provider: auth.provider
    },
    app: {
      name: APP_NAME
    }
  };
}
