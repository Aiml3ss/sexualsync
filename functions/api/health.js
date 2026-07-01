// /api/health
//
// Two surfaces:
//   GET /api/health           - cheap presence-only check (uptime monitors)
//   GET /api/health?probe=1   - active probes against KV, R2, Durable Objects
//
// Probes are scoped to ephemeral keys with a 60s TTL and are safe to call from
// any external monitor. Failing probes degrade `ok` so a monitor can page on a
// single 200-vs-503 comparison.

// Kept as a local copy on purpose: scripts/release-security-check.mjs asserts
// functions/api/health.js literally contains the "cache-control" no-store
// header. Do not replace this with the shared _http.js helper — it would pass
// typecheck but fail check:release.
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function present(value) {
  return Boolean(value);
}

const PROBE_KEY = "health:probe";
const PROBE_TTL_S = 60;
const PROBE_TIMEOUT_MS = 1500;

function timeoutAfter(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}-timeout`)), ms))
  ]);
}

async function probeKv(env) {
  if (!env?.STORE) return { ok: false, error: "not-bound" };
  const stamp = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await timeoutAfter(env.STORE.put(PROBE_KEY, stamp, { expirationTtl: PROBE_TTL_S }), PROBE_TIMEOUT_MS, "kv-put");
    const echoed = await timeoutAfter(env.STORE.get(PROBE_KEY, "text"), PROBE_TIMEOUT_MS, "kv-get");
    return { ok: echoed === stamp, echoed: echoed === stamp };
  } catch (error) {
    return { ok: false, error: String(error?.message || "kv-error").slice(0, 80) };
  }
}

async function probeRoomsDo(env) {
  const ns = env?.ROOMS;
  if (!ns || typeof ns.idFromName !== "function") return { ok: false, error: "not-bound" };
  try {
    const stub = ns.get(ns.idFromName("workspace:__health__"));
    const res = await timeoutAfter(
      stub.fetch("https://room.sexualsync.internal/events?after=0"),
      PROBE_TIMEOUT_MS,
      "rooms-fetch"
    );
    return { ok: res.ok, status: res.status };
  } catch (error) {
    return { ok: false, error: String(error?.message || "rooms-error").slice(0, 80) };
  }
}

async function probeStateDo(env) {
  const ns = env?.STATE;
  if (!ns || typeof ns.idFromName !== "function") {
    // STATE is optional; absence is acceptable but reported.
    return { ok: true, present: false };
  }
  try {
    const stub = ns.get(ns.idFromName("state:__health__"));
    const res = await timeoutAfter(
      stub.fetch("https://state.sexualsync.internal/state/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "__health__" })
      }),
      PROBE_TIMEOUT_MS,
      "state-fetch"
    );
    return { ok: res.ok, status: res.status, present: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || "state-error").slice(0, 80), present: true };
  }
}

async function probeVaultBucket(env) {
  const bucket = env?.VAULT_MEDIA;
  if (!bucket || typeof bucket.list !== "function") return { ok: false, error: "not-bound" };
  try {
    await timeoutAfter(bucket.list({ limit: 1 }), PROBE_TIMEOUT_MS, "r2-list");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || "r2-error").slice(0, 80) };
  }
}

export async function onRequest(context) {
  const env = context?.env || {};
  const url = new URL(context.request.url);
  const wantProbe = url.searchParams.get("probe") === "1";

  const bindings = {
    store: present(env.STORE),
    rooms: present(env.ROOMS),
    state: present(env.STATE),
    vaultMedia: present(env.VAULT_MEDIA),
    vapidPublicKey: present(env.VAPID_PUBLIC_KEY)
  };

  const base = {
    ok: true,
    service: "sexualsync",
    appVersion: env.APP_VERSION || "unknown",
    pages: {
      commitSha: env.CF_PAGES_COMMIT_SHA || "",
      branch: env.CF_PAGES_BRANCH || "",
      url: env.CF_PAGES_URL || ""
    },
    bindings,
    checks: {
      api: true,
      cacheControl: "no-store"
    },
    time: new Date().toISOString()
  };

  if (!wantProbe) return jsonResponse(200, base);

  const [kv, rooms, state, vault] = await Promise.all([
    probeKv(env),
    probeRoomsDo(env),
    probeStateDo(env),
    probeVaultBucket(env)
  ]);

  // Critical = must be ok for the app to function. STATE is optional; its
  // absence is recorded but does not flip the overall ok status.
  const criticalOk = kv.ok && rooms.ok && vault.ok && (!state.present || state.ok);
  return jsonResponse(criticalOk ? 200 : 503, {
    ...base,
    ok: criticalOk,
    probes: {
      kv,
      rooms,
      state,
      vault
    }
  });
}
