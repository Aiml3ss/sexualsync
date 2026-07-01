import { getStore } from "./_kv.js";
import { isNotificationSatisfied, notifyWorkspaceEvent } from "./_notification_policy.js";

const PILE_STORE_NAME = "sexualsync-pile";
const PILE_STORE_PREFIX = `${PILE_STORE_NAME}:`;
const ACTIVE_PILE_RECORD_PREFIX = "pile:";
const ACTIVE_PILE_PREFIX = `${PILE_STORE_PREFIX}${ACTIVE_PILE_RECORD_PREFIX}`;
const ACTIVE_PILE_SUFFIX = ":active";
const REMINDER_PREFIX = `${PILE_STORE_PREFIX}pile-reminders:`;
const MAX_PILES_PER_RUN = 250;
const DUE_WINDOW_MS = 2 * 60 * 1000;
const MIN_DELAY_AFTER_START_MS = 2 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

const REMINDERS = [
  {
    id: "halfway",
    body: "The Pile is halfway to reveal.",
    dueAt(startedAt, revealAt) {
      return startedAt + Math.floor((revealAt - startedAt) / 2);
    }
  },
  {
    id: "one-hour",
    body: "The Pile reveals in about an hour.",
    dueAt(_startedAt, revealAt) {
      return revealAt - ONE_HOUR_MS;
    }
  },
  {
    id: "ten-minutes",
    body: "The Pile reveals in about 10 minutes.",
    dueAt(_startedAt, revealAt) {
      return revealAt - TEN_MINUTES_MS;
    }
  }
];

function parseTime(value) {
  const time = new Date(value || "").getTime();
  return Number.isFinite(time) ? time : 0;
}

function clean(value, max = 160) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function reminderStateKey(workspaceId) {
  return `${REMINDER_PREFIX}${clean(workspaceId, 120)}`;
}

function workspaceIdFromActiveKey(key) {
  if (!key.startsWith(ACTIVE_PILE_PREFIX) || !key.endsWith(ACTIVE_PILE_SUFFIX)) return "";
  return key.slice(ACTIVE_PILE_PREFIX.length, -ACTIVE_PILE_SUFFIX.length);
}

function reminderSignature(pile) {
  return `${clean(pile?.startedAt, 40)}|${clean(pile?.revealAt, 40)}`;
}

function dueReminderDefinitions(pile, nowMs) {
  const startedAt = parseTime(pile?.startedAt);
  const revealAt = parseTime(pile?.revealAt);
  if (!startedAt || !revealAt || revealAt <= startedAt || nowMs >= revealAt) return [];

  return REMINDERS
    .map((reminder) => ({ ...reminder, dueAtMs: reminder.dueAt(startedAt, revealAt) }))
    .filter((reminder) => {
      if (reminder.dueAtMs <= startedAt + MIN_DELAY_AFTER_START_MS) return false;
      if (reminder.dueAtMs >= revealAt) return false;
      if (reminder.dueAtMs > nowMs) return false;
      return nowMs - reminder.dueAtMs <= DUE_WINDOW_MS;
    })
    .sort((a, b) => a.dueAtMs - b.dueAtMs);
}

async function listActivePileKeys(env) {
  // Route through the storage abstraction so DATA_BACKEND=supabase (or dual)
  // sees the same pile records as the runtime. Direct env.STORE.list() would
  // miss everything in Supabase once the migration flips. Returns full
  // namespaced keys ("sexualsync-pile:pile:<workspace>:active") so
  // the rest of this file can keep parsing them with workspaceIdFromActiveKey.
  const store = getStore(env, PILE_STORE_NAME);
  if (!store || typeof store.list !== "function") return [];
  const keys = [];
  let cursor;
  do {
    const page = await store.list({
      prefix: ACTIVE_PILE_RECORD_PREFIX,
      cursor,
      limit: Math.min(1000, MAX_PILES_PER_RUN)
    });
    for (const item of page.keys || []) {
      const recordName = item?.name || "";
      if (recordName.endsWith(ACTIVE_PILE_SUFFIX)) {
        keys.push(`${PILE_STORE_PREFIX}${recordName}`);
      }
      if (keys.length >= MAX_PILES_PER_RUN) return keys;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

async function readJSON(env, key, fallback) {
  try {
    const { storeName, recordKey } = splitStoreKey(key);
    const value = await getStore(env, storeName).get(recordKey, { type: "json" });
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeJSON(env, key, value) {
  const { storeName, recordKey } = splitStoreKey(key);
  await getStore(env, storeName).setJSON(recordKey, value);
}

function splitStoreKey(fullKey) {
  const index = String(fullKey || "").indexOf(":");
  if (index <= 0) return { storeName: "", recordKey: "" };
  return {
    storeName: fullKey.slice(0, index),
    recordKey: fullKey.slice(index + 1)
  };
}

async function notifyReminder(context, workspaceId, pile, reminder) {
  const actorEmail = clean(pile?.startedByEmail, 160);
  if (!actorEmail) return { ok: false, reason: "missing-starter" };
  const results = await notifyWorkspaceEvent(context, workspaceId, actorEmail, {
    title: "Sexualsync",
    body: reminder.body,
    tag: "pile-reminder",
    url: "/games/pile"
  });
  return {
    ok: isNotificationSatisfied(results),
    results
  };
}

export async function processPileReminderNotifications(contextOrEnv, options = {}) {
  const env = contextOrEnv?.env || contextOrEnv;
  const context = contextOrEnv?.env ? contextOrEnv : { env };
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const activeKeys = await listActivePileKeys(env);
  const summary = { scanned: activeKeys.length, sent: 0, skipped: 0, errors: 0 };

  for (const activeKey of activeKeys) {
    const workspaceId = workspaceIdFromActiveKey(activeKey);
    const pile = await readJSON(env, activeKey, null);
    if (!workspaceId || !pile) {
      summary.skipped += 1;
      continue;
    }

    const due = dueReminderDefinitions(pile, nowMs);
    if (!due.length) {
      summary.skipped += 1;
      continue;
    }

    const stateKey = reminderStateKey(workspaceId);
    const signature = reminderSignature(pile);
    const existing = await readJSON(env, stateKey, {});
    const state = existing?.signature === signature
      ? { ...existing, sent: { ...(existing.sent || {}) } }
      : { signature, sent: {} };

    for (const reminder of due) {
      if (state.sent[reminder.id]) continue;
      try {
        const result = await notifyReminder(context, workspaceId, pile, reminder);
        if (!result.ok) {
          summary.skipped += 1;
          continue;
        }
        state.sent[reminder.id] = new Date(nowMs).toISOString();
        await writeJSON(env, stateKey, state);
        summary.sent += 1;
      } catch {
        summary.errors += 1;
      }
    }
  }

  return summary;
}

export const __test__ = {
  dueReminderDefinitions,
  reminderStateKey,
  workspaceIdFromActiveKey
};
