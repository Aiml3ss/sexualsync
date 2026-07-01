// Sex Quiz — a double-blind desire profile for the two partners.
//
// Each partner privately rates a deck of intimacy cards (Pass / Curious / Into
// it), with an optional Give / Receive / Both role on cards where that applies,
// and pins a few "top turn-ons". Nothing about a partner's answers is revealed
// until BOTH have submitted — then the API returns the overlap (matches +
// complementary give/receive pairs + curious-together). Each partner's curated
// top picks are shared on reveal so they can surface on the Sexboard / Sext.
//
// Shared product handler (Cloudflare + self-host): only Web-standard globals +
// the storage seam (getStore / mutateKey). v1 is plaintext-at-rest (the store
// envelope encrypts on disk) + double-blind at the app layer; Room-E2EE for the
// ratings is a planned follow-up that would mirror blind-reveals.js.

import { getStore } from "./_kv.js";
import { mutateKey, readKeyStrong } from "./_state.js";
import { getAuthenticatedIdentity, jsonResponse, normalizeEmail } from "./_auth.js";
import {
  authorizeWorkspaceAccess,
  cleanText,
  workspaceIdFromPayload,
  workspaceIdFromRequest,
} from "./_workspaces.js";
import { appendAudit } from "./_audit.js";
import { notifyWorkspaceEvent } from "./_notification_policy.js";

const STORE_NAME = "sexualsync-sex-quiz";
function quizKey(workspaceId) { return `sexQuiz:${workspaceId}`; }
function store(env) { return getStore(env, STORE_NAME); }

const MAX_CARDS = 300;
const MAX_CARD_ID = 64;
const MAX_TOP_PICKS = 5;
const INTERESTS = new Set(["pass", "curious", "into"]);
const ROLES = new Set(["give", "receive", "both"]);

function activeMemberEmails(workspace) {
  return (workspace?.members || [])
    .filter((member) => member.status === "active")
    .map((member) => normalizeEmail(member.email))
    .filter(Boolean);
}

function actorNameFor(access, identity) {
  const actorEmail = normalizeEmail(identity.email);
  return access.actorName
    || access.workspace?.members?.find((member) => normalizeEmail(member.email) === actorEmail)?.displayName
    || "";
}

function cleanRatings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  let count = 0;
  for (const [rawId, rawRating] of Object.entries(value)) {
    if (count >= MAX_CARDS) break;
    const cardId = cleanText(rawId, MAX_CARD_ID);
    if (!cardId || !rawRating || typeof rawRating !== "object") continue;
    const interest = String(rawRating.interest || "");
    if (!INTERESTS.has(interest)) continue;
    const entry = { interest };
    const role = String(rawRating.role || "");
    if (ROLES.has(role)) entry.role = role;
    out[cardId] = entry;
    count += 1;
  }
  return out;
}

function cleanTopPicks(value, ratings) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (out.length >= MAX_TOP_PICKS) break;
    const cardId = cleanText(raw, MAX_CARD_ID);
    // Only "into" cards can be a top pick, and no duplicates.
    if (!cardId || seen.has(cardId) || ratings?.[cardId]?.interest !== "into") continue;
    seen.add(cardId);
    out.push(cardId);
  }
  return out;
}

function entrySubmitted(entry) {
  return Boolean(entry?.submittedAt);
}

function emptyRecord(workspaceId, now) {
  return {
    workspaceId,
    status: "open",
    entries: {},
    fullReveal: {},
    createdAt: now,
    updatedAt: now,
    revealedAt: "",
  };
}

function migrateRecord(raw, workspaceId, now) {
  if (!raw || typeof raw !== "object") return emptyRecord(workspaceId, now);
  const entries = {};
  const rawEntries = raw.entries && typeof raw.entries === "object" ? raw.entries : {};
  for (const [email, entry] of Object.entries(rawEntries)) {
    const normalized = normalizeEmail(email || entry?.email);
    if (!normalized || !entry || typeof entry !== "object") continue;
    const ratings = cleanRatings(entry.ratings);
    entries[normalized] = {
      email: normalized,
      name: cleanText(entry.name, 80),
      ratings,
      topPicks: cleanTopPicks(entry.topPicks, ratings),
      submittedAt: entry.submittedAt || "",
      updatedAt: entry.updatedAt || entry.submittedAt || raw.createdAt || now,
    };
  }
  const fullReveal = {};
  const rawFull = raw.fullReveal && typeof raw.fullReveal === "object" ? raw.fullReveal : {};
  for (const [email, on] of Object.entries(rawFull)) {
    const normalized = normalizeEmail(email);
    if (normalized && on) fullReveal[normalized] = true;
  }
  return {
    workspaceId,
    status: raw.status === "revealed" ? "revealed" : "open",
    entries,
    fullReveal,
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || raw.createdAt || now,
    revealedAt: raw.revealedAt || "",
  };
}

