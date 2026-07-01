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
  defaultDisplayName,
  ensureProfile,
  findWorkspace,
  mutatePlatformState,
  readPlatformState
} from "./_workspaces.js";
import { appendAudit } from "./_audit.js";
import { broadcastRoomEvent } from "./_live_room.js";
import { checkRateLimit, constantTimeResponse, rateLimitResponse } from "./_rate_limit.js";
import { sendInviteEmail } from "./_email.js";
import { trustedOrigin } from "./_origin.js";

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_INVITES = 200;

function isOwner(workspace, email) {
  const normalized = normalizeEmail(email);
  return (workspace.members || []).some((member) => {
    return normalizeEmail(member.email) === normalized && member.status === "active" && member.role === "owner";
  });
}

function buildInviteUrl(env, request, inviteId) {
  const origin = trustedOrigin(env, request);
  return origin ? `${origin}/signin?invite=${encodeURIComponent(inviteId)}` : `/signin?invite=${encodeURIComponent(inviteId)}`;
}

function publicInvite(invite, { includeInviterEmail = true } = {}) {
  if (!invite) return null;
  return {
    id: invite.id,
    workspaceId: invite.workspaceId,
    workspaceName: invite.workspaceDisplayName || invite.workspaceName,
    inviterEmail: includeInviterEmail ? invite.inviterEmail : "",
    inviterName: invite.inviterName,
    inviteeEmail: invite.inviteeEmail,
    inviteeName: invite.inviteeName,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    status: invite.status,
    claimable: Boolean(invite.claimable)
  };
}

function pruneInvites(invites, now = Date.now()) {
  return invites
    .filter((invite) => {
      const expiresAt = new Date(invite.expiresAt || 0).getTime();
      if (!Number.isFinite(expiresAt)) return false;
      if (invite.status === "pending" && expiresAt < now) return false;
      return true;
    })
    .slice(0, MAX_INVITES);
}

