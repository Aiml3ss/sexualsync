import { getAuthenticatedIdentity, jsonResponse } from "./_auth.js";
import { authorizeWorkspaceAccess, workspaceIdFromRequest } from "./_workspaces.js";
import { cleanText, safeKeySegment } from "./_vault.js";

// Encrypted-blob store for Sext image messages. The bytes are already AES-GCM
// ciphertext (the client holds the key); we only ever hold opaque ciphertext in
// R2, never plaintext. Shared handler: touches only the env.VAULT_MEDIA seam, so
// it runs on both the Cloudflare and self-host runtimes.
//
// The object key is derived server-side from the authorized workspace id + a
// random id — the client can't fetch another room's media by guessing a key.

const MAX_CHAT_MEDIA_BYTES = 12 * 1024 * 1024;

function mediaBucket(env) {
  const bucket = env?.VAULT_MEDIA;
  return bucket && typeof bucket.get === "function" ? bucket : null;
}

export function chatMediaKey(workspaceId, id) {
  return `chat-media/${safeKeySegment(workspaceId)}/${safeKeySegment(id)}.enc`;
}

export async function onRequest(context) {
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;

  const bucket = mediaBucket(context.env);
  if (!bucket) return jsonResponse(503, { error: "Media storage is not configured." });

  const method = context.request.method.toUpperCase();
  const url = new URL(context.request.url);
  const access = await authorizeWorkspaceAccess(context, identity, workspaceIdFromRequest(context.request));
  if (!access.ok) return access.response;

  if (method === "POST") {
    // Reject by declared length BEFORE buffering: on the self-host runtime
    // there is no platform body cap upstream, so `arrayBuffer()` on an
    // oversized POST would buffer the whole thing in Node heap just to
    // refuse it. content-length can lie, so the post-read check stays.
    const declaredBytes = Number(context.request.headers.get("content-length") || 0);
    if (declaredBytes > MAX_CHAT_MEDIA_BYTES) {
      return jsonResponse(413, { error: "Image is too large (max 12 MB)." });
    }
    const body = await context.request.arrayBuffer();
    if (!body || body.byteLength === 0) return jsonResponse(400, { error: "Empty media body." });
    if (body.byteLength > MAX_CHAT_MEDIA_BYTES) return jsonResponse(413, { error: "Image is too large (max 12 MB)." });
    const id = crypto.randomUUID();
    await bucket.put(chatMediaKey(access.workspace.id, id), body, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    return jsonResponse(201, { mediaId: id });
  }

  if (method === "GET") {
    const id = cleanText(url.searchParams.get("id"), 120);
    if (!id) return jsonResponse(400, { error: "id required." });
    const object = await bucket.get(chatMediaKey(access.workspace.id, id));
    if (!object?.body) return jsonResponse(404, { error: "Media not found." });
    const headers = {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };
    // Download progress + a sane client abort point; mirrors vault-media.
    if (Number.isFinite(object.size) && object.size > 0) {
      headers["content-length"] = String(object.size);
    }
    return new Response(object.body, { status: 200, headers });
  }

  return jsonResponse(405, { error: "Method not allowed." });
}
