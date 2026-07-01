// Green Lights — a double-blind comfort & agreements questionnaire.
//
// Sibling to the Sex Quiz, different axis: each partner privately answers a deck
// of statements on per-question answer scales (comfort / agree / want / matters
// / prefer / cadence — see green-lights-deck.ts). Nothing is revealed until BOTH
// submit; then the API hands back the partner's full answer set and the CLIENT
// derives every bucket (green lights, agreed limits, talk-about-these, cadence
// gaps, sync %) from the deck. The server is intentionally scale-agnostic: it
// stores opaque value ids + notes and only gates the double-blind reveal.
//
// Shared product handler (Cloudflare + self-host): only Web-standard globals +
// the storage seam (getStore / mutateKey). v1 is plaintext-at-rest (the store
// envelope encrypts on disk) + double-blind at the app layer, mirroring sex-quiz.js.

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

const STORE_NAME = "sexualsync-green-lights";
function greenLightsKey(workspaceId) { return `greenLights:${workspaceId}`; }
function store(env) { return getStore(env, STORE_NAME); }

const MAX_CARDS = 300;
const MAX_CARD_ID = 64;
const MAX_NOTE = 240;
const MAX_VALUE_LEN = 40;

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

function cleanAnswers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  let count = 0;
  for (const [rawId, rawAns] of Object.entries(value)) {
    if (count >= MAX_CARDS) break;
    const cardId = cleanText(rawId, MAX_CARD_ID);
    if (!cardId || !rawAns || typeof rawAns !== "object") continue;
    // The deck (client-side) owns each card's answer scale + its option ids; the
    // server is a dumb double-blind store, so it keeps an opaque, length-capped
    // value string + optional note and never interprets them.
    const v = cleanText(rawAns.value, MAX_VALUE_LEN);
    if (!v) continue;
    const entry = { value: v };
    const note = cleanText(rawAns.note, MAX_NOTE);
    if (note) entry.note = note;
    out[cardId] = entry;
    count += 1;
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
    entries[normalized] = {
      email: normalized,
      name: cleanText(entry.name, 80),
      answers: cleanAnswers(entry.answers),
      submittedAt: entry.submittedAt || "",
      updatedAt: entry.updatedAt || entry.submittedAt || raw.createdAt || now,
    };
  }
  return {
    workspaceId,
    status: raw.status === "revealed" ? "revealed" : "open",
    entries,
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

export function publicGreenLights(record, workspace, actorEmail) {
  const me = normalizeEmail(actorEmail);
  const required = activeMemberEmails(workspace);
  const partnerEmail = required.find((email) => email !== me) || "";
  const mine = record.entries?.[me] || null;
  const partner = record.entries?.[partnerEmail] || null;
  const mySubmitted = entrySubmitted(mine);
  const partnerSubmitted = entrySubmitted(partner);
  // Never expose partner data unless it's a genuine two-person revealed round.
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
    myAnswers: mine?.answers || {},
    partnerName: partner?.name || "",
    // Reveal-gated: the partner's full answer set. The client derives every
    // bucket (green lights / agreed limits / talk / cadence gap / sync %) from
    // myAnswers + partnerAnswers using the deck — the server stays scale-agnostic.
    partnerAnswers: {},
  };

  if (revealed) {
    out.partnerAnswers = partner?.answers || {};
  }
  return out;
}

async function readRecord(env, workspaceId, workspace, now) {
  let raw = null;
  // Strong read so a just-submitted round shows on the Sexboard immediately,
  // instead of lagging behind KV's ~60s eventual consistency.
  try { raw = await readKeyStrong(env, STORE_NAME, greenLightsKey(workspaceId)); } catch { raw = null; }
  return revealIfComplete(migrateRecord(raw, workspaceId, now), workspace, now);
}

// Lightweight submission status for the Sexboard handoff — booleans + reveal
// state only, NEVER any answers, so the double-blind contract holds.
export async function readGreenLightsStatus(env, workspace, actorEmail, now = new Date().toISOString()) {
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
    return jsonResponse(200, publicGreenLights(record, workspace, actorEmail));
  }
  if (method !== "POST") return jsonResponse(405, { error: "Method not allowed." });

  const action = cleanText(payload.action, 40) || "submit";

  if (action === "submit") {
    if (payload.answers && typeof payload.answers === "object" && Object.keys(payload.answers).length > 1000) {
      return jsonResponse(400, { error: "Too many answers." });
    }
    const answers = cleanAnswers(payload.answers);
    if (Object.keys(answers).length === 0) {
      return jsonResponse(400, { error: "Answer at least one before submitting." });
    }
    const result = await mutateKey(env, STORE_NAME, greenLightsKey(workspace.id), (current) => {
      const record = migrateRecord(current, workspace.id, now);
      // Re-answering after a reveal reopens the round for this partner; the
      // partner keeps their answers and the reveal re-completes when both are in.
      const reopened = record.status === "revealed"
        ? { ...record, status: "open", revealedAt: "" }
        : record;
      const nextEntry = {
        email: actorEmail,
        name: actorName,
        answers,
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
      type: "green_lights_submitted",
      actorEmail,
      actorName,
      entityType: "green_lights",
      entityId: workspace.id,
      metadata: { revealed: result.next.status === "revealed" },
    });
    // Nudge the partner: their reveal is ready (you completed the round) or it's
    // their turn (you finished first). Auto-suppressed if they're currently active.
    context.waitUntil?.(notifyWorkspaceEvent(context, workspace.id, actorEmail, {
      title: "Sexualsync",
      body: "Something new in your room.",
      tag: "game-ready",
      url: "/games/green-lights",
    }));
    return jsonResponse(200, publicGreenLights(result.next, workspace, actorEmail));
  }

  if (action === "retake") {
    const result = await mutateKey(env, STORE_NAME, greenLightsKey(workspace.id), (current) => {
      const record = migrateRecord(current, workspace.id, now);
      const entries = { ...(record.entries || {}) };
      delete entries[actorEmail];
      const next = { ...record, entries, status: "open", revealedAt: "", updatedAt: now };
      return { value: next, result: { next } };
    });
    return jsonResponse(200, publicGreenLights(result.next, workspace, actorEmail));
  }

  return jsonResponse(400, { error: "Unsupported green lights action." });
}
