import { jsonResponse } from "./_auth.js";
import { timingSafeEqual } from "./_app_session.js";
import { processPileReminderNotifications } from "./_pile_reminders.js";

function configuredToken(env) {
  return String(env?.PILE_REMINDER_RUNNER_TOKEN || "").trim();
}

function requestToken(request) {
  return String(request.headers.get("x-sexualsync-reminder-token") || "").trim();
}

function authorized(context) {
  const expected = configuredToken(context.env);
  const actual = requestToken(context.request);
  return Boolean(expected && actual && timingSafeEqual(expected, actual));
}

export async function onRequestPost(context) {
  if (!authorized(context)) {
    return jsonResponse(401, { error: "Unauthorized." });
  }
  const summary = await processPileReminderNotifications(context);
  return jsonResponse(200, { ok: true, ...summary });
}

export function onRequest() {
  return jsonResponse(405, { error: "Method not allowed." });
}
