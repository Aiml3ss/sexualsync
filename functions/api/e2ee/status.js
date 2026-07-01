import {
  getAuthenticatedIdentity,
  jsonResponse
} from "../_auth.js";
import { cleanRoomEncryptedBox } from "../_e2ee.js";
import { getStore } from "../_kv.js";
import {
  authorizeWorkspaceAccess,
  workspaceIdFromRequest
} from "../_workspaces.js";
// C3 — these five stores moved from ONE global key to PER-WORKSPACE keys. This
// route counts plaintext rows AT REST, so it reads the SAME per-workspace keys
// the handlers write (via their exported key functions) unioned with the
// read-only legacy global fallback (per-workspace winning by id) — but it reads
// the rows RAW (no migrate/redaction), because the handler readers normalize
// away or hide plaintext that still physically needs encrypting (e.g. a legacy
// reaction with only a `note`, or a partner's blind-reveal answer). Reading the
// bare legacy global key alone would miss every post-deploy per-workspace row.
import { requestsKey } from "../request-board.js";
import { boundariesKey } from "../boundaries.js";
import { actsKey } from "../approved-acts.js";
import { ideasKey, graveyardKey } from "../fantasy-backlog.js";
// Blind reveals already ship a raw, side-effect-free per-workspace+legacy reader.
import { readRevealsForWorkspace } from "../blind-reveals.js";
import { e2eeReencryptAvailable } from "./_reencrypt_gate.js";

const LEGACY_WORKSPACE_ID = "legacy-couple";
const REQUEST_STORE = "sexualsync-request-board";
const REQUEST_LEGACY_KEY = "requests";
const BOUNDARY_STORE = "sexualsync-boundaries";
const BOUNDARY_LEGACY_KEY = "boundaries";
const ACT_STORE = "sexualsync-approved-acts";
const ACT_LEGACY_KEY = "acts";
const FANTASY_STORE = "sexualsync-ideas";
const IDEAS_LEGACY_KEY = "ideas";
const GRAVEYARD_LEGACY_KEY = "graveyard";
const SHELF_STORE = "sexualsync-shelf";
const PILE_STORE = "sexualsync-pile";

function workspaceIdFor(row) {
  return String(row?.workspaceId || LEGACY_WORKSPACE_ID);
}

function inWorkspace(row, ids) {
  return ids.has(workspaceIdFor(row));
}

function hasText(value) {
  return String(value || "").trim().length > 0;
}

function hasListText(value) {
  return Array.isArray(value) && value.some((entry) => hasText(entry) || (entry && typeof entry === "object" && Object.values(entry).some(hasText)));
}

function hasObjectText(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.values(value).some(hasText);
}

function encrypted(value, max = 60000) {
  return Boolean(cleanRoomEncryptedBox(value, max));
}

async function readJson(env, storeName, key, fallback) {
  try {
    const value = await getStore(env, storeName).get(key, { type: "json" });
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

// Raw union of a store's per-workspace keys (over the data-access set) with the
// read-only legacy global key, deduped by id with the per-workspace row winning.
// Rows are returned UNMODIFIED so the plaintext counters see exactly what is at
// rest. This mirrors the handlers' read-with-legacy-fallback (minus migrate), so
// once reencrypt has written the encrypted row to the per-workspace key it wins
// over the stale plaintext legacy row and the count drops to zero.
async function readRawList(env, storeName, keyFn, legacyKey, ids) {
  // Batch the per-workspace reads (independent keys) and the legacy read in
  // parallel instead of one KV round-trip per workspace. Dedup still walks the
  // results in `ids` order, then legacy, so the "per-workspace row wins, first
  // id seen wins" precedence is byte-for-byte unchanged.
  const [perWorkspaceLists, legacy] = await Promise.all([
    Promise.all(Array.from(ids, (workspaceId) => readJson(env, storeName, keyFn(workspaceId), []))),
    readJson(env, storeName, legacyKey, [])
  ]);
  const seen = new Set();
  const out = [];
  for (const rows of perWorkspaceLists) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (row && row.id && !seen.has(row.id)) { seen.add(row.id); out.push(row); }
    }
  }
  if (Array.isArray(legacy)) {
    for (const row of legacy) {
      if (inWorkspace(row, ids) && row?.id && !seen.has(row.id)) { seen.add(row.id); out.push(row); }
    }
  }
  return out;
}

