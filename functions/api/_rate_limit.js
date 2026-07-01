import { mutateKey } from "./_state.js";

const RATE_LIMIT_STORE = "ratelimit";

function cleanKeyPart(value) {
  return String(value || "anon").toLowerCase().replace(/[^a-z0-9@._:-]+/g, "_").slice(0, 120);
}

export async function checkRateLimit(env, { bucket, key, limit, windowSeconds, failClosed = false }) {
  if (!env?.STORE || !bucket || !key || !limit || !windowSeconds) {
    // Can't enforce the limit — STORE binding is missing (misconfig) or a caller
    // passed bad args. Sensitive buckets opt into failing CLOSED so an unbound
    // STORE can't silently disable auth/abuse throttling; best-effort buckets
    // stay open to avoid blocking legitimate use. Mirrors the catch below.
    if (failClosed) return { ok: false, retryAfter: Math.max(1, Number(windowSeconds) || 60) };
    return { ok: true };
  }

  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  // Stable per (bucket, key) record. The window is reset logically inside the
  // transform when it elapses, so we no longer key by a time-bucket id or lean
  // on KV's expirationTtl for cleanup — expiry lives in `windowStart`.
  const storageKey = `rate:${cleanKeyPart(bucket)}:${cleanKeyPart(key)}`;

  // Atomic read-modify-write so N concurrent requests can't each read the same
  // pre-increment count and all slip under the limit (the check-then-set race).
  // mutateKey serializes the read+write through the StateStore CAS coordinator
  // (or a local mutation lock when the STATE binding is absent / dev / KV-only),
  // and retries the transform on a version conflict — so it must be pure and
  // deterministic per attempt. `now` is captured once above for that reason.
  const transform = (current) => {
    const windowStart = Number(current?.windowStart);
    // Start a fresh window when there is no record yet or the prior one elapsed.
    if (!Number.isFinite(windowStart) || now - windowStart >= windowMs) {
      return { value: { count: 1, windowStart: now }, result: { ok: true } };
    }
    const count = Number(current?.count) || 0;
    const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
    if (count >= limit) {
      // Already at the ceiling: don't write, just report when to retry.
      return { write: false, result: { ok: false, retryAfter } };
    }
    return { value: { count: count + 1, windowStart }, result: { ok: true } };
  };

  try {
    return await mutateKey(env, RATE_LIMIT_STORE, storageKey, transform);
  } catch {
    // Sensitive buckets (auth, invites, anything abusable) opt into failing
    // closed so a DO/KV blip can't disable throttling. Best-effort buckets keep
    // failing open to avoid blocking legitimate use on transient errors. We
    // can't read the live window here, so fail-closed retries after a full
    // window — the most conservative wait.
    if (failClosed) return { ok: false, retryAfter: Math.max(1, windowSeconds) };
    return { ok: true };
  }
}

export function rateLimitResponse(retryAfter = 60) {
  return new Response(JSON.stringify({ error: "Too many attempts. Try again soon." }), {
    status: 429,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": String(retryAfter)
    }
  });
}

// Pad the response so callers cannot tell apart success from failure (or one
// failure shape from another) by measuring how long the request took. The
// helper waits until `minMs` has elapsed since `start` before returning. Use
// on enumeration endpoints (invite preview, profile lookup, anywhere a
// 404 vs 200 timing gap would let an attacker probe IDs).
export async function constantTimeResponse(startedAt, minMs, response) {
  const elapsed = Date.now() - Number(startedAt || 0);
  const remaining = Math.max(0, Number(minMs || 0) - elapsed);
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  return response;
}
