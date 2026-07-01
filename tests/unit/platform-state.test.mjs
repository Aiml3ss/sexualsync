// Handler-level tests for the platform-state conversion (invite + workspace).
// These run the real onRequest handlers against a STATE-backed env (so the CAS
// path in mutatePlatformState is exercised) using the local-preview identity.

import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest as invite } from "../../functions/api/invite.js";
import { onRequest as workspace } from "../../functions/api/workspace.js";
import { authorizeWorkspaceAccess, mutatePlatformState, readPlatformState } from "../../functions/api/_workspaces.js";
import { makeStateEnv } from "./helpers.mjs";

const ME = "local-preview@example.test"; // the local-preview identity

function env() {
  const e = makeStateEnv();
  e.ALLOW_LOCAL_PREVIEW = "1";
  return e;
}

function seed(e, state) {
  return mutatePlatformState(e, () => ({
    profiles: state.profiles || [],
    workspaces: state.workspaces || [],
    invites: state.invites || [],
  }));
}

const member = (email, role, status) => ({ email, role, status, displayName: email.split("@")[0], joinedAt: "2026-01-01" });

function ws(overrides = {}) {
  return {
    id: "w1", name: "Room", displayName: "Our Room", status: "active", productMode: "couples",
    members: [member(ME, "owner", "active")], settings: {}, ...overrides,
  };
}

const post = (path, body) => new Request(`http://localhost${path}`, {
  method: body?.method || "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("invite send: owner adds a pending invite + invited member", async () => {
  const e = env();
  await seed(e, { workspaces: [ws()] });

  const res = await invite({ request: post("/api/invite", { action: "send", workspaceId: "w1", inviteeEmail: "partner@example.test", inviteeName: "Partner" }), env: e });
  assert.equal(res.status, 201);

  const { workspaces, invites } = await readPlatformState(e);
  assert.equal(invites.length, 1);
  assert.equal(invites[0].status, "pending");
  assert.ok(workspaces[0].members.some((m) => m.email === "partner@example.test" && m.status === "invited"));
});

test("invite send: non-owner is rejected with 403", async () => {
  const e = env();
  // ME is only a partner here, not the owner.
  await seed(e, { workspaces: [ws({ members: [member("owner@example.test", "owner", "active"), member(ME, "partner", "active")] })] });

  const res = await invite({ request: post("/api/invite", { action: "send", workspaceId: "w1", inviteeEmail: "x@example.test" }), env: e });
  assert.equal(res.status, 403);
});

test("invite accept: invitee becomes an active member", async () => {
  const e = env();
  await seed(e, {
    workspaces: [ws({ members: [member("owner@example.test", "owner", "active"), { email: ME, role: "partner", status: "invited", displayName: "Me" }] })],
    invites: [{ id: "i1", workspaceId: "w1", inviteeEmail: ME, inviterEmail: "owner@example.test", status: "pending", expiresAt: new Date(Date.now() + 1e9).toISOString(), createdAt: "2026-01-01" }],
  });

  const res = await invite({ request: post("/api/invite", { method: "PATCH", action: "accept", inviteId: "i1" }), env: e });
  assert.equal(res.status, 200);

  const { workspaces, invites } = await readPlatformState(e);
  assert.ok(workspaces[0].members.some((m) => m.email === ME && m.status === "active"));
  assert.equal(invites.find((i) => i.id === "i1").status, "accepted");
});

test("invite accept is idempotent for the same accepter under concurrency", async () => {
  const e = env();
  await seed(e, {
    workspaces: [ws({ members: [member("owner@example.test", "owner", "active"), { email: ME, role: "partner", status: "invited", displayName: "Me" }] })],
    invites: [{ id: "i1", workspaceId: "w1", inviteeEmail: ME, inviterEmail: "owner@example.test", status: "pending", expiresAt: new Date(Date.now() + 1e9).toISOString(), createdAt: "2026-01-01" }],
  });

  const results = await Promise.all([
    invite({ request: post("/api/invite", { method: "PATCH", action: "accept", inviteId: "i1" }), env: e }),
    invite({ request: post("/api/invite", { method: "PATCH", action: "accept", inviteId: "i1" }), env: e }),
  ]);
  // Both calls succeed: one wins the CAS race, the other short-circuits via
  // the idempotency branch (same accepter retrying). The server-side state
  // must still record exactly one acceptance.
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 200], "both requests get the same workspace state back");

  const { invites, workspaces } = await readPlatformState(e);
  assert.equal(invites.filter((i) => i.status === "accepted").length, 1);
  const activeMe = (workspaces[0].members || []).filter((m) => m.email === ME && m.status === "active");
  assert.equal(activeMe.length, 1, "workspace must not double-add the accepter on retry");
});

test("workspace schedule_deletion flips status to deletion_pending", async () => {
  const e = env();
  await seed(e, { workspaces: [ws()] });

  const res = await workspace({ request: post("/api/workspace", { action: "schedule_deletion", workspaceId: "w1", confirmation: "Our Room" }), env: e });
  assert.equal(res.status, 200);

  const { workspaces } = await readPlatformState(e);
  assert.equal(workspaces[0].status, "deletion_pending");
  assert.ok(workspaces[0].deletion?.completeAt);
});

test("workspace schedule_deletion rejects a wrong confirmation", async () => {
  const e = env();
  await seed(e, { workspaces: [ws()] });
  const res = await workspace({ request: post("/api/workspace", { action: "schedule_deletion", workspaceId: "w1", confirmation: "wrong" }), env: e });
  assert.equal(res.status, 400);
});

test("authorizeWorkspaceAccess: a member is granted the workspace (atomic ensure path)", async () => {
  const e = env();
  await seed(e, { workspaces: [ws()] }); // ME is an active owner
  const access = await authorizeWorkspaceAccess({ env: e }, { ok: true, email: ME }, "w1");
  assert.equal(access.ok, true);
  assert.equal(access.workspace.id, "w1");
  assert.equal(access.actorEmail, ME);
  assert.ok(access.member);
});

test("authorizeWorkspaceAccess: a non-member is denied with 403", async () => {
  const e = env();
  await seed(e, { workspaces: [ws({ members: [member("someone@example.test", "owner", "active")] })] });
  const access = await authorizeWorkspaceAccess({ env: e }, { ok: true, email: ME }, "w1");
  assert.equal(access.ok, false);
  assert.equal(access.response.status, 403);
});

test("workspace leave marks the member removed", async () => {
  const e = env();
  await seed(e, { workspaces: [ws({ members: [member("owner@example.test", "owner", "active"), member(ME, "partner", "active")] })] });

  const res = await workspace({ request: post("/api/workspace", { action: "leave", workspaceId: "w1" }), env: e });
  assert.equal(res.status, 200);

  const { workspaces } = await readPlatformState(e);
  assert.equal(workspaces[0].members.find((m) => m.email === ME).status, "removed");
});