export async function onRequest(context) {
  const auth = await getAuthenticatedIdentity(context);
  if (!auth.ok) return auth.response;

  const env = context.env;
  const request = context.request;
  const method = request.method.toUpperCase();
  const url = new URL(request.url);
  const now = new Date().toISOString();
  const myEmail = normalizeEmail(auth.email);

  if (method === "GET") {
    // Invite preview is an enumeration target — an attacker who can guess an
    // invite ID can otherwise time the 404 vs 200 vs 403 response gap to
    // separate "valid expired", "valid revoked", "valid pending", and
    // "never existed". Rate-limit per IP and pad every response to a flat
    // minimum so the timing oracle collapses.
    const inviteId = url.searchParams.get("inviteId");
    const previewStart = Date.now();
    const PREVIEW_MIN_MS = 120;
    if (inviteId) {
      // Everything below — the rate-limit rejection, the KV read, and the
      // 404/403/200 branches — has to live inside the same constant-time
      // window. If the 429 short-circuited early, or the KV read happened
      // before `previewStart`, an attacker could time the gap. Capturing
      // `previewStart` before the read and padding every return path (429
      // included) collapses the oracle: a throttle, a miss, and a hit all
      // take the same wall-clock floor.
      const ip = String(request.headers.get("cf-connecting-ip") || "global").toLowerCase();
      const limited = await checkRateLimit(env, {
        bucket: "invite-preview",
        key: ip,
        limit: 30,
        windowSeconds: 60
      });
      if (!limited.ok) {
        return constantTimeResponse(previewStart, PREVIEW_MIN_MS, rateLimitResponse(limited.retryAfter));
      }
      const invites = pruneInvites((await readPlatformState(env)).invites);
      const invite = invites.find((item) => item.id === inviteId);
      if (!invite) {
        return constantTimeResponse(previewStart, PREVIEW_MIN_MS, jsonResponse(404, { error: "Invite not found or expired." }));
      }
      // Claimable invites can be previewed by any signed-in user (anyone with
      // the link). Email-bound invites stay restricted to the named pair.
      if (!invite.claimable
          && normalizeEmail(invite.inviteeEmail) !== myEmail
          && normalizeEmail(invite.inviterEmail) !== myEmail) {
        return constantTimeResponse(previewStart, PREVIEW_MIN_MS, jsonResponse(403, { error: "This invite is not yours." }));
      }
      // Privacy: don't surface the inviter's real email to strangers
      // previewing a claimable link. The inviter themselves still gets it,
      // since they need it for their own management UI.
      const callerIsInviter = normalizeEmail(invite.inviterEmail) === myEmail;
      return constantTimeResponse(previewStart, PREVIEW_MIN_MS, jsonResponse(200, {
        invite: publicInvite(invite, {
          includeInviterEmail: callerIsInviter || !invite.claimable
        })
      }));
    }

    // The self-listing path (no inviteId) only ever returns the caller's own
    // invites, so it isn't an enumeration oracle and doesn't need padding.
    const invites = pruneInvites((await readPlatformState(env)).invites);
    const incoming = invites.filter((invite) => normalizeEmail(invite.inviteeEmail) === myEmail && invite.status === "pending");
    const outgoing = invites.filter((invite) => normalizeEmail(invite.inviterEmail) === myEmail && invite.status === "pending");
    return jsonResponse(200, {
      invites: incoming.map(publicInvite),
      sent: outgoing.map(publicInvite)
    });
  }

  if (!["POST", "PATCH", "DELETE"].includes(method)) {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  let payload = {};
  try { payload = await request.json(); }
  catch { return jsonResponse(400, { error: "Expected JSON body" }); }

  if (method === "POST" && payload.action === "send") {
    const limited = await checkRateLimit(env, {
      bucket: "invite-send",
      key: auth.email,
      limit: 10,
      windowSeconds: 60 * 60,
      failClosed: true
    });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);

    const workspaceId = cleanText(payload.workspaceId, 64);
    const inviteeEmail = cleanEmail(payload.inviteeEmail);
    if (!workspaceId) return jsonResponse(400, { error: "workspaceId is required." });

    // Two modes:
    //   - email-bound: inviteeEmail set → traditional invite, only that email can accept,
    //     email delivered via Resend.
    //   - claimable:   inviteeEmail blank → shareable link, first signed-in caller
    //     (other than the inviter) claims it. No email is sent.
    const claimable = !inviteeEmail;

    const mutation = await mutatePlatformState(env, ({ profiles, workspaces, invites: rawInvites }) => {
      const invites = pruneInvites(rawInvites);
      const workspace = findWorkspace(workspaces, workspaceId);
      if (!workspace) return { abort: jsonResponse(404, { error: "Workspace not found." }) };
      if (!isOwner(workspace, auth.email)) return { abort: jsonResponse(403, { error: "Only an owner can invite partners." }) };
      if (!claimable && inviteeEmail === myEmail) return { abort: jsonResponse(400, { error: "Invite a different email than your own." }) };
      if (!claimable && isMemberOfWorkspace(workspace, inviteeEmail)) return { abort: jsonResponse(400, { error: "That person is already in this workspace." }) };

      const existingPending = invites.find((invite) => {
        if (invite.workspaceId !== workspace.id || invite.status !== "pending") return false;
        if (claimable) return Boolean(invite.claimable);
        return normalizeEmail(invite.inviteeEmail) === inviteeEmail;
      });

      if (existingPending) {
        // Resend — no state change, just re-deliver the email (if email-bound) + audit below.
        return { result: { resend: true, invite: existingPending, inviterName: existingPending.inviterName, workspaceId: workspace.id, workspaceDisplayName: workspace.displayName, claimable } };
      }

      const inviterProfile = profiles.find((profile) => normalizeEmail(profile.email) === myEmail);
      const inviterName = inviterProfile?.displayName || "";
      const invite = {
        id: crypto.randomUUID(),
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceDisplayName: workspace.displayName,
        inviterEmail: myEmail,
        inviterName,
        inviteeEmail: claimable ? "" : inviteeEmail,
        inviteeName: claimable ? "" : (cleanText(payload.inviteeName) || defaultDisplayName(inviteeEmail)),
        claimable,
        status: "pending",
        createdAt: now,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
        acceptedAt: ""
      };

      // Email-bound invites also pre-seat the partner as an invited member so
      // the inviter sees them in the workspace roster. Claimable invites stay
      // anonymous until someone actually claims — no roster row until accept.
      let nextWorkspaceMembers = workspace.members;
      if (!claimable) {
        nextWorkspaceMembers = workspace.members.find((member) => normalizeEmail(member.email) === inviteeEmail)
          ? workspace.members.map((member) => normalizeEmail(member.email) === inviteeEmail
              ? { ...member, status: "invited", invitedAt: now, displayName: invite.inviteeName }
              : member)
          : [...workspace.members, {
              email: inviteeEmail,
              displayName: invite.inviteeName,
              role: "partner",
              status: "invited",
              invitedAt: now
            }];
      }

      const nextWorkspace = { ...workspace, members: nextWorkspaceMembers, updatedAt: now };
      return {
        workspaces: workspaces.map((item) => item.id === workspace.id ? nextWorkspace : item),
        invites: [invite, ...invites],
        result: { created: invite, inviterName, workspaceId: workspace.id, workspaceDisplayName: workspace.displayName, claimable }
      };
    });

    if (!mutation.ok) return mutation.abort;
    const r = mutation.result;
    const invite = r.created || r.invite;
    const inviteUrl = buildInviteUrl(env, request, invite.id);
    if (!r.claimable && inviteeEmail) {
      await sendInviteEmail(env, {
        to: inviteeEmail,
        fromName: r.inviterName,
        inviteUrl,
        workspaceDisplayName: r.workspaceDisplayName
      }).catch(() => {});
    }
    await appendAudit(env, r.workspaceId, {
      type: r.resend ? "invite_resent" : "member_invited",
      actorEmail: auth.email,
      actorName: r.inviterName,
      entityType: "invite",
      entityId: invite.id,
      metadata: { claimable: r.claimable }
    });
    return jsonResponse(r.resend ? 200 : 201, { invite: publicInvite(invite), inviteUrl });
  }

  if (method === "DELETE") {
    const inviteId = cleanText(payload.inviteId, 64) || url.searchParams.get("inviteId") || "";
    if (!inviteId) return jsonResponse(400, { error: "inviteId is required." });

    const mutation = await mutatePlatformState(env, ({ workspaces, invites: rawInvites }) => {
      const invites = pruneInvites(rawInvites);
      const invite = invites.find((item) => item.id === inviteId);
      if (!invite) return { abort: jsonResponse(404, { error: "Invite not found." }) };
	      const workspace = findWorkspace(workspaces, invite.workspaceId);
	      if (!workspace || !isOwner(workspace, auth.email)) return { abort: jsonResponse(403, { error: "Only an owner can revoke this invite." }) };
	      const actorMember = (workspace.members || []).find((member) => normalizeEmail(member.email) === myEmail);

      const nextWorkspaces = workspaces.map((item) => {
        if (item.id !== workspace.id) return item;
        return {
          ...item,
          members: (item.members || []).filter((member) => {
            return !(normalizeEmail(member.email) === normalizeEmail(invite.inviteeEmail) && member.status === "invited");
          }),
          updatedAt: now
        };
      });
      return {
	        workspaces: nextWorkspaces,
	        invites: invites.filter((item) => item.id !== inviteId),
	        result: { workspaceId: workspace.id, actorName: actorMember?.displayName || "" }
	      };
    });

    if (!mutation.ok) return mutation.abort;
    await appendAudit(env, mutation.result.workspaceId, {
	      type: "invite_revoked",
	      actorEmail: auth.email,
	      actorName: mutation.result.actorName,
      entityType: "invite",
      entityId: inviteId
    });
    return jsonResponse(200, { ok: true });
  }

  if (method === "PATCH") {
    const inviteId = cleanText(payload.inviteId, 64);
    const action = String(payload.action || "").toLowerCase();

    if (!inviteId || !["accept", "decline"].includes(action)) {
      return jsonResponse(400, { error: "inviteId and action (accept|decline) are required." });
    }

    const mutation = await mutatePlatformState(env, ({ profiles, workspaces, invites: rawInvites }) => {
      const invites = pruneInvites(rawInvites);
      const invite = invites.find((item) => item.id === inviteId);
      if (!invite) return { abort: jsonResponse(404, { error: "Invite not found or expired." }) };
      // Email-bound: only the named invitee can act on it.
      // Claimable: anyone signed-in can act, EXCEPT the inviter themselves —
      // they'd be claiming their own seat and corrupting the workspace.
      if (invite.claimable) {
        if (normalizeEmail(invite.inviterEmail) === myEmail) {
          return { abort: jsonResponse(400, { error: "This is your own invite link. Share it with your partner." }) };
        }
      } else if (normalizeEmail(invite.inviteeEmail) !== myEmail) {
        return { abort: jsonResponse(403, { error: "This invite is not for you." }) };
      }
      // Idempotency: if the SAME user already accepted this invite (e.g. a
      // retry after a flaky network), return the success response instead
      // of a 400. The server's already done the work; the client should be
      // able to safely reissue the request and get the room state back.
      // Decline and other terminal states still reject because they encode
      // a deliberate choice, not a duplicate request.
      if (invite.status === "accepted" && action === "accept") {
        const accepterEmail = normalizeEmail(invite.acceptedByEmail || (invite.claimable ? "" : invite.inviteeEmail));
        if (accepterEmail && accepterEmail === myEmail) {
          const workspace = findWorkspace(workspaces, invite.workspaceId);
          if (!workspace) return { abort: jsonResponse(404, { error: "Workspace no longer exists." }) };
          const member = (workspace.members || []).find((m) => normalizeEmail(m.email) === myEmail);
          return {
            result: {
              accepted: true,
              idempotent: true,
              workspaceId: workspace.id,
              memberName: member?.displayName || defaultDisplayName(auth.email)
            }
          };
        }
      }
      if (invite.status !== "pending") return { abort: jsonResponse(400, { error: "This invite has already been handled." }) };
      if (new Date(invite.expiresAt).getTime() < Date.now()) {
        return {
          invites: invites.map((item) => item.id === inviteId ? { ...invite, status: "expired" } : item),
          result: { expired: true }
        };
      }

      const workspace = findWorkspace(workspaces, invite.workspaceId);
      if (!workspace) return { abort: jsonResponse(404, { error: "Workspace no longer exists." }) };

      const profileResult = ensureProfile(profiles, auth.email, now);
      const nextProfilesBase = profileResult.profiles;

      if (action === "decline") {
        // Email-bound: drop the pre-seated invited row. Claimable: no roster
        // row was ever created, so nothing to remove on the workspace side.
        const nextWorkspace = invite.claimable
          ? workspace
          : {
              ...workspace,
              members: (workspace.members || []).filter((member) => {
                return !(normalizeEmail(member.email) === normalizeEmail(invite.inviteeEmail) && member.status === "invited");
              }),
              updatedAt: now
            };
        return {
          profiles: nextProfilesBase,
          workspaces: workspaces.map((item) => item.id === workspace.id ? nextWorkspace : item),
          invites: invites.map((item) => item.id === inviteId ? { ...invite, status: "revoked", declinedAt: now } : item),
          result: { declined: true }
        };
      }

      const memberName = profileResult.profile?.displayName || invite.inviteeName || defaultDisplayName(auth.email);
      const updatedMembers = workspace.members.find((member) => normalizeEmail(member.email) === myEmail)
        ? workspace.members.map((member) => normalizeEmail(member.email) !== myEmail ? member : { ...member, status: "active", joinedAt: now, displayName: memberName })
        : [...workspace.members, { email: myEmail, displayName: memberName, role: "partner", status: "active", joinedAt: now }];

      const nextWorkspace = { ...workspace, members: updatedMembers, updatedAt: now };

      // Switch the user's default workspace to the freshly-joined room so the
      // sexboard / bootstrap surfaces it on next load. Any prior solo
      // workspace they own is left alone — they can close it manually from
      // Space › More if they want it gone. Auto-closing was a v0.1 idea but
      // it has too many failure modes (workspaces with pending email invites,
      // workspaces that were once paired and now only the inviter is active,
      // races against scheduled deletion). Keep the side-effect surface small.
      const nextWorkspaces = workspaces.map((item) => item.id === workspace.id ? nextWorkspace : item);

      const nextProfiles = nextProfilesBase.map((profile) => {
        if (normalizeEmail(profile.email) !== myEmail) return profile;
        return { ...profile, settings: { ...(profile.settings || {}), defaultWorkspaceId: workspace.id } };
      });

      return {
        profiles: nextProfiles,
        workspaces: nextWorkspaces,
        // Record acceptedByEmail so future retries from the same accepter
        // can short-circuit to an idempotent success response.
        invites: invites.map((item) => item.id === inviteId ? { ...invite, status: "accepted", acceptedAt: now, acceptedByEmail: myEmail } : item),
        result: { accepted: true, workspaceId: workspace.id, memberName }
      };
    });

    if (!mutation.ok) return mutation.abort;
    const r = mutation.result;
    if (r.expired) return jsonResponse(400, { error: "This invite has expired." });
    if (r.declined) return jsonResponse(200, { ok: true });
    // Idempotent retry — the work already happened on a prior accept. Skip
    // the audit log and the live-room broadcast so we don't spam the room
    // with duplicate "partner joined" events on every flaky-network retry.
    if (r.idempotent) {
      return jsonResponse(200, { workspaceId: r.workspaceId, idempotent: true });
    }
    // Audit append is best-effort — CAS commit has already happened, so don't
    // surface a 500 to the user if KV is flaky. Worst case we lose the audit
    // entry; the workspace mutation itself is durable.
    try {
      await appendAudit(env, r.workspaceId, {
        type: "member_joined",
        actorEmail: auth.email,
        actorName: r.memberName,
        entityType: "member",
        entityId: myEmail
      });
    } catch {}
    // Tell the live room the partner just joined so the inviter's sexboard
    // (and any other open tabs) can refresh from WaitingOnPartner to the
    // paired view without a manual reload. Use the "presence" resource since
    // that's already in the sexboard's listen list and the join is, from the
    // inviter's perspective, a presence change.
    try {
      await broadcastRoomEvent(context, r.workspaceId, {
        resource: "presence",
        action: "member_joined",
        entityId: myEmail,
        actorEmail: auth.email,
        actorName: r.memberName,
        passive: true
      });
    } catch {}
    return jsonResponse(200, { workspaceId: r.workspaceId });
  }

  return jsonResponse(400, { error: "Unsupported invite action." });
}
