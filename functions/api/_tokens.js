import { mutateKey, readKey } from "./_state.js";
import { normalizeEmail } from "./_auth.js";

const TOKEN_STORE = "sexualsync-review-tokens";
const TOKENS_KEY = "tokens";
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REVIEW_TOKEN_EXPIRED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TOKENS = 400;

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function capped(tokens) {
  return tokens.slice(0, MAX_TOKENS);
}

function compactTokens(tokens, now = Date.now()) {
  return capped(pruneExpired(tokens, now));
}

function tokensChanged(before, after) {
  if (before.length !== after.length) return true;
  return before.some((token, index) => token !== after[index]);
}

async function readTokens(env) {
  try {
    return asList(await readKey(env, TOKEN_STORE, TOKENS_KEY));
  } catch {
    return [];
  }
}

function pruneExpired(tokens, now = Date.now()) {
  return tokens.filter((token) => {
    const expiresAt = new Date(token.expiresAt || 0).getTime();
    return Number.isFinite(expiresAt) && expiresAt > now - REVIEW_TOKEN_EXPIRED_RETENTION_MS;
  });
}

export async function pruneReviewTokens(env, now = Date.now()) {
  return mutateKey(env, TOKEN_STORE, TOKENS_KEY, (current) => {
    const tokens = asList(current);
    const next = compactTokens(tokens, now);
    if (!tokensChanged(tokens, next)) return { write: false, result: next };
    return { value: next, result: next };
  });
}

function base64UrlEncode(bytes) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function hashToken(token) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(token || ""))
  );
  return base64UrlEncode(new Uint8Array(bytes));
}

export async function createReviewToken(env, { workspaceId, requestId, reviewerEmail, ttlMs = DEFAULT_TTL_MS }) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const id = crypto.randomUUID();
  const tokenValue = randomToken();
  const tokenHash = await hashToken(tokenValue);

  const token = {
    id,
    tokenHash,
    workspaceId,
    requestId,
    reviewerEmail: String(reviewerEmail || "").toLowerCase(),
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    consumedAt: ""
  };

  await mutateKey(env, TOKEN_STORE, TOKENS_KEY, (current) => {
    const tokens = compactTokens(asList(current)).filter((existing) => {
      return !(existing.workspaceId === workspaceId && existing.requestId === requestId && !existing.consumedAt);
    });
    return { value: capped([token, ...tokens]) };
  });

  return { ...token, token: tokenValue };
}

export async function findReviewToken(env, tokenValue) {
  if (!tokenValue) return null;
  const tokenHash = await hashToken(tokenValue);
  // Read-and-filter in memory only. Lookups (resolve/consume) are high-frequency
  // and previously each ran pruneReviewTokens — a CAS write — against the shared
  // hot tokens key, causing write amplification and CAS contention. Pruning the
  // stored list is the job of the mutation paths (createReviewToken /
  // consumeReviewToken / revoke*), which already compactTokens() inside their CAS
  // writes; here we just drop long-expired entries from the in-memory view so a
  // not-yet-pruned record can't be returned as a live match.
  const tokens = pruneExpired(await readTokens(env));
  return tokens.find((token) => token.tokenHash === tokenHash) || null;
}

export function isTokenActive(token, now = Date.now()) {
  if (!token || token.consumedAt) return false;
  const expiresAt = new Date(token.expiresAt || 0).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now;
}

// Single-use: the CAS coordinator serializes this read-modify-write across
// isolates, so two concurrent submissions of the same token can no longer both
// observe it as active. The first wins; the second sees consumedAt set.
export async function consumeReviewToken(env, tokenId) {
  return mutateKey(env, TOKEN_STORE, TOKENS_KEY, (current) => {
    const raw = asList(current);
    const tokens = compactTokens(raw);
    const index = tokens.findIndex((token) => token.id === tokenId);
    if (index === -1 || !isTokenActive(tokens[index])) {
      return tokensChanged(raw, tokens) ? { value: tokens, result: null } : { write: false, result: null };
    }
    const consumed = { ...tokens[index], consumedAt: new Date().toISOString() };
    const next = tokens.map((token, idx) => (idx === index ? consumed : token));
    return { value: capped(next), result: consumed };
  });
}

export async function revokeReviewToken(env, tokenId) {
  return mutateKey(env, TOKEN_STORE, TOKENS_KEY, (current) => {
    const raw = asList(current);
    const tokens = compactTokens(raw);
    const next = tokens.filter((token) => token.id !== tokenId);
    if (next.length === tokens.length) {
      return tokensChanged(raw, tokens) ? { value: tokens, result: false } : { write: false, result: false };
    }
    return { value: next, result: true };
  });
}

export async function revokeRequestTokens(env, workspaceId, requestId) {
  return mutateKey(env, TOKEN_STORE, TOKENS_KEY, (current) => {
    const raw = asList(current);
    const tokens = compactTokens(raw);
    const next = tokens.filter((token) => {
      return !(token.workspaceId === workspaceId && token.requestId === requestId);
    });
    if (next.length === tokens.length) {
      return tokensChanged(raw, tokens) ? { value: tokens, result: false } : { write: false, result: false };
    }
    return { value: next, result: true };
  });
}

export async function revokeWorkspaceTokens(env, workspaceId) {
  return mutateKey(env, TOKEN_STORE, TOKENS_KEY, (current) => {
    const raw = asList(current);
    const tokens = compactTokens(raw);
    const next = tokens.filter((token) => token.workspaceId !== workspaceId);
    if (next.length === tokens.length) {
      return tokensChanged(raw, tokens) ? { value: tokens, result: false } : { write: false, result: false };
    }
    return { value: next, result: true };
  });
}

// Revoke only ONE reviewer's tokens within a workspace — used when a member
// leaves but the workspace itself survives (workspace.js `leave`). A departed
// member's outstanding review links must die immediately; the live membership
// re-check in review-token.js is defense-in-depth, not the sole gate. Scoped by
// (workspaceId, reviewerEmail) so a co-member's links are untouched. The empty
// reviewer guard prevents an unbound caller from mass-revoking tokens whose
// reviewerEmail normalizes to "".
export async function revokeReviewerTokens(env, workspaceId, reviewerEmail) {
  const reviewer = normalizeEmail(reviewerEmail);
  if (!workspaceId || !reviewer) return false;
  return mutateKey(env, TOKEN_STORE, TOKENS_KEY, (current) => {
    const raw = asList(current);
    const tokens = compactTokens(raw);
    const next = tokens.filter((token) => {
      return !(token.workspaceId === workspaceId && normalizeEmail(token.reviewerEmail) === reviewer);
    });
    if (next.length === tokens.length) {
      return tokensChanged(raw, tokens) ? { value: tokens, result: false } : { write: false, result: false };
    }
    return { value: next, result: true };
  });
}
