import { isSelfHostNodeRuntime } from "../_runtime.js";

const PLACEHOLDER_EMAILS = new Set(["you@example.com", "partner@example.com"]);

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function publicSignupsOpen(env) {
  return ["1", "true", "yes", "on", "open"].includes(String(env?.PUBLIC_SIGNUPS_OPEN || "").trim().toLowerCase());
}

function explicitAllowedEmailsRaw(env) {
  return String(
    env?.PRIVATE_PREVIEW_ALLOWED_EMAILS
    || env?.SEXUALSYNC_ALLOWED_EMAILS
    || ""
  ).trim();
}

function configuredAllowedEmails(env) {
  const raw = explicitAllowedEmailsRaw(env);
  const configured = new Set(
    raw
      .split(/[\s,;]+/g)
      .map((item) => normalizeEmail(item))
      .filter(Boolean)
  );
  const adminEmail = normalizeEmail(env?.SEXUALSYNC_ADMIN_EMAIL);
  if (adminEmail) configured.add(adminEmail);
  return configured;
}

function hasRealAllowlist(env) {
  const allowed = configuredAllowedEmails(env);
  if (allowed.size === 0) return false;
  return [...allowed].some((email) => !PLACEHOLDER_EMAILS.has(email));
}

export function localPasswordAuthEnabled(env) {
  return isSelfHostNodeRuntime(env);
}

export function selfHostLocalPasswordAllowsEmail(env, email) {
  if (!localPasswordAuthEnabled(env)) return false;
  if (publicSignupsOpen(env)) return true;
  const allowed = configuredAllowedEmails(env);
  if (!hasRealAllowlist(env)) return true;
  return allowed.has(normalizeEmail(email));
}
