import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest as sexboard, sexboardVisiblePile } from "../../functions/api/sexboard.js";
import { mutatePlatformState } from "../../functions/api/_workspaces.js";
import { mutateKey } from "../../functions/api/_state.js";
import { makeStateEnv } from "./helpers.mjs";

const ME = "local-preview@example.test";
const PARTNER = "partner@example.test";
const WORKSPACE_ID = "w1";
const PILE_STORE = "sexualsync-pile";
const PILE_KEY = `pile:${WORKSPACE_ID}:active`;

const member = (email, role = "partner") => ({
  email,
  role,
  status: "active",
  displayName: email.split("@")[0],
});

async function setup(pile = null) {
  const env = makeStateEnv();
  env.ALLOW_LOCAL_PREVIEW = "1";
  await mutatePlatformState(env, () => ({
    profiles: [
      { id: "p1", email: ME, displayName: "Me" },
      { id: "p2", email: PARTNER, displayName: "Partner" },
    ],
    workspaces: [{
      id: WORKSPACE_ID,
      name: "Room",
      displayName: "Room",
      status: "active",
      productMode: "couples",
      members: [member(ME, "owner"), member(PARTNER)],
      settings: {},
    }],
    invites: [],
  }));
  if (pile) await mutateKey(env, PILE_STORE, PILE_KEY, () => ({ value: pile }));
  return env;
}

const call = (env) => sexboard({
  request: new Request("http://localhost/api/sexboard", { method: "GET" }),
  env,
});

test("Sexboard omits an unrevealed Pile after its reveal time passes", async () => {
  const expiredPile = {
    revealAt: new Date(Date.now() - 60_000).toISOString(),
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    startedByEmail: PARTNER,
    maxDropCount: 3,
    targetDropCount: 3,
    contributions: {
      [PARTNER]: ["Massage"],
    },
  };
  assert.equal(sexboardVisiblePile({ ...expiredPile, isRevealed: false }, Date.now()), null);

  const env = await setup(expiredPile);
  const res = await call(env);
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.sexboard.pile, null);
});

test("Sexboard keeps future and revealed Piles visible", () => {
  const futurePile = {
    revealAt: new Date(Date.now() + 60_000).toISOString(),
    isRevealed: false,
  };
  const revealedPile = {
    revealAt: new Date(Date.now() - 60_000).toISOString(),
    isRevealed: true,
  };

  assert.equal(sexboardVisiblePile(futurePile, Date.now()), futurePile);
  assert.equal(sexboardVisiblePile(revealedPile, Date.now()), revealedPile);
});
