import { getStore } from "./_kv.js";
import { mutateRecord, readRecord } from "./_state.js";
import {
  LEGACY_DISPLAY_NAME,
  LEGACY_WORKSPACE_ID,
  LEGACY_WORKSPACE_NAME,
  getActiveMember,
  isMemberOfWorkspace,
  jsonResponse,
  normalizeEmail
} from "./_auth.js";

export const PLATFORM_STORE = "sex-exploration-platform";
export const PROFILES_KEY = "profiles";
export const WORKSPACES_KEY = "workspaces";
export const INVITES_KEY = "invites";

const MAX_NAME_LENGTH = 80;
const MAX_EMAIL_LENGTH = 160;

export function platformStore(env) {
  return getStore(env, PLATFORM_STORE);
}

export function cleanText(value, maxLength = MAX_NAME_LENGTH) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function cleanLongText(value, maxLength = 1800) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim().slice(0, maxLength);
}

export function cleanEmail(value) {
  return normalizeEmail(value).slice(0, MAX_EMAIL_LENGTH);
}

export function defaultDisplayName(email) {
  const local = String(email || "").split("@")[0] || "";
  const pretty = local
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim();

  return pretty.slice(0, MAX_NAME_LENGTH) || "Partner";
}

export function configuredLegacyMembers(env = {}) {
  const rawJson = String(env?.LEGACY_MEMBERS_JSON || "").trim();
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (Array.isArray(parsed)) {
        return parsed
          .map((member) => ({
            email: cleanEmail(member?.email),
            displayName: cleanText(member?.displayName || member?.name)
          }))
          .filter((member) => member.email);
      }
    } catch {}
  }

  const emails = String(env?.LEGACY_MEMBER_EMAILS || "")
    .split(",")
    .map(cleanEmail)
    .filter(Boolean);
  const names = String(env?.LEGACY_MEMBER_NAMES || "")
    .split(",")
    .map((name) => cleanText(name))
    .filter(Boolean);

  return emails.map((email, index) => ({
    email,
    displayName: names[index] || defaultDisplayName(email)
  }));
}

