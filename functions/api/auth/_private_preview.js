export const PRIVATE_PREVIEW_DENIED_MESSAGE = "Sexualsync is in private preview. Public sign-ups are closed for now.";
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

function privatePreviewModeEnabled(env) {
  return !publicSignupsOpen(env);
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

export function privatePreviewAllowsEmail(env, email) {
  if (!privatePreviewModeEnabled(env)) return true;
  const allowed = configuredAllowedEmails(env);
  return allowed.has(normalizeEmail(email));
}

export async function privatePreviewAllowsIdentity(env, email) {
  if (!privatePreviewModeEnabled(env)) return true;
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const allowed = configuredAllowedEmails(env);
  return allowed.has(normalized);
}

export async function requirePrivatePreviewAccess(context, identity) {
  if (await privatePreviewAllowsIdentity(context.env, identity?.email)) return null;
  return new Response(JSON.stringify({ error: PRIVATE_PREVIEW_DENIED_MESSAGE }), {
    status: 403,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export function privatePreviewDeniedRedirect(request) {
  const url = new URL("/signin", request.url);
  url.searchParams.set("access", "private-preview");
  return url.toString();
}