async function readShelfForIds(env, ids) {
  const lists = await Promise.all(Array.from(ids, (workspaceId) =>
    readJson(env, SHELF_STORE, `shelf:${workspaceId}`, []).then((items) =>
      Array.isArray(items) ? items.map((item) => ({ ...item, workspaceId })) : [])
  ));
  return lists.flat();
}

async function readPilesForIds(env, ids) {
  const perWorkspace = await Promise.all(Array.from(ids, async (workspaceId) => {
    const [pile, locked] = await Promise.all([
      readJson(env, PILE_STORE, `pile:${workspaceId}:active`, null),
      readJson(env, PILE_STORE, `pile:${workspaceId}:sessions`, [])
    ]);
    return {
      active: pile ? [{ ...pile, workspaceId }] : [],
      sessions: Array.isArray(locked) ? locked.map((item) => ({ ...item, workspaceId })) : []
    };
  }));
  return {
    active: perWorkspace.flatMap((entry) => entry.active),
    sessions: perWorkspace.flatMap((entry) => entry.sessions)
  };
}

function countRequests(requests, ids) {
  const out = { asks: 0, replies: 0 };
  requests.filter((row) => inWorkspace(row, ids)).forEach((request) => {
    if (!encrypted(request.encryptedPayload) && (
      hasListText(request.categories)
      || hasListText(request.boundaryConflicts)
      || hasText(request.note)
    )) out.asks += 1;
    if (!encrypted(request.encryptedReply) && (
      hasListText(request.decisions)
      || hasListText(request.counters)
      || hasText(request.feedback)
      || hasText(request.matchNarration)
    )) out.replies += 1;
  });
  return out;
}

function countFantasy(rows, ids) {
  const out = { kinks: 0, kinkComments: 0, kinkReactionNotes: 0 };
  rows.filter((row) => inWorkspace(row, ids)).forEach((idea) => {
    if (!encrypted(idea.encryptedText, 12000) && hasText(idea.text)) out.kinks += 1;
    (Array.isArray(idea.comments) ? idea.comments : []).forEach((comment) => {
      if (!encrypted(comment?.encryptedText, 12000) && hasText(comment?.text)) out.kinkComments += 1;
    });
    (Array.isArray(idea.reactions) ? idea.reactions : []).forEach((reaction) => {
      if (!encrypted(reaction?.encryptedNote, 12000) && hasText(reaction?.note)) out.kinkReactionNotes += 1;
    });
  });
  return out;
}

function countBlindReveals(rows, ids) {
  const out = { blindPrompts: 0, blindAnswers: 0 };
  rows.filter((row) => inWorkspace(row, ids)).forEach((reveal) => {
    if (!encrypted(reveal.encryptedPrompt, 12000) && hasText(reveal.prompt)) out.blindPrompts += 1;
    Object.values(reveal.entries || {}).forEach((entry) => {
      if (!encrypted(entry?.encryptedText) && hasText(entry?.text)) out.blindAnswers += 1;
    });
  });
  return out;
}

function countShelf(items) {
  const out = { shelfContent: 0, shelfTitles: 0 };
  items.forEach((item) => {
    if (!encrypted(item.encryptedContent) && (
      hasText(item.passageText)
      || hasText(item.sourceUrl)
      || hasText(item.embedUrl)
      || hasText(item.sourceId)
    )) out.shelfContent += 1;
    if (!encrypted(item.encryptedTitle, 12000) && hasText(item.title)) out.shelfTitles += 1;
  });
  return out;
}

function countPileLabels(list) {
  return list.reduce((sum, pile) => {
    if (pile?.roomE2ee === true) return sum;
    const contributionCount = Object.values(pile?.contributions || {})
      .reduce((count, labels) => count + (Array.isArray(labels) ? labels.filter(hasText).length : 0), 0);
    const actsCount = Array.isArray(pile?.acts) ? pile.acts.filter(hasText).length : 0;
    const overlapCount = Array.isArray(pile?.overlap) ? pile.overlap.filter(hasText).length : 0;
    return sum + contributionCount + Math.max(actsCount, overlapCount);
  }, 0);
}

