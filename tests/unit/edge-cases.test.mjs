// Explicit coverage for the edge-case scenarios called out in the security
// review. These drive the real route handlers against an in-memory KV.
//
// Requests are issued against http://localhost/ so getAuthenticatedIdentity()
// resolves via the local-preview identity path — no cookie plumbing required.

import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest as bootstrap } from "../../functions/api/bootstrap.js";
import { onRequest as profile } from "../../functions/api/profile.js";
import { onRequest as requestBoard } from "../../functions/api/request-board.js";
import { makeKvEnv, makeSessionToken } from "./helpers.mjs";

const SESSION_SECRET = "public-release-session-secret-32+";
const NOW = "2026-05-25T12:00:00.000Z";
const LEGACY_OWNER_EMAIL = "legacy-owner@example.test";
const LEGACY_PARTNER_EMAIL = "legacy-partner@example.test";
const LEGACY_OWNER_NAME = "Legacy Owner";
const LEGACY_PARTNER_NAME = "Legacy Partner";
const ROOM_E2EE_MARKER = "__sxsRoomEncrypted";

function seedJson(env, key, value) {
  env.__map.set(key, JSON.stringify(value));
}

function seedLegacyCouple(env) {
  seedJson(env, "sex-exploration-platform:profiles", []);
  seedJson(env, "sex-exploration-platform:workspaces", [{
    id: "legacy-couple",
    name: "Sexualsync",
    displayName: "Legacy room",
    createdByEmail: LEGACY_OWNER_EMAIL,
    createdAt: NOW,
    updatedAt: NOW,
    status: "active",
    productMode: "couples-prototype",
    members: [
      {
        email: LEGACY_OWNER_EMAIL,
        displayName: LEGACY_OWNER_NAME,
        role: "owner",
        status: "active",
        joinedAt: NOW
      },
      {
        email: LEGACY_PARTNER_EMAIL,
        displayName: LEGACY_PARTNER_NAME,
        role: "partner",
        status: "active",
        joinedAt: NOW
      }
    ],
    settings: { reauthOnLaunch: true }
  }]);
  seedJson(env, "sex-exploration-platform:invites", []);
  seedJson(env, "sexualsync-request-board:requests", [{
    id: "legacy-request",
    title: "private legacy request",
    requester: LEGACY_PARTNER_NAME,
    reviewer: LEGACY_OWNER_NAME,
    requesterEmail: LEGACY_PARTNER_EMAIL,
    reviewerEmail: LEGACY_OWNER_EMAIL,
    status: "pending",
    createdAt: NOW,
    updatedAt: NOW
  }]);
  seedJson(env, "sexualsync-boundaries:boundaries", [{
    id: "legacy-boundary",
    label: "private legacy boundary",
    createdAt: NOW,
    updatedAt: NOW
  }]);
  seedJson(env, "sexualsync-approved-acts:acts", [{
    id: "legacy-act",
    label: "private legacy act",
    createdAt: NOW,
    updatedAt: NOW
  }]);
  seedJson(env, "sexualsync-ideas:ideas", [{
    id: "legacy-idea",
    text: "private legacy fantasy",
    addedByEmail: LEGACY_PARTNER_EMAIL,
    addedByName: LEGACY_PARTNER_NAME,
    createdAt: NOW,
    updatedAt: NOW
  }]);
  seedJson(env, "sexualsync-ideas:graveyard", [{
    id: "legacy-graveyard",
    text: "private legacy archived fantasy",
    addedByEmail: LEGACY_OWNER_EMAIL,
    addedByName: LEGACY_OWNER_NAME,
    createdAt: NOW,
    updatedAt: NOW
  }]);
}

