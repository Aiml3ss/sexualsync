import { timingSafeEqual } from "../_app_session.js";

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);

function flag(env, name) {
  return TRUE_VALUES.has(String(env?.[name] || "").trim().toLowerCase());
}

function configuredToken(env) {
  const token = String(env?.E2EE_REENCRYPT_TOKEN || "").trim();
  return token.length >= 24 ? token : "";
}

export function e2eeReencryptAvailable(env) {
  return flag(env, "E2EE_REENCRYPT_ENABLED")
    || flag(env, "ALLOW_E2EE_REENCRYPT")
    || Boolean(configuredToken(env));
}

export function authorizeE2eeReencrypt(request, env, payload = {}) {
  if (!e2eeReencryptAvailable(env)) {
    return { ok: false, status: 403, error: "E2EE migration writes are disabled." };
  }
  const token = configuredToken(env);
  if (!token) return { ok: true };
  const supplied = String(
    request.headers.get("x-e2ee-reencrypt-token")
    || payload.reencryptToken
    || payload.migrationToken
    || ""
  ).trim();
  if (!timingSafeEqual(supplied, token)) {
    return { ok: false, status: 403, error: "Invalid E2EE migration token." };
  }
  return { ok: true };
}
