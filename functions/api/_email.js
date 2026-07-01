import { APP_NAME } from "./_auth.js";

// Generic display name in outbound mail so the lock-screen email preview
// doesn't out the product. The address body (set via RESEND_FROM at deploy)
// can live on your own sending domain for deliverability; what most clients
// surface first is the display name above.
const DEFAULT_FROM = `Notifications <onboarding@resend.dev>`;
const DEFAULT_REPLY_TO = "";

// Single shared subject for every transactional email. Same rationale as the
// push notification scrub in _notification_policy.js — anyone glancing at
// the inbox preview should not learn anything about the product, the
// partner, or the kind of event that triggered the message.
const GENERIC_SUBJECT = "You have a new notification";

function getResendApiKey(env) {
  return (env?.RESEND_API_KEY || "").trim();
}

function getFromAddress(env) {
  return (env?.RESEND_FROM || "").trim() || DEFAULT_FROM;
}

function getReplyTo(env) {
  return (env?.RESEND_REPLY_TO || "").trim() || DEFAULT_REPLY_TO;
}

export function isEmailEnabled(env) {
  return Boolean(getResendApiKey(env));
}

function ensureArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bodyLineHtml(line) {
  if (line && typeof line === "object" && line.kind === "code") {
    const code = String(line.value || "").trim();
    const grouped = code.replace(/^(\d{3})(\d{3})$/, "$1 $2");
    const label = String(line.label || "One-time code").trim();
    return `
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:22px 0 20px;border-collapse:separate;border-spacing:0;">
            <tr>
              <td style="padding:20px 18px;border-radius:16px;background:#170b10;border:1px solid rgba(232,155,166,0.34);box-shadow:0 18px 48px rgba(0,0,0,0.24), inset 0 1px 0 rgba(255,255,255,0.05);text-align:center;">
                <p style="margin:0 0 10px;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:#d9a441;">${escapeHtml(label)}</p>
                <p style="margin:0;font-family:'SFMono-Regular','Roboto Mono','Courier New',monospace;font-size:34px;line-height:1.15;font-weight:800;letter-spacing:0.12em;color:#f8ece8;">${escapeHtml(grouped)}</p>
              </td>
            </tr>
          </table>`;
  }

  if (line && typeof line === "object" && line.kind === "small") {
    return `<p style="margin:0 0 12px;font-size:13px;line-height:1.55;color:#a9948f;">${escapeHtml(line.value)}</p>`;
  }

  const value = line && typeof line === "object" ? line.value : line;
  return `<p style="margin:0 0 12px;">${escapeHtml(value)}</p>`;
}

function bodyLineText(line) {
  if (line && typeof line === "object" && line.kind === "code") {
    return `${line.label || "One-time code"}: ${line.value || ""}`;
  }
  const value = line && typeof line === "object" ? line.value : line;
  return String(value || "");
}

function wrapHtml(title, intro, bodyLines, ctaLabel, ctaUrl, footer) {
  const safeIntro = escapeHtml(intro);
  const safeTitle = escapeHtml(title);
  const safeFooter = escapeHtml(footer || `Sent privately by ${APP_NAME}.`);
  const bodyHtml = bodyLines.map(bodyLineHtml).join("");
  const cta = ctaLabel && ctaUrl
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:12px 22px;border-radius:8px;background:#e89ba6;color:#170b10;font-weight:800;text-decoration:none;">${escapeHtml(ctaLabel)}</a></p>`
    : "";

  return `<!doctype html>
<html>
  <body style="margin:0;padding:32px 16px;background:#170b10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#f2e0d8;line-height:1.55;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="width:100%;max-width:560px;margin:0 auto;background:#25141a;border-radius:12px;border:1px solid rgba(242,224,216,0.16);overflow:hidden;">
      <tr>
        <td style="padding:28px 28px 8px;">
          <p style="margin:0 0 4px;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#e89ba6;">${escapeHtml(APP_NAME)}</p>
          <h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;color:#f2e0d8;">${safeTitle}</h1>
          <p style="margin:0 0 20px;color:#cdb8b2;">${safeIntro}</p>
          ${bodyHtml}
          ${cta}
        </td>
      </tr>
      <tr>
        <td style="padding:18px 28px 28px;border-top:1px solid rgba(242,224,216,0.12);font-size:12px;color:#9f8c87;">
          ${safeFooter}
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function wrapText(title, intro, bodyLines, ctaLabel, ctaUrl, footer) {
  const cta = ctaLabel && ctaUrl ? `\n\n${ctaLabel}: ${ctaUrl}` : "";
  const footerText = footer || `Sent privately by ${APP_NAME}.`;
  return `${title}\n\n${intro}\n\n${bodyLines.map(bodyLineText).join("\n\n")}${cta}\n\n--\n${footerText}`;
}

async function sendEmail(env, { to, subject, title, intro, body = [], ctaLabel = "", ctaUrl = "", footer = "" }) {
  const recipients = ensureArray(to).filter(Boolean);
  if (!recipients.length) return { ok: false, skipped: true, reason: "no-recipients" };
  if (!isEmailEnabled(env)) return { ok: false, skipped: true, reason: "no-api-key" };

  const payload = {
    from: getFromAddress(env),
    to: recipients,
    subject,
    html: wrapHtml(title, intro, body, ctaLabel, ctaUrl, footer),
    text: wrapText(title, intro, body, ctaLabel, ctaUrl, footer)
  };

  const replyTo = getReplyTo(env);
  if (replyTo) payload.reply_to = replyTo;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getResendApiKey(env)}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { ok: false, status: response.status, error: text.slice(0, 280) };
    }

    const data = await response.json().catch(() => ({}));
    return { ok: true, id: data.id || "" };
  } catch (error) {
    return { ok: false, error: error?.message || "send-failed" };
  }
}

export async function sendRequestEmail(env, { to, fromName, toName, reviewUrl, workspaceDisplayName }) {
  return sendEmail(env, {
    to,
    subject: GENERIC_SUBJECT,
    title: "A private ask is waiting",
    intro: `${fromName || "Your partner"} put an ask in ${workspaceDisplayName || APP_NAME}.`,
    body: [
      "Open the private review link below. You'll sign in first; the details stay inside the room.",
      `Hi ${toName || ""}, answer each part clearly: Yes, Maybe, Let's chat, No, or Counter when a better version comes to mind.`
    ],
    ctaLabel: "Answer the ask",
    ctaUrl: reviewUrl,
    footer: `Sent privately to ${to} by ${APP_NAME}. No content is included in the subject line.`
  });
}