function revealIfComplete(record, workspace, now) {
  const required = activeMemberEmails(workspace);
  if (required.length < 2) return record;
  const submitted = required.filter((email) => entrySubmitted(record.entries?.[email]));
  if (submitted.length < required.length) return record;
  if (record.status === "revealed" && record.revealedAt) return record;
  return { ...record, status: "revealed", revealedAt: record.revealedAt || now, updatedAt: now };
}

// True when both partners want this card *and* their roles cover a giver and a
// receiver — the "you receive · they give" highlight. "both" counts as either.
function isComplementary(myRole, partnerRole) {
  if (!myRole || !partnerRole) return false;
  const roles = [myRole, partnerRole];
  const hasGiver = roles.some((r) => r === "give" || r === "both");
  const hasReceiver = roles.some((r) => r === "receive" || r === "both");
  if (!hasGiver || !hasReceiver) return false;
  // Two identical single-sided roles (give+give / receive+receive) are not a fit.
  return !(myRole === partnerRole && myRole !== "both");
}

function computeOverlap(record, workspace, me) {
  const required = activeMemberEmails(workspace);
  const partnerEmail = required.find((email) => email !== me) || "";
  const mine = record.entries?.[me]?.ratings || {};
  const partner = record.entries?.[partnerEmail]?.ratings || {};
  const matches = [];
  const curiousTogether = [];
  for (const [cardId, myRating] of Object.entries(mine)) {
    const partnerRating = partner[cardId];
    if (!partnerRating) continue;
    if (myRating.interest === "into" && partnerRating.interest === "into") {
      matches.push({
        cardId,
        myRole: myRating.role || "",
        partnerRole: partnerRating.role || "",
        complementary: isComplementary(myRating.role, partnerRating.role),
      });
    } else if (
      (myRating.interest === "into" || myRating.interest === "curious") &&
      (partnerRating.interest === "into" || partnerRating.interest === "curious") &&
      !(myRating.interest === "into" && partnerRating.interest === "into")
    ) {
      curiousTogether.push({ cardId });
    }
  }
  return { matches, curiousTogether };
}

// A top-line "how in sync are we" number: across every card you BOTH rated, the
// share where you pointed the same way — both leaning yes (into/curious, either
// mix) or both passing. A pass-vs-want split is the only disagreement. Returns
// 0-100, or null when you haven't both rated anything to compare.
function computeSyncScore(record, workspace, me) {
  const required = activeMemberEmails(workspace);
  const partnerEmail = required.find((email) => email !== me) || "";
  const mine = record.entries?.[me]?.ratings || {};
  const partner = record.entries?.[partnerEmail]?.ratings || {};
  let both = 0;
  let agree = 0;
  for (const [cardId, myRating] of Object.entries(mine)) {
    const partnerRating = partner[cardId];
    if (!partnerRating) continue;
    both += 1;
    const myYes = myRating.interest === "into" || myRating.interest === "curious";
    const partnerYes = partnerRating.interest === "into" || partnerRating.interest === "curious";
    if ((myYes && partnerYes) || (myRating.interest === "pass" && partnerRating.interest === "pass")) {
      agree += 1;
    }
  }
  if (both === 0) return null;
  return Math.round((agree / both) * 100);
}