async function signedRequest(env, path, email, options = {}) {
  env.APP_SESSION_SECRET = SESSION_SECRET;
  const token = await makeSessionToken(SESSION_SECRET, {
    email,
    provider: "google",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600
  });
  const headers = new Headers(options.headers || {});
  headers.set("cookie", `sxs-session=${encodeURIComponent(token)}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://app.example.test${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
}

function createWorkspaceRequest() {
  return new Request("http://localhost/api/profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "create_workspace",
      ownerName: "Owner",
      partnerEmail: "kem@x.com",
      displayName: "Our room",
    }),
  });
}

function encryptedRoomBox(ciphertext = "dmVyaWZpZXI=") {
  return {
    [ROOM_E2EE_MARKER]: true,
    version: "sxs-room-e2ee-v1",
    algorithm: "AES-GCM",
    iv: "AAECAwQFBgcICQoL",
    ciphertext
  };
}

// Edge case #2: create_workspace must be idempotent. Before the CR-1 fix the
// "already exists" branch called an undefined buildResponse() and threw a
// ReferenceError (HTTP 500). It must now return 200 both times.
test("create_workspace is idempotent and never 500s on a duplicate", async () => {
  const env = makeKvEnv();

  const r1 = await profile({ request: createWorkspaceRequest(), env });
  assert.equal(r1.status, 200);

  const r2 = await profile({ request: createWorkspaceRequest(), env });
  assert.equal(r2.status, 200);

  const body = await r2.json();
  assert.ok(body.activeWorkspace, "response should include the existing workspace");
});

// Edge case #1 (lost update): two interleaved profile updates against the same
// KV must both complete and the final read must reflect one of them — i.e. the
// handler must not throw or corrupt the platform-state blob under contention.
test("interleaved profile updates leave the store readable and consistent", async () => {
  const env = makeKvEnv();

  const update = (name) => profile({
    request: new Request("http://localhost/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "update_profile", displayName: name }),
    }),
    env,
  });

  const [a, b] = await Promise.all([update("Alpha"), update("Bravo")]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const after = await profile({ request: new Request("http://localhost/api/profile"), env });
  const body = await after.json();
  assert.ok(["Alpha", "Bravo"].includes(body.profile.displayName),
    "last-writer-wins is acceptable; corruption/empty is not");
});

test("public signups never inherit private legacy data", async () => {
  const env = makeKvEnv();
  env.PUBLIC_SIGNUPS_OPEN = "1";
  seedLegacyCouple(env);
  const email = "public-user@example.test";

  const firstBootstrap = await bootstrap({
    request: await signedRequest(env, "/api/bootstrap", email),
    env,
  });
  assert.equal(firstBootstrap.status, 200);
  const firstBody = await firstBootstrap.json();
  assert.equal(firstBody.profile.email, email);
  assert.equal(firstBody.activeWorkspace, null);
  assert.deepEqual(firstBody.workspaces, []);
  assert.equal(firstBody.bootstrap.workspaceId, "");
  assert.deepEqual(firstBody.bootstrap.requests.activeRequests, []);
  assert.deepEqual(firstBody.bootstrap.boundaries.boundaries, []);
  assert.deepEqual(firstBody.bootstrap.acts.acts, []);
  assert.deepEqual(firstBody.bootstrap.fantasy.ideas, []);

  const createResponse = await profile({
    request: await signedRequest(env, "/api/profile", email, {
      method: "POST",
      body: {
        action: "create_workspace",
        ownerName: "Public User",
        partnerEmail: "public-partner@example.test",
        partnerName: "Public Partner",
        displayName: "Public room"
      }
    }),
    env,
  });
  assert.equal(createResponse.status, 200);
  const createBody = await createResponse.json();
  const publicWorkspaceId = createBody.activeWorkspaceId;
  assert.ok(publicWorkspaceId);
  assert.notEqual(publicWorkspaceId, "legacy-couple");
  assert.equal(createBody.workspaces.length, 1);
  assert.equal(createBody.workspaces[0].id, publicWorkspaceId);

  const afterBootstrap = await bootstrap({
    request: await signedRequest(env, "/api/bootstrap", email),
    env,
  });
  assert.equal(afterBootstrap.status, 200);
  const afterBody = await afterBootstrap.json();
  assert.equal(afterBody.activeWorkspaceId, publicWorkspaceId);
  assert.equal(afterBody.bootstrap.workspaceId, publicWorkspaceId);
  assert.deepEqual(afterBody.bootstrap.requests.activeRequests, []);
  assert.deepEqual(afterBody.bootstrap.boundaries.boundaries, []);
  assert.deepEqual(afterBody.bootstrap.acts.acts, []);
  assert.deepEqual(afterBody.bootstrap.fantasy.ideas, []);
  assert.deepEqual(afterBody.bootstrap.fantasy.graveyard, []);

  const directLegacyRead = await requestBoard({
    request: await signedRequest(env, "/api/request-board?workspaceId=legacy-couple", email),
    env,
  });
  assert.equal(directLegacyRead.status, 403);
});

test("legacy workspace bootstrap can come from environment config", async () => {
  const env = makeKvEnv();
  env.LEGACY_MEMBERS_JSON = JSON.stringify([
    { email: LEGACY_OWNER_EMAIL, displayName: LEGACY_OWNER_NAME },
    { email: LEGACY_PARTNER_EMAIL, displayName: LEGACY_PARTNER_NAME }
  ]);
  env.SEXUALSYNC_ADMIN_EMAIL = LEGACY_OWNER_EMAIL;
  env.PRIVATE_PREVIEW_ALLOWED_EMAILS = LEGACY_PARTNER_EMAIL;

  const response = await bootstrap({
    request: await signedRequest(env, "/api/bootstrap", LEGACY_OWNER_EMAIL),
    env,
  });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.activeWorkspaceId, "legacy-couple");
  assert.equal(body.activeWorkspace.members.length, 2);
  assert.equal(body.activeWorkspace.members[0].email, LEGACY_OWNER_EMAIL);
  assert.equal(body.activeWorkspace.members[1].email, LEGACY_PARTNER_EMAIL);
});

test("turning Room Encryption off preserves the verifier for later unlock", async () => {
  const env = makeKvEnv();
  const email = "owner@example.test";
  env.PRIVATE_PREVIEW_ALLOWED_EMAILS = email;
  const workspaceId = "room-e2ee";
  const verifier = encryptedRoomBox();
  seedJson(env, "sex-exploration-platform:profiles", [{
    id: "profile-owner",
    email,
    displayName: "Owner",
    createdAt: NOW,
    updatedAt: NOW,
    settings: { defaultWorkspaceId: workspaceId }
  }]);
  seedJson(env, "sex-exploration-platform:workspaces", [{
    id: workspaceId,
    name: "Encrypted room",
    displayName: "Encrypted room",
    createdByEmail: email,
    createdAt: NOW,
    updatedAt: NOW,
    status: "active",
    productMode: "couples",
    members: [{
      email,
      displayName: "Owner",
      role: "owner",
      status: "active",
      joinedAt: NOW
    }],
    settings: {
      roomE2eeEnabled: true,
      roomE2eeVerifier: verifier
    }
  }]);
  seedJson(env, "sex-exploration-platform:invites", []);

  const response = await profile({
    request: await signedRequest(env, "/api/profile", email, {
      method: "POST",
      body: {
        action: "update_workspace",
        workspaceId,
        roomE2eeEnabled: false,
        roomE2eeVerifier: null
      }
    }),
    env,
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.activeWorkspace.settings.roomE2eeEnabled, false);
  assert.deepEqual(body.activeWorkspace.settings.roomE2eeVerifier, verifier);
});