export async function sendRequestReminderEmail(env, { to, fromName, toName, reviewUrl, workspaceDisplayName }) {
  return sendEmail(env, {
    to,
    subject: GENERIC_SUBJECT,
    title: "An ask is still waiting",
    intro: `${fromName || "Your partner"} is waiting on your answer in ${workspaceDisplayName || APP_NAME}.`,
    body: [
      "Open the private review link below when you have a minute.",
      `Hi ${toName || ""}, a clean answer is enough: yes, maybe, talk first, counter, or no.`
    ],
    ctaLabel: "Answer the ask",
    ctaUrl: reviewUrl,
    footer: `Sent privately to ${to} by ${APP_NAME}. No request details are included in this email.`
  });
}

export async function sendReviewEmail(env, { to, fromName, toName, dashboardUrl, workspaceDisplayName, hasYes }) {
  return sendEmail(env, {
    to,
    subject: GENERIC_SUBJECT,
    title: hasYes ? "They answered. Something landed." : "They answered your ask.",
    intro: `${fromName || "Your partner"} sent their answer in ${workspaceDisplayName || APP_NAME}.`,
    body: [
      hasYes
        ? "Open Sexboard to see what is on."
        : "Open Sexboard to see the response and any counters.",
      `Hi ${toName || ""}, the private details are waiting inside.`
    ],
    ctaLabel: "Open Sexboard",
    ctaUrl: dashboardUrl,
    footer: `Sent privately to ${to} by ${APP_NAME}.`
  });
}

export async function sendCounterAcceptedEmail(env, { to, fromName, toName, dashboardUrl, workspaceDisplayName }) {
  return sendEmail(env, {
    to,
    subject: GENERIC_SUBJECT,
    title: "Your counter was accepted",
    intro: `${fromName || "Your partner"} accepted your counter in ${workspaceDisplayName || APP_NAME}.`,
    body: [
      "Open Sexboard to see what landed.",
      `Hi ${toName || ""}, this is now an agreed ask.`
    ],
    ctaLabel: "Open Sexboard",
    ctaUrl: dashboardUrl,
    footer: `Sent privately to ${to} by ${APP_NAME}. No request details are included in this email.`
  });
}

export async function sendInviteEmail(env, { to, fromName, inviteUrl, workspaceDisplayName }) {
  return sendEmail(env, {
    to,
    subject: GENERIC_SUBJECT,
    title: `${fromName || "Someone"} wants a private room with you`,
    intro: `${fromName || "Someone"} invited you into ${workspaceDisplayName || APP_NAME}.`,
    body: [
      "It is private to the two of you. Only invited members can see the inside.",
      "Open the invite below to sign in and decide."
    ],
    ctaLabel: "Open invite",
    ctaUrl: inviteUrl,
    footer: `Sent to ${to} by ${APP_NAME}. If you weren't expecting this, you can ignore it.`
  });
}

export async function sendSignInCodeEmail(env, { to, code }) {
  return sendEmail(env, {
    to,
    subject: GENERIC_SUBJECT,
    title: "Your private sign-in code",
    intro: "Use the code below to finish signing in to your room.",
    body: [
      { kind: "code", label: "One-time sign-in code", value: code },
      "This code expires shortly and can only be used once.",
      { kind: "small", value: "If you did not ask for this, you can ignore this email." }
    ],
    ctaLabel: "",
    ctaUrl: "",
    footer: `Sent privately to ${to} by ${APP_NAME}.`
  });
}

export async function sendBoundaryChangeEmail(env, { to, fromName, dashboardUrl, workspaceDisplayName }) {
  return sendEmail(env, {
    to,
    subject: GENERIC_SUBJECT,
    title: "Shared limits changed",
    intro: `${fromName || "Your partner"} updated limits in ${workspaceDisplayName || APP_NAME}.`,
    body: [
      "Open the room when you have a minute to see what changed.",
      "No details are included in this email by design."
    ],
    ctaLabel: "Open the room",
    ctaUrl: dashboardUrl,
    footer: `Sent privately to ${to} by ${APP_NAME}.`
  });
}

export async function sendDeletionScheduledEmail(env, { to, fromName, workspaceDisplayName, completeAt, dashboardUrl }) {
  return sendEmail(env, {
    to,
    subject: GENERIC_SUBJECT,
    title: "This room is scheduled to close",
    intro: `${fromName || "A member"} scheduled deletion of ${workspaceDisplayName || "your room"}.`,
    body: [
      `The room and all of its data will be permanently deleted on ${completeAt}.`,
      "If this was a mistake, open the room before that date and cancel the deletion."
    ],
    ctaLabel: "Open the room",
    ctaUrl: dashboardUrl,
    footer: `Sent privately to ${to} by ${APP_NAME}.`
  });
}