export function publicQuiz(record, workspace, actorEmail) {
  const me = normalizeEmail(actorEmail);
  const required = activeMemberEmails(workspace);
  const partnerEmail = required.find((email) => email !== me) || "";
  const mine = record.entries?.[me] || null;
  const partner = record.entries?.[partnerEmail] || null;
  const mySubmitted = entrySubmitted(mine);
  const partnerSubmitted = entrySubmitted(partner);
  // Only ever expose partner data in a genuine two-person revealed round. The
  // exposure target (the single `partnerEmail`) is ambiguous with 3+ active
  // members, so never reveal unless there's exactly one partner — defends the
  // double-blind contract even if a workspace somehow holds an extra member.
  const revealed = record.status === "revealed" && required.length === 2 && Boolean(partnerEmail);

  const out = {
    workspaceId: record.workspaceId,
    status: record.status,
    requiredCount: Math.max(2, required.length),
    mySubmitted,
    partnerSubmitted,
    updatedAt: record.updatedAt,
    revealedAt: record.revealedAt,
    // Your own answers are always yours to see.
    myRatings: mine?.ratings || {},
    myTopPicks: mine?.topPicks || [],
    // Reveal-gated: never expose the partner's picks/overlap until both finished.
    matches: [],
    curiousTogether: [],
    syncScore: null,
    partnerTopPicks: [],
    partnerName: partner?.name || "",
    fullRevealMine: Boolean(record.fullReveal?.[me]),
    fullRevealPartner: Boolean(record.fullReveal?.[partnerEmail]),
    partnerRatings: null,
  };

  if (revealed) {
    const overlap = computeOverlap(record, workspace, me);
    out.matches = overlap.matches;
    out.curiousTogether = overlap.curiousTogether;
    out.syncScore = computeSyncScore(record, workspace, me);
    out.partnerTopPicks = partner?.topPicks || [];
    // Full deck only when BOTH partners opt in.
    if (out.fullRevealMine && out.fullRevealPartner) {
      out.partnerRatings = partner?.ratings || {};
    }
  }
  return out;
}

async function readRecord(env, workspaceId, workspace, now) {
  let raw = null;
  // Strong read so a just-submitted round shows on the Sexboard immediately,
  // instead of lagging behind KV's ~60s eventual consistency.
  try { raw = await readKeyStrong(env, STORE_NAME, quizKey(workspaceId)); } catch { raw = null; }
  return revealIfComplete(migrateRecord(raw, workspaceId, now), workspace, now);
}

// Lightweight submission status for the Sexboard handoff — booleans + reveal
// state only, NEVER any answers, so the double-blind contract holds.
export async function readSexQuizStatus(env, workspace, actorEmail, now = new Date().toISOString()) {
  const record = await readRecord(env, workspace.id, workspace, now);
  const me = normalizeEmail(actorEmail);
  const required = activeMemberEmails(workspace);
  const partnerEmail = required.find((email) => email !== me) || "";
  return {
    status: record.status,
    mySubmitted: entrySubmitted(record.entries?.[me]),
    partnerSubmitted: entrySubmitted(record.entries?.[partnerEmail]),
    revealed: record.status === "revealed" && required.length === 2 && Boolean(partnerEmail),
  };
}

