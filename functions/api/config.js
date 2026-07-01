import { jsonResponse } from "./_http.js";
import { isSelfHostNodeRuntime, runtimeTarget } from "./_runtime.js";
import { localPasswordAuthEnabled } from "./auth/_local_password.js";

// Active room-encryption KDF version for NEW rooms on this deploy. Anything
// other than an explicit "v2" resolves to "v1" — so production (flag unset)
// stays on the historical 310k path, and a typo can never select an undefined
// iteration count. Self-host sets ROOM_E2EE_KDF_VERSION=v2 to mint new rooms at
// 600k. Existing rooms ignore this; they derive at the version in their verifier.
function roomE2eeKdfVersion(env) {
  return String(env.ROOM_E2EE_KDF_VERSION || "").trim().toLowerCase() === "v2" ? "v2" : "v1";
}

export async function onRequest(context) {
  const env = context.env || {};
  const googleAuthEnabled = Boolean(
    env.GOOGLE_CLIENT_ID
    && env.GOOGLE_CLIENT_SECRET
    && String(env.APP_SESSION_SECRET || "").trim().length >= 32
  );
  const emailAuthEnabled = Boolean(
    env.RESEND_API_KEY
    && String(env.APP_SESSION_SECRET || "").trim().length >= 32
  );
  // The legacy Supabase browser-auth path has been removed, so the backend
  // project URL/key are never published to the client.
  return jsonResponse(200, {
    sentryDsn: env.SENTRY_DSN_PUBLIC || "",
    appVersion: env.APP_VERSION || "unknown",
    runtimeTarget: runtimeTarget(env),
    selfHost: isSelfHostNodeRuntime(env),
    localPasswordAuthEnabled: localPasswordAuthEnabled(env),
    vapidPublicKey: env.VAPID_PUBLIC_KEY || "",
    googleAuthEnabled,
    emailAuthEnabled,
    roomE2eeKdfVersion: roomE2eeKdfVersion(env),
    // GIF search needs a RedGifs egress IP that RedGifs doesn't block. Self-host
    // runs from a normal IP (works directly); Cloudflare's IPs are blocked, so it
    // needs REDGIFS_PROXY (an unblocked byte-proxy). The Sext composer only shows
    // the GIF button when one of those is true — otherwise the picker would just
    // come back empty.
    gifSearch: isSelfHostNodeRuntime(env) || Boolean(String(env.REDGIFS_PROXY || "").trim())
  });
}