function sumCounts(surfaces) {
  return Object.values(surfaces).reduce((total, value) => total + Number(value || 0), 0);
}

export async function onRequest(context) {
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;
  if (context.request.method.toUpperCase() !== "GET") {
    return jsonResponse(405, { error: "Method not allowed." });
  }

  const workspaceId = workspaceIdFromRequest(context.request);
  const access = await authorizeWorkspaceAccess(context, identity, workspaceId);
  if (!access.ok) return access.response;

  const dataWorkspaceIdList = access.dataWorkspaceIds || [access.workspace.id];
  const dataWorkspaceIds = new Set(dataWorkspaceIdList);
  // Read each store's per-workspace keys (across the data-access set) unioned
  // with the read-only legacy fallback, RAW. Counts reflect post-deploy rows AND
  // drop to zero once reencrypt writes the encrypted versions to the same keys.
  const [requests, boundaries, acts, ideas, graveyard, blindReveals, shelfItems, piles] = await Promise.all([
    readRawList(context.env, REQUEST_STORE, requestsKey, REQUEST_LEGACY_KEY, dataWorkspaceIds),
    readRawList(context.env, BOUNDARY_STORE, boundariesKey, BOUNDARY_LEGACY_KEY, dataWorkspaceIds),
    readRawList(context.env, ACT_STORE, actsKey, ACT_LEGACY_KEY, dataWorkspaceIds),
    readRawList(context.env, FANTASY_STORE, ideasKey, IDEAS_LEGACY_KEY, dataWorkspaceIds),
    readRawList(context.env, FANTASY_STORE, graveyardKey, GRAVEYARD_LEGACY_KEY, dataWorkspaceIds),
    // Blind reveals already ship a raw, side-effect-free per-workspace+legacy
    // reader; run it per workspace in the data-access set and merge.
    Promise.all(dataWorkspaceIdList.map((id) => readRevealsForWorkspace(context.env, id)))
      .then((lists) => lists.flat()),
    readShelfForIds(context.env, dataWorkspaceIds),
    readPilesForIds(context.env, dataWorkspaceIds)
  ]);

  const requestCounts = countRequests(Array.isArray(requests) ? requests : [], dataWorkspaceIds);
  const fantasyCounts = countFantasy([
    ...(Array.isArray(ideas) ? ideas : []),
    ...(Array.isArray(graveyard) ? graveyard : [])
  ], dataWorkspaceIds);
  const blindCounts = countBlindReveals(Array.isArray(blindReveals) ? blindReveals : [], dataWorkspaceIds);
  const shelfCounts = countShelf(shelfItems);
  const surfaces = {
    requests: requestCounts.asks,
    replies: requestCounts.replies,
    limits: (Array.isArray(boundaries) ? boundaries : []).filter((row) => (
      inWorkspace(row, dataWorkspaceIds) && !encrypted(row.encryptedText, 12000) && hasText(row.text)
    )).length,
    acts: (Array.isArray(acts) ? acts : []).filter((row) => (
      inWorkspace(row, dataWorkspaceIds) && !encrypted(row.encryptedPayload, 12000) && (
        hasText(row.label) || hasListText(row.tags) || hasObjectText(row.comfort)
      )
    )).length,
    ...fantasyCounts,
    ...shelfCounts,
    ...blindCounts,
    pileLabels: countPileLabels([...piles.active, ...piles.sessions])
  };
  const total = sumCounts(surfaces);

  return jsonResponse(200, {
    workspaceId: access.workspace.id,
    roomE2eeEnabled: Boolean(access.workspace?.settings?.roomE2eeEnabled),
    legacyPlaintext: {
      total,
      surfaces
    },
    canReencryptInBrowser: Boolean(access.workspace?.settings?.roomE2eeEnabled) && total > 0 && e2eeReencryptAvailable(context.env)
  });
}
