// Timezone / DST date math for request-board expiry calculations.
//
// Extracted verbatim from request-board.js (behavior-preserving) to isolate the
// Intl-based DST handling from the request-board handler. Every function here is
// pure: no env, storage, network, or shared mutable state — only Intl/Date.
// Web-standard only (runs on both the Cloudflare and Node editions).
//
// The expiry clock is anchored to a fixed civil timezone so "Tonight"/"Tomorrow"
// windows roll over at local midnight regardless of where the runtime executes.
const REQUEST_EXPIRY_TIME_ZONE = "America/Los_Angeles";

export function zonedParts(date, timeZone = REQUEST_EXPIRY_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function timeZoneOffsetMs(timeZone, date) {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

export function zonedDateTimeUtc(year, month, day, hour = 0, minute = 0, second = 0, timeZone = REQUEST_EXPIRY_TIME_ZONE) {
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  let utc = targetUtc;
  for (let i = 0; i < 3; i += 1) {
    utc = targetUtc - timeZoneOffsetMs(timeZone, new Date(utc));
  }
  return new Date(utc);
}

export function zonedMidnightUtc(year, month, day, timeZone = REQUEST_EXPIRY_TIME_ZONE) {
  return zonedDateTimeUtc(year, month, day, 0, 0, 0, timeZone);
}

export function addDaysToDateParts({ year, month, day }, days) {
  const next = new Date(Date.UTC(year, month - 1, day + days, 0, 0, 0, 0));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate()
  };
}