export async function readList(store, key) {
  try {
    const value = await store.get(key, {
      type: "json"
    });
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export async function writeList(store, key, list) {
  await store.setJSON(key, list);
}

export function ensureProfile(profiles, email, now, knownDisplayName = "") {
  const normalized = normalizeEmail(email);
  const existing = profiles.find((profile) => normalizeEmail(profile.email) === normalized);

  if (existing) {
    return { profile: existing, profiles, created: false };
  }

  const profile = {
    id: crypto.randomUUID(),
    email: normalized,
    displayName: knownDisplayName || defaultDisplayName(normalized),
    avatarUrl: "",
    createdAt: now,
    updatedAt: now,
    settings: {
      theme: "system",
      defaultWorkspaceId: ""
    }
  };

  return {
    profile,
    profiles: [...profiles, profile],
    created: true
  };
}

function makeLegacyWorkspace(now, legacyMembers = []) {
  const members = legacyMembers
    .map((member, index) => ({
      email: cleanEmail(member.email),
      displayName: cleanText(member.displayName) || defaultDisplayName(member.email),
      role: index === 0 ? "owner" : "partner",
      status: "active",
      joinedAt: now
    }))
    .filter((member) => member.email);

  return {
    id: LEGACY_WORKSPACE_ID,
    name: LEGACY_WORKSPACE_NAME,
    displayName: LEGACY_DISPLAY_NAME,
    createdByEmail: members[0]?.email || "",
    createdAt: now,
    updatedAt: now,
    status: "active",
    productMode: "couples-prototype",
    members,
    settings: {
      // Sprint 0.3 — default ON. Discretion is the category baseline.
      reauthOnLaunch: true
    }
  };
}

export function ensureLegacyWorkspace(workspaces, now, legacyMembers = []) {
  const existing = workspaces.find((workspace) => workspace.id === LEGACY_WORKSPACE_ID);
  if (existing) {
    return { workspace: existing, workspaces, created: false };
  }
  const workspace = makeLegacyWorkspace(now, legacyMembers);
  if (workspace.members.length < 2) {
    return { workspace: null, workspaces, created: false };
  }
  return {
    workspace,
    workspaces: [workspace, ...workspaces],
    created: true
  };
}

export function getUserWorkspaces(workspaces, email) {
  return workspaces.filter((workspace) => isMemberOfWorkspace(workspace, email));
}

export function findWorkspace(workspaces, workspaceId) {
  return workspaces.find((workspace) => workspace.id === workspaceId) || null;
}

export function pickActiveWorkspace(workspaces, profile) {
  const owned = getUserWorkspaces(workspaces, profile?.email || "");
  const preferred = profile?.settings?.defaultWorkspaceId
    ? owned.find((workspace) => workspace.id === profile.settings.defaultWorkspaceId)
    : null;
  return preferred || owned[0] || null;
}

export function legacyPeopleFromWorkspace(workspace) {
  const byEmail = {};
  const emailByName = {};
  (workspace?.members || [])
    .filter((member) => member.status === "active")
    .forEach((member) => {
      const email = normalizeEmail(member.email);
      const name = cleanText(member.displayName);
      if (!email) return;
      byEmail[email] = name;
      if (name) emailByName[name.toLowerCase()] = email;
    });
  return { byEmail, emailByName };
}

export function legacyEmailForName(name, legacyPeople = {}) {
  return legacyPeople.emailByName?.[cleanText(name).toLowerCase()] || "";
}

export function legacyNameForEmail(email, legacyPeople = {}) {
  return legacyPeople.byEmail?.[normalizeEmail(email)] || "";
}

export function autoLegacyEligible(email, legacyWorkspace = null) {
  if (!legacyWorkspace || legacyWorkspace.id !== LEGACY_WORKSPACE_ID) return false;
  const normalized = normalizeEmail(email);
  return (legacyWorkspace.members || []).some((member) => {
    return member.status === "active" && normalizeEmail(member.email) === normalized;
  });
}

export function isLegacyPairWorkspace(workspace, legacyWorkspace = null) {
  const legacyEmails = (legacyWorkspace?.members || [])
    .filter((member) => member.status === "active")
    .map((member) => normalizeEmail(member.email))
    .filter(Boolean);
  if (legacyEmails.length < 2) return false;
  const memberEmails = new Set((workspace?.members || [])
    .filter((member) => member.status === "active")
    .map((member) => normalizeEmail(member.email))
    .filter(Boolean));
  return legacyEmails.every((email) => memberEmails.has(email));
}

export function workspaceIdsForDataAccess(workspace, actorEmail = "", legacyWorkspace = null) {
  const ids = [];
  if (workspace?.id) ids.push(workspace.id);
  if (
    workspace?.id &&
    workspace.id !== LEGACY_WORKSPACE_ID &&
    autoLegacyEligible(actorEmail, legacyWorkspace) &&
    isLegacyPairWorkspace(workspace, legacyWorkspace)
  ) {
    ids.push(LEGACY_WORKSPACE_ID);
  }
  return [...new Set(ids)];
}

// Sprint 0.4 — `displayName` is the publicly-visible room name shown in the
// app, on the lock screen if it ever leaks, and to anyone who glances at the
// phone. Default to the neutral "Your room" rather than auto-combining real
// first names. Callers may pass an explicit `displayName` to override.
const DEFAULT_ROOM_DISPLAY_NAME = "Your room";

export function defaultWorkspacePayload(ownerEmail, partnerEmail, ownerName, partnerName, now, name, displayName) {
  const cleanedOwnerEmail = cleanEmail(ownerEmail);
  const cleanedPartnerEmail = cleanEmail(partnerEmail);
  const ownerDisplay = cleanText(ownerName) || defaultDisplayName(cleanedOwnerEmail);
  const partnerDisplay = cleanText(partnerName) || defaultDisplayName(cleanedPartnerEmail);
  const cleanedDisplayName = cleanText(displayName);

  return {
    id: crypto.randomUUID(),
    name: cleanText(name) || LEGACY_WORKSPACE_NAME,
    displayName: cleanedDisplayName || DEFAULT_ROOM_DISPLAY_NAME,
    createdByEmail: cleanedOwnerEmail,
    createdAt: now,
    updatedAt: now,
    status: "active",
    productMode: "couples",
    members: [
      {
        email: cleanedOwnerEmail,
        displayName: ownerDisplay,
        role: "owner",
        status: "active",
        joinedAt: now
      },
      ...(cleanedPartnerEmail && cleanedPartnerEmail !== cleanedOwnerEmail
        ? [{
            email: cleanedPartnerEmail,
            displayName: partnerDisplay,
            role: "partner",
            status: "invited",
            invitedAt: now
          }]
        : [])
    ],
    settings: {
      // Sprint 0.3 — default ON. Discretion is the category baseline.
      reauthOnLaunch: true
    }
  };
}

export async function loadPlatformState(env) {
  const store = platformStore(env);
  const [profiles, workspaces, invites] = await Promise.all([
    readList(store, PROFILES_KEY),
    readList(store, WORKSPACES_KEY),
    readList(store, INVITES_KEY)
  ]);
  return { store, profiles, workspaces, invites };
}

export async function savePlatformState(store, { profiles, workspaces, invites }) {
  const writes = [];
  if (profiles) writes.push(writeList(store, PROFILES_KEY, profiles));
  if (workspaces) writes.push(writeList(store, WORKSPACES_KEY, workspaces));
  if (invites) writes.push(writeList(store, INVITES_KEY, invites));
  await Promise.all(writes);
}

// --- Atomic platform state (profiles / workspaces / invites) ---
//
// The three lists live under one CAS version so a whole read-modify-write is
// serialized across isolates (see functions/api/_state.js). Use these instead
// of loadPlatformState + savePlatformState for any path that mutates.

const PLATFORM_KEYS = [PROFILES_KEY, WORKSPACES_KEY, INVITES_KEY];
const PLATFORM_RECORD = "platform";

function normalizePlatformLists(raw) {
  return {
    profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
    workspaces: Array.isArray(raw.workspaces) ? raw.workspaces : [],
    invites: Array.isArray(raw.invites) ? raw.invites : []
  };
}

export async function readPlatformState(env) {
  const raw = await readRecord(env, PLATFORM_RECORD, PLATFORM_STORE, PLATFORM_KEYS);
  return normalizePlatformLists(raw);
}

export function legacyWorkspaceFromList(workspaces = []) {
  return workspaces.find((workspace) => workspace.id === LEGACY_WORKSPACE_ID) || null;
}

export async function legacyPeopleForEnv(env) {
  const { workspaces } = await readPlatformState(env);
  return legacyPeopleFromWorkspace(legacyWorkspaceFromList(workspaces));
}

/**
 * Atomically mutate platform state. The transform receives
 * `{ profiles, workspaces, invites }` and returns either:
 *   { abort: <response> }                          -> no write
 *   { profiles?, workspaces?, invites?, result? }  -> writes only the listed lists
 * Returns `{ ok, abort?, result?, state }` where `state` is the post-write view.
 */
export async function mutatePlatformState(env, transform) {
  const out = await mutateRecord(env, PLATFORM_RECORD, PLATFORM_STORE, PLATFORM_KEYS, (raw) => {
    const state = normalizePlatformLists(raw);
    const res = transform(state) || {};
    if (res.abort !== undefined) return { abort: res.abort };
    const values = {};
    if (res.profiles !== undefined) values.profiles = res.profiles;
    if (res.workspaces !== undefined) values.workspaces = res.workspaces;
    if (res.invites !== undefined) values.invites = res.invites;
    return { values, result: res.result };
  });
  if (!out.ok) return { ok: false, abort: out.abort };
  return { ok: true, result: out.result, state: normalizePlatformLists(out.values) };
}

/**
 * Idempotently ensure the caller has a profile (and, for the known couple, the
 * legacy workspace) — atomically. Returns the resulting `{ profiles, workspaces,
 * invites, profile }`.
 */
export async function ensurePlatformIdentity(env, email, { ensureLegacy = false } = {}) {
  const normalized = normalizeEmail(email);
  const configuredMembers = configuredLegacyMembers(env);
  const configuredEmails = new Set(configuredMembers.map((member) => member.email));

  // Fast path: the overwhelmingly common case is a returning user whose profile
  // (and, for the known couple, legacy workspace) already exist. A plain KV read
  // confirms that with no Durable Object hop; only a genuine first-touch needs
  // the atomic CAS write below.
  const current = await readPlatformState(env);
  const hasProfile = current.profiles.some((p) => normalizeEmail(p.email) === normalized);
  const needsLegacy = ensureLegacy && configuredEmails.has(normalized)
    && !current.workspaces.some((w) => w.id === LEGACY_WORKSPACE_ID);
  if (hasProfile && !needsLegacy) {
    const profile = current.profiles.find((p) => normalizeEmail(p.email) === normalized) || null;
    return { ...current, profile };
  }

	  const now = new Date().toISOString();
	  const out = await mutatePlatformState(env, ({ profiles, workspaces, invites }) => {
	    const configuredName = configuredMembers.find((member) => member.email === normalized)?.displayName || "";
	    const profileResult = ensureProfile(profiles, email, now, configuredName);
	    let nextWorkspaces = workspaces;
	    let workspacesChanged = false;
	    if (ensureLegacy && configuredEmails.has(normalized)) {
	      const legacy = ensureLegacyWorkspace(nextWorkspaces, now, configuredMembers);
	      nextWorkspaces = legacy.workspaces;
	      workspacesChanged = legacy.created;
	    }
    const patch = {};
    if (profileResult.created) patch.profiles = profileResult.profiles;
    if (workspacesChanged) patch.workspaces = nextWorkspaces;
    return {
      ...patch,
      result: {
        profiles: profileResult.profiles,
        workspaces: nextWorkspaces,
        invites,
        profile: profileResult.profile
      }
    };
  });
  return out.result;
}

export async function authorizeWorkspaceAccess(context, identity, requestedWorkspaceId) {
  const env = context.env;
  const { profiles, workspaces, invites, profile } = await ensurePlatformIdentity(env, identity.email, {
    ensureLegacy: true
  });

  const workspace = requestedWorkspaceId
    ? findWorkspace(workspaces, requestedWorkspaceId)
    : pickActiveWorkspace(workspaces, profile);

  if (!workspace) {
    return {
      ok: false,
      response: jsonResponse(404, {
        error: "No workspace available for this account."
      })
    };
  }

  if (!isMemberOfWorkspace(workspace, identity.email)) {
    return {
      ok: false,
      response: jsonResponse(403, {
        error: "This data is in a workspace you do not belong to."
      })
    };
  }

  const member = getActiveMember(workspace, identity.email);
  const legacyWorkspace = legacyWorkspaceFromList(workspaces);
  const legacyPeople = legacyPeopleFromWorkspace(legacyWorkspace);

  return {
    ok: true,
    workspace,
    member,
    profile,
    profiles,
    workspaces,
    invites,
    actorName: member?.displayName || profile?.displayName || legacyNameForEmail(identity.email, legacyPeople) || "Partner",
    actorEmail: identity.email,
    legacyPerson: legacyNameForEmail(identity.email, legacyPeople),
    dataWorkspaceIds: workspaceIdsForDataAccess(workspace, identity.email, legacyWorkspace),
    legacyWorkspace,
    legacyPeople
  };
}

export function workspaceIdFromRequest(request, fallback = "") {
  try {
    const url = new URL(request.url);
    return url.searchParams.get("workspaceId") || fallback;
  } catch {
    return fallback;
  }
}

export function workspaceIdFromPayload(payload, fallback = "") {
  if (!payload || typeof payload !== "object") return fallback;
  return cleanText(payload.workspaceId || payload.workspace || "", 64) || fallback;
}
