// Minimal Sentry envelope reporter for Cloudflare Pages Functions.
//
// No SDK dependency. If `SENTRY_DSN_SERVER` is not set, this is a no-op so
// the deployment behaves identically until the secret is added.
//
// DSN format: https://<publicKey>@<host>/<projectId>
// Envelope endpoint: https://<host>/api/<projectId>/envelope/

function parseDsn(dsn) {
  if (!dsn || typeof dsn !== "string") return null;
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\/+/, "").split("/").pop();
    if (!url.username || !projectId) return null;
    return {
      host: url.host,
      publicKey: url.username,
      projectId
    };
  } catch {
    return null;
  }
}

function authHeader(parsed) {
  // sentry_key + sentry_version is the documented minimal authorization scheme
  // accepted by the envelope endpoint.
  return `Sentry sentry_version=7, sentry_client=sexualsync/1.0, sentry_key=${parsed.publicKey}`;
}

function safeUrl(request) {
  try {
    const url = new URL(request.url);
    // Strip the query so we don't leak invite codes, tokens, etc.
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function safeRequest(request) {
  return {
    url: safeUrl(request),
    method: request.method,
    headers: {
      "user-agent": request.headers.get("user-agent") || "",
      "cf-ray": request.headers.get("cf-ray") || ""
    }
  };
}

// Redact bare email addresses so a thrown message that interpolates a user's
// email (e.g. "no member for alice@example.com") doesn't leak PII to Sentry.
// Conservative pattern; the local part is masked, the domain kept for triage.
function redactEmails(text) {
  return String(text).replace(/[^\s@<>()]+@([^\s@<>()]+\.[^\s@<>()]+)/g, "[redacted]@$1");
}

function safeError(error) {
  const message = redactEmails(String(error?.message || error || "unknown-error")).slice(0, 500);
  const stack = String(error?.stack || "").split("\n").slice(0, 30).join("\n").slice(0, 4000);
  const type = error?.name || "Error";
  return { type, message, stack };
}

export function sentryEnabled(env) {
  return Boolean(parseDsn(env?.SENTRY_DSN_SERVER));
}

export function captureException(context, error, extra = {}) {
  const parsed = parseDsn(context?.env?.SENTRY_DSN_SERVER);
  if (!parsed) return;

  const release = String(context?.env?.APP_VERSION || "unknown");
  const environment = String(context?.env?.SENTRY_ENVIRONMENT || "production");
  const safe = safeError(error);

  const event = {
    event_id: crypto.randomUUID().replace(/-/g, ""),
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: "error",
    release,
    environment,
    server_name: "cloudflare-pages",
    exception: {
      values: [{
        type: safe.type,
        value: safe.message,
        stacktrace: { frames: [{ filename: "worker", function: safe.type, in_app: true, pre_context: [], context_line: safe.stack, post_context: [] }] }
      }]
    },
    request: context?.request ? safeRequest(context.request) : undefined,
    extra
  };

  const envelopeHeader = JSON.stringify({
    event_id: event.event_id,
    sent_at: new Date().toISOString(),
    dsn: context.env.SENTRY_DSN_SERVER
  });
  const itemHeader = JSON.stringify({ type: "event" });
  const itemBody = JSON.stringify(event);
  const body = `${envelopeHeader}\n${itemHeader}\n${itemBody}\n`;

  const send = fetch(`https://${parsed.host}/api/${parsed.projectId}/envelope/`, {
    method: "POST",
    headers: {
      "content-type": "application/x-sentry-envelope",
      "x-sentry-auth": authHeader(parsed)
    },
    body
  }).catch(() => null);

  if (typeof context?.waitUntil === "function") {
    context.waitUntil(send);
  }
}
