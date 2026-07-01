import {
  getAuthenticatedIdentity,
  jsonResponse
} from "./_auth.js";
import {
  authorizeWorkspaceAccess,
  workspaceIdFromRequest
} from "./_workspaces.js";
import {
  cleanText,
  readVault
} from "./_vault.js";

function mediaBucket(env) {
  const bucket = env?.VAULT_MEDIA;
  return bucket && typeof bucket.get === "function" ? bucket : null;
}

function noStoreResponse(status, body) {
  return jsonResponse(status, body);
}

function objectSize(object) {
  return object?.size || object?.httpMetadata?.contentLength || 0;
}

function baseMediaHeaders() {
  return new Headers({
    "content-type": "application/octet-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // Advertise range support so clients (iOS <video>/<audio> seekers) know they
    // may request byte ranges instead of pulling the whole encrypted blob.
    "accept-ranges": "bytes"
  });
}

function mediaResponse(object) {
  const headers = baseMediaHeaders();
  const size = objectSize(object);
  if (size) headers.set("content-length", String(size));
  return new Response(object.body, { status: 200, headers });
}

// Parse a single HTTP `Range: bytes=...` request header against a known total
// size. Returns { offset, length } (R2 `range` option shape), the special value
// "unsatisfiable" for a syntactically valid but out-of-bounds range, or null
// when there is no usable single byte-range (caller serves the full 200).
// Only the single-range forms are honored (start-end, start-, -suffix); a
// multi-range header (comma) falls back to the full 200.
function parseByteRange(rangeHeader, totalSize) {
  if (!rangeHeader || !totalSize) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match) return null;
  const startRaw = match[1];
  const endRaw = match[2];
  if (startRaw === "" && endRaw === "") return null;

  let offset;
  let length;
  if (startRaw === "") {
    // Suffix range: last N bytes.
    const suffix = Number(endRaw);
    if (!suffix) return "unsatisfiable";
    length = Math.min(suffix, totalSize);
    offset = totalSize - length;
  } else {
    offset = Number(startRaw);
    if (offset >= totalSize) return "unsatisfiable";
    const end = endRaw === "" ? totalSize - 1 : Math.min(Number(endRaw), totalSize - 1);
    if (end < offset) return "unsatisfiable";
    length = end - offset + 1;
  }
  return { offset, length };
}

function partialMediaResponse(object, range, totalSize) {
  const headers = baseMediaHeaders();
  const end = range.offset + range.length - 1;
  headers.set("content-length", String(range.length));
  headers.set("content-range", `bytes ${range.offset}-${end}/${totalSize}`);
  return new Response(object.body, { status: 206, headers });
}

function rangeNotSatisfiableResponse(totalSize) {
  const headers = baseMediaHeaders();
  headers.set("content-range", `bytes */${totalSize}`);
  headers.delete("content-length");
  return new Response(null, { status: 416, headers });
}

export async function onRequest(context) {
  if (context.request.method.toUpperCase() !== "GET") {
    return noStoreResponse(405, { error: "Method not allowed." });
  }

  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;

  const bucket = mediaBucket(context.env);
  if (!bucket) return noStoreResponse(503, { error: "Vault media storage is not configured." });

  const url = new URL(context.request.url);
  const workspaceId = workspaceIdFromRequest(context.request);
  const id = cleanText(url.searchParams.get("id"), 120);
  const kind = cleanText(url.searchParams.get("kind"), 40) || "video";
  const momentId = cleanText(url.searchParams.get("momentId"), 120);

  const access = await authorizeWorkspaceAccess(context, identity, workspaceId);
  if (!access.ok) return access.response;
  if (!id) return noStoreResponse(400, { error: "id required." });

  const items = await readVault(context.env, access.workspace.id);
  const item = items.find((entry) => entry.id === id);
  if (!item) return noStoreResponse(404, { error: "Vault item not found." });

  let key = "";
  if (kind === "moment") {
    const moment = (Array.isArray(item.moments) ? item.moments : []).find((entry) => entry.id === momentId);
    key = cleanText(moment?.frameKey, 260);
  } else {
    key = cleanText(item.mediaKey, 260);
  }
  if (!key) return noStoreResponse(404, { error: "Vault media not found." });

  // Range support. Determine the total size first (cheap HEAD when available)
  // so we can validate the requested range and emit a correct Content-Range.
  const rangeHeader = context.request.headers.get("range");
  let totalSize = 0;
  if (rangeHeader && typeof bucket.head === "function") {
    const meta = await bucket.head(key).catch(() => null);
    totalSize = objectSize(meta);
  }
  const wantRange = rangeHeader && totalSize ? parseByteRange(rangeHeader, totalSize) : null;
  if (wantRange === "unsatisfiable") return rangeNotSatisfiableResponse(totalSize);

  if (wantRange) {
    const object = await bucket.get(key, { range: { offset: wantRange.offset, length: wantRange.length } });
    if (!object?.body) return noStoreResponse(404, { error: "Vault media not found." });
    // R2 sets `object.range` only when it actually served a partial read. The
    // self-host filesystem adapter ignores the range option and returns the full
    // body with no `range`, so fall back to a full 200 there (correct, just
    // unaccelerated) rather than mislabel a full body as 206.
    if (object.range) return partialMediaResponse(object, wantRange, totalSize);
    return mediaResponse(object);
  }

  const object = await bucket.get(key);
  if (!object?.body) return noStoreResponse(404, { error: "Vault media not found." });
  return mediaResponse(object);
}