export async function onRequest(context) {
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;

  const request = context.request;
  const method = request.method.toUpperCase();
  let payload = {};
  if (method !== "GET") {
    try { payload = await request.json(); }
    catch { return jsonResponse(400, { error: "Expected JSON body." }); }
  }

  const workspaceId = method === "GET"
    ? workspaceIdFromRequest(request)
    : workspaceIdFromPayload(payload, workspaceIdFromRequest(request));
  const access = await authorizeWorkspaceAccess(context, identity, workspaceId);
  if (!access.ok) return access.response;

  const env = context.env;
  const workspace = access.workspace;
  const actorEmail = normalizeEmail(identity.email);
  const actorName = actorNameFor(access, identity);
  const now = new Date().toISOString();

  if (method === "GET") {
    const record = await readRecord(env, workspace.id, workspace, now);
    return jsonResponse(200, publicQuiz(record, workspace, actorEmail));
  }
  if (method !== "POST") return jsonResponse(405, { error: "Method not allowed." });

  const action = cleanText(payload.action, 40) || "submit";

  if (action === "submit") {
    if (payload.ratings && typeof payload.ratings === "object" && Object.keys(payload.ratings).length > 1000) {
      return jsonResponse(400, { error: "Too many cards." });
    }
    const ratings = cleanRatings(payload.ratings);
    if (Object.keys(ratings).length === 0) {
      return jsonResponse(400, { error: "Answer at least one card before submitting." });
    }
    const topPicks = cleanTopPicks(payload.topPicks, ratings);
    const result = await mutateKey(env, STORE_NAME, quizKey(workspace.id), (current) => {
      const record = migrateRecord(current, workspace.id, now);
      // Re-rating after a reveal reopens the round for this partner; the partner
      // keeps their answers and the reveal re-completes when both are in again.
      // Clear THIS actor's full-reveal opt-in: new answers need fresh consent
      // before the partner can see the whole deck again (it would otherwise
      // re-reveal the new ratings under the previous round's opt-in).
      const fullReveal = { ...(record.fullReveal || {}) };
      delete fullReveal[actorEmail];
      const reopened = record.status === "revealed"
        ? { ...record, status: "open", revealedAt: "", fullReveal }
        : { ...record, fullReveal };
      const nextEntry = {
        email: actorEmail,
        name: actorName,
        ratings,
        topPicks,
        submittedAt: now,
        updatedAt: now,
      };
      let next = {
        ...reopened,
        entries: { ...(reopened.entries || {}), [actorEmail]: nextEntry },
        updatedAt: now,
      };
      next = revealIfComplete(next, workspace, now);
      return { value: next, result: { next } };
    });
    await appendAudit(env, workspace.id, {
      type: "sex_quiz_submitted",
      actorEmail,
      actorName,
      entityType: "sex_quiz",
      entityId: workspace.id,
      metadata: { revealed: result.next.status === "revealed" },
    });
    // Nudge the partner: their reveal is ready (you completed the round) or it's
    // their turn (you finished first). Auto-suppressed if they're currently active.
    context.waitUntil?.(notifyWorkspaceEvent(context, workspace.id, actorEmail, {
      title: "Sexualsync",
      body: "Something new in your room.",
      tag: "game-ready",
      url: "/games/sex-quiz",
    }));
    return jsonResponse(200, publicQuiz(result.next, workspace, actorEmail));
  }

  if (action === "retake") {
    const result = await mutateKey(env, STORE_NAME, quizKey(workspace.id), (current) => {
      const record = migrateRecord(current, workspace.id, now);
      const entries = { ...(record.entries || {}) };
      delete entries[actorEmail];
      const fullReveal = { ...(record.fullReveal || {}) };
      delete fullReveal[actorEmail];
      const next = { ...record, entries, fullReveal, status: "open", revealedAt: "", updatedAt: now };
      return { value: next, result: { next } };
    });
    return jsonResponse(200, publicQuiz(result.next, workspace, actorEmail));
  }

  if (action === "full_reveal") {
    const on = payload.on !== false;
    const result = await mutateKey(env, STORE_NAME, quizKey(workspace.id), (current) => {
      const record = migrateRecord(current, workspace.id, now);
      const fullReveal = { ...(record.fullReveal || {}) };
      if (on) fullReveal[actorEmail] = true; else delete fullReveal[actorEmail];
      const next = revealIfComplete({ ...record, fullReveal, updatedAt: now }, workspace, now);
      return { value: next, result: { next } };
    });
    return jsonResponse(200, publicQuiz(result.next, workspace, actorEmail));
  }

  // Pin/repin your top turn-ons WITHOUT re-rating the deck. Touches only this
  // actor's topPicks — never ratings, status, or the reveal — so someone who
  // skipped the pick step (or wants to change their showcase) can do it after
  // submitting instead of redoing all the cards.
  if (action === "set_top_picks") {
    const result = await mutateKey(env, STORE_NAME, quizKey(workspace.id), (current) => {
      const record = migrateRecord(current, workspace.id, now);
      const entry = record.entries?.[actorEmail];
      if (!entry || !entrySubmitted(entry)) {
        return { value: record, result: { next: record, missing: true } };
      }
      const topPicks = cleanTopPicks(payload.topPicks, entry.ratings || {});
      const nextEntry = { ...entry, topPicks, updatedAt: now };
      const next = {
        ...record,
        entries: { ...(record.entries || {}), [actorEmail]: nextEntry },
        updatedAt: now,
      };
      return { value: next, result: { next } };
    });
    if (result.missing) {
      return jsonResponse(400, { error: "Take the quiz before pinning your top turn-ons." });
    }
    return jsonResponse(200, publicQuiz(result.next, workspace, actorEmail));
  }

  return jsonResponse(400, { error: "Unsupported sex quiz action." });
}
