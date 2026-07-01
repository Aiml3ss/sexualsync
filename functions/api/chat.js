import { getStore } from "./_kv.js";
import { mutateKey } from "./_state.js";
import {
  getAuthenticatedIdentity,
  jsonResponse,
  normalizeEmail
} from "./_auth.js";
import {
  authorizeWorkspaceAccess,
  cleanText,
  workspaceIdFromPayload,
  workspaceIdFromRequest
} from "./_workspaces.js";
import { cleanRoomEncryptedBox } from "./_e2ee.js";
import { checkRateLimit, rateLimitResponse } from "./_rate_limit.js";
import { broadcastRoomSignal } from "./_live_room.js";
import { notifyWorkspaceEvent } from "./_notification_policy.js";
import { cleanIdempotencyKey, idempotentId } from "./_idempotency.js";
import { chatMediaKey } from "./chat-media.js";

// Direct messages between the two partners in a room — the in-app sexting
// surface. This is a SHARED handler: it runs on both the Cloudflare and the
// self-host runtimes because it only touches Web-standard globals and the
// storage / realtime seams (getStore, mutateKey, broadcastRoomSignal), never a
// Cloudflare binding directly.
//
// Storage model: one CAS-guarded record per workspace under `thread:{id}`,
// holding a monotonic `seq`, a capped ring buffer of the most recent messages,
// and a per-member read cursor. A single record keeps every mutation
// (send / edit / unsend / react / read) atomic under mutateKey, and the cap
// bounds the rewritten value size. The write COUNT is still one-per-message —
// acceptable for a private two-person room, and routed to the database backend
// (write-friendly) when DATA_BACKEND is set. See docs/self-host/GOING-PUBLIC.md
// before scaling this to many rooms on raw KV.
const STORE_NAME = "sexualsync-chat";
const MAX_MESSAGES = 2000;
const MAX_TEXT_LENGTH = 4000;
const MAX_EMOJI_LENGTH = 16;
const MAX_REACTIONS_PER_MESSAGE = 50;
const ROOM_ENCRYPTED_LIMIT = 24000;

function chatStore(env) {
  return getStore(env, STORE_NAME);
}

function threadKey(workspaceId) {
  return `thread:${workspaceId}`;
}

function cleanMessageText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim().slice(0, MAX_TEXT_LENGTH);
}

function cleanEmoji(value) {
  return String(value || "").replace(/\s+/g, "").trim().slice(0, MAX_EMOJI_LENGTH);
}

const MAX_CHAT_MEDIA_BYTES = 12 * 1024 * 1024;
const CHAT_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function cleanB64(value, max) {
  const s = String(value || "").trim();
  return s && s.length <= max && /^[A-Za-z0-9+/=_-]+$/.test(s) ? s : "";
}

// An image attachment: a pointer to the ciphertext in R2 (mediaId) plus its
// declared type/size. key/iv are present only when Room Encryption is off; when
// it's on they live inside encryptedText and never reach the server.
function cleanChatMedia(value) {
  if (!value || typeof value !== "object") return null;
  const mediaId = cleanText(value.mediaId, 120);
  const mediaType = cleanText(value.mediaType, 40).toLowerCase();
  const mediaSize = Number(value.mediaSize) || 0;
  if (!mediaId || !CHAT_MEDIA_TYPES.has(mediaType)) return null;
  if (mediaSize <= 0 || mediaSize > MAX_CHAT_MEDIA_BYTES) return null;
  const media = { mediaId, mediaType, mediaSize };
  const key = cleanB64(value.key, 80);
  const iv = cleanB64(value.iv, 64);
  if (key) media.key = key;
  if (iv) media.iv = iv;
  return media;
}

function emptyThread() {
  return { seq: 0, messages: [], readCursors: {}, readAt: {} };
}

function normalizeThread(raw) {
  if (!raw || typeof raw !== "object") return emptyThread();
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const readCursors = raw.readCursors && typeof raw.readCursors === "object" && !Array.isArray(raw.readCursors)
    ? raw.readCursors
    : {};
  // When each member last advanced their read cursor — lets the sender show
  // "Seen 9:42 PM" instead of a bare "Seen". A plain {email: ISO} map.
  const readAt = raw.readAt && typeof raw.readAt === "object" && !Array.isArray(raw.readAt)
    ? raw.readAt
    : {};
  const seq = Number.isFinite(raw.seq) ? raw.seq : messages.reduce((max, m) => Math.max(max, Number(m?.seq) || 0), 0);
  return { seq, messages, readCursors, readAt };
}

function cleanReactions(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    const by = normalizeEmail(entry?.by);
    const emoji = cleanEmoji(entry?.emoji);
    if (!by || !emoji) continue;
    const dedupeKey = `${by}|${emoji}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ by, emoji });
    if (out.length >= MAX_REACTIONS_PER_MESSAGE) break;
  }
  return out;
}

function publicMessage(message) {
  const encryptedText = cleanRoomEncryptedBox(message?.encryptedText, ROOM_ENCRYPTED_LIMIT);
  const out = {
    id: cleanText(message?.id, 64),
    seq: Number(message?.seq) || 0,
    email: normalizeEmail(message?.email),
    name: cleanText(message?.name, 80),
    text: message?.deletedAt ? "" : (encryptedText ? "" : cleanMessageText(message?.text)),
    at: message?.at || new Date().toISOString(),
    reactions: cleanReactions(message?.reactions)
  };
  if (encryptedText && !message?.deletedAt) out.encryptedText = encryptedText;
  if (message?.replyToId) out.replyToId = cleanText(message.replyToId, 64);
  if (message?.editedAt) out.editedAt = message.editedAt;
  if (message?.deletedAt) out.deletedAt = message.deletedAt;
  const media = message?.deletedAt ? null : cleanChatMedia(message?.media);
  if (media) out.media = media;
  return out;
}

function publicThread(thread, { after } = {}) {
  const normalized = normalizeThread(thread);
  let messages = normalized.messages;
  if (Number.isFinite(after)) {
    messages = messages.filter((message) => (Number(message?.seq) || 0) > after);
  }
  return {
    seq: normalized.seq,
    readCursors: normalized.readCursors,
    readAt: normalized.readAt,
    messages: messages.map(publicMessage)
  };
}

function partnerEmailsFor(workspace, actorEmail) {
  const actor = normalizeEmail(actorEmail);
  return (Array.isArray(workspace?.members) ? workspace.members : [])
    .filter((member) => member?.status === "active" && normalizeEmail(member?.email) && normalizeEmail(member.email) !== actor)
    .map((member) => normalizeEmail(member.email));
}

function roomE2eeRequired(workspace) {
  return Boolean(workspace?.settings?.roomE2eeEnabled);
}

export async function onRequest(context) {
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;

  const env = context.env;
  const request = context.request;
  const method = request.method.toUpperCase();
  const queryWorkspace = workspaceIdFromRequest(request);

  if (method === "GET") {
    const access = await authorizeWorkspaceAccess(context, identity, queryWorkspace);
    if (!access.ok) return access.response;
    const url = new URL(request.url);
    const afterRaw = Number(url.searchParams.get("after"));
    const after = Number.isFinite(afterRaw) ? afterRaw : undefined;
    const thread = await chatStore(env).get(threadKey(access.workspace.id), { type: "json" });
    return jsonResponse(200, {
      workspaceId: access.workspace.id,
      ...publicThread(thread, { after })
    });
  }

  if (!["POST", "PATCH", "DELETE"].includes(method)) {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  let payload = {};
  try { payload = await request.json(); }
  catch { return jsonResponse(400, { error: "Expected JSON body" }); }

  const access = await authorizeWorkspaceAccess(context, identity, workspaceIdFromPayload(payload, queryWorkspace));
  if (!access.ok) return access.response;

  const workspace = access.workspace;
  const actorEmail = identity.email;
  const actorName = access.actorName;
  const now = new Date().toISOString();
  const action = cleanText(payload.action, 40);

  const limited = await checkRateLimit(env, {
    bucket: `chat-${method}`,
    key: `${actorEmail}:${workspace.id}`,
    limit: 240,
    windowSeconds: 5 * 60
  });
  if (!limited.ok) return rateLimitResponse(limited.retryAfter);

  // Typing is purely ephemeral: never persisted, just fanned out to the live
  // socket so the partner sees the indicator. No store write, no notification.
  if (method === "PATCH" && action === "typing") {
    broadcastRoomSignal(context, workspace.id, {
      resource: "chat",
      action: "typing",
      actorEmail,
      actorName,
      passive: true,
      dedupe: "keep-first"
    });
    return jsonResponse(200, { ok: true, workspaceId: workspace.id });
  }

  // Read receipt: advance this member's read cursor to the given seq.
  if (method === "PATCH" && action === "read") {
    const upTo = Number(payload.seq);
    if (!Number.isFinite(upTo) || upTo < 0) return jsonResponse(400, { error: "A read cursor seq is required." });
    const result = await mutateKey(env, STORE_NAME, threadKey(workspace.id), (current) => {
      const thread = normalizeThread(current);
      // Clamp to the real thread seq: never trust a client cursor past what
      // actually exists, or the sender would see unsent/future messages "Seen".
      const capped = Math.min(upTo, thread.seq);
      const prior = Number(thread.readCursors[actorEmail]) || 0;
      if (capped <= prior) return { write: false, result: { thread, changed: false } };
      const next = {
        ...thread,
        readCursors: { ...thread.readCursors, [actorEmail]: capped },
        readAt: { ...thread.readAt, [actorEmail]: new Date().toISOString() },
      };
      return { value: next, result: { thread: next, changed: true, capped } };
    });
    if (result.changed) {
      broadcastRoomSignal(context, workspace.id, {
        resource: "chat",
        action: "read",
        actorEmail,
        actorName,
        entityId: String(result.capped),
        passive: true,
        dedupe: "keep-first"
      });
    }
    return jsonResponse(200, { ok: true, workspaceId: workspace.id, readCursors: result.thread.readCursors, readAt: result.thread.readAt });
  }

  if (method === "POST") {
    const encryptedText = cleanRoomEncryptedBox(payload.encryptedText, ROOM_ENCRYPTED_LIMIT);
    if (roomE2eeRequired(workspace) && !encryptedText) {
      return jsonResponse(400, { error: "Room Encryption requires encrypted messages." });
    }
    const text = encryptedText ? "" : cleanMessageText(payload.text);
    const media = cleanChatMedia(payload.media);
    if (!text && !encryptedText && !media) return jsonResponse(400, { error: "Message text or image is required" });
    const replyToId = cleanText(payload.replyToId, 64);

    const idempotencyKey = cleanIdempotencyKey(request.headers.get("idempotency-key"));
    const messageId = idempotencyKey
      ? await idempotentId({
          namespace: "chat:message",
          key: idempotencyKey,
          prefix: "msg",
          workspaceId: workspace.id,
          actorEmail
        })
      : crypto.randomUUID();

    const result = await mutateKey(env, STORE_NAME, threadKey(workspace.id), (current) => {
      const thread = normalizeThread(current);
      const existing = thread.messages.find((message) => message.id === messageId);
      if (existing) {
        // Idempotent replay of a retried send — return the stored copy, no write.
        return { write: false, result: { message: existing, replay: true } };
      }
      const seq = thread.seq + 1;
      const message = {
        id: messageId,
        seq,
        email: actorEmail,
        name: actorName,
        text,
        at: now,
        reactions: [],
        ...(encryptedText ? { encryptedText } : {}),
        ...(replyToId ? { replyToId } : {}),
        ...(media ? { media } : {})
      };
      const messages = [...thread.messages, message].slice(-MAX_MESSAGES);
      const next = { ...thread, seq, messages };
      return { value: next, result: { message, replay: false } };
    });

    const message = result.message;
    if (!result.replay) {
      broadcastRoomSignal(context, workspace.id, {
        resource: "chat",
        action: "message",
        entityId: message.id,
        actorEmail,
        actorName
      });
      const recipients = partnerEmailsFor(workspace, actorEmail);
      if (recipients.length) {
        notifyWorkspaceEvent(context, workspace.id, actorEmail, {
          title: "Sexualsync",
          body: "New message in your room.",
          tag: "chat-message",
          url: "/chat",
          onlyEmail: recipients[0]
        }).catch(() => {});
      }
    }
    return jsonResponse(result.replay ? 200 : 201, {
      workspaceId: workspace.id,
      message: publicMessage(message),
      idempotent: result.replay
    });
  }

  const id = cleanText(payload.id, 64);
  if (!id) return jsonResponse(400, { error: "Message id is required" });

  if (method === "PATCH" && action === "react") {
    const emoji = cleanEmoji(payload.emoji);
    if (!emoji) return jsonResponse(400, { error: "A reaction is required." });
    const result = await mutateKey(env, STORE_NAME, threadKey(workspace.id), (current) => {
      const thread = normalizeThread(current);
      const index = thread.messages.findIndex((message) => message.id === id);
      if (index === -1) return { write: false, result: { found: false } };
      const target = thread.messages[index];
      const reactions = cleanReactions(target.reactions);
      const mineIndex = reactions.findIndex((reaction) => reaction.by === actorEmail && reaction.emoji === emoji);
      // Toggle: a repeat of the same emoji by the same person removes it.
      const nextReactions = mineIndex === -1
        ? [...reactions, { by: actorEmail, emoji }].slice(0, MAX_REACTIONS_PER_MESSAGE)
        : reactions.filter((_, i) => i !== mineIndex);
      const updated = { ...target, reactions: nextReactions };
      const messages = thread.messages.map((message, i) => (i === index ? updated : message));
      return { value: { ...thread, messages }, result: { found: true, message: updated } };
    });
    if (!result.found) return jsonResponse(404, { error: "Message not found" });
    broadcastRoomSignal(context, workspace.id, {
      resource: "chat",
      action: "reaction",
      entityId: id,
      actorEmail,
      actorName,
      passive: true
    });
    return jsonResponse(200, { workspaceId: workspace.id, message: publicMessage(result.message) });
  }

  if (method === "PATCH") {
    // Edit: only the author, and only a not-yet-unsent message.
    const encryptedText = cleanRoomEncryptedBox(payload.encryptedText, ROOM_ENCRYPTED_LIMIT);
    if (roomE2eeRequired(workspace) && !encryptedText) {
      return jsonResponse(400, { error: "Room Encryption requires encrypted messages." });
    }
    const text = encryptedText ? "" : cleanMessageText(payload.text);
    if (!text && !encryptedText) return jsonResponse(400, { error: "Message text is required" });
    const result = await mutateKey(env, STORE_NAME, threadKey(workspace.id), (current) => {
      const thread = normalizeThread(current);
      const index = thread.messages.findIndex((message) => message.id === id);
      if (index === -1) return { write: false, result: { found: false } };
      const target = thread.messages[index];
      if (normalizeEmail(target.email) !== actorEmail) return { write: false, result: { found: true, forbidden: true } };
      if (target.deletedAt) return { write: false, result: { found: true, deleted: true } };
      const updated = {
        ...target,
        text,
        editedAt: now,
        ...(encryptedText ? { encryptedText } : {})
      };
      if (!encryptedText) delete updated.encryptedText;
      const messages = thread.messages.map((message, i) => (i === index ? updated : message));
      return { value: { ...thread, messages }, result: { found: true, message: updated } };
    });
    if (!result.found) return jsonResponse(404, { error: "Message not found" });
    if (result.forbidden) return jsonResponse(403, { error: "Only the author can edit this message." });
    if (result.deleted) return jsonResponse(409, { error: "This message was unsent." });
    // "update", not "message": an edit must not register as a new unread.
    broadcastRoomSignal(context, workspace.id, {
      resource: "chat",
      action: "update",
      entityId: id,
      actorEmail,
      actorName,
      passive: true
    });
    return jsonResponse(200, { workspaceId: workspace.id, message: publicMessage(result.message) });
  }

  // DELETE — unsend: only the author. Keeps a tombstone so ordering/replies hold,
  // but strips the text and any encrypted body.
  const result = await mutateKey(env, STORE_NAME, threadKey(workspace.id), (current) => {
    const thread = normalizeThread(current);
    const index = thread.messages.findIndex((message) => message.id === id);
    if (index === -1) return { write: false, result: { found: false } };
    const target = thread.messages[index];
    if (normalizeEmail(target.email) !== actorEmail) return { write: false, result: { found: true, forbidden: true } };
    // Carry the image reference out so we can destroy the R2 blob after commit,
    // then strip the whole media object from the tombstone — this removes the
    // inline AES key (E2EE-off case) so the record retains nothing decryptable.
    const removedMedia = target.media || null;
    const updated = { ...target, text: "", deletedAt: now, reactions: [] };
    delete updated.encryptedText;
    delete updated.media;
    const messages = thread.messages.map((message, i) => (i === index ? updated : message));
    return { value: { ...thread, messages }, result: { found: true, message: updated, removedMedia } };
  });
  if (!result.found) return jsonResponse(404, { error: "Message not found" });
  if (result.forbidden) return jsonResponse(403, { error: "Only the author can unsend this message." });
  // Destroy the encrypted image blob in R2 so an unsent image is actually
  // unrecoverable. Without this the ciphertext (and, with Room Encryption off,
  // the key just stripped above) would persist forever — the privacy failure
  // M2 flagged. Mirrors the Vault, which deletes its R2 media on delete.
  // Best-effort and post-commit: a failure here can't leave a half-unsent message.
  if (result.removedMedia && result.removedMedia.mediaId) {
    const bucket = env.VAULT_MEDIA;
    if (bucket && typeof bucket.delete === "function") {
      try { await bucket.delete(chatMediaKey(workspace.id, result.removedMedia.mediaId)); }
      catch { /* best-effort; an orphan sweep can reclaim it later */ }
    }
  }
  // "delete", not "message": an unsend must not register as a new unread.
  broadcastRoomSignal(context, workspace.id, {
    resource: "chat",
    action: "delete",
    entityId: id,
    actorEmail,
    actorName,
    passive: true
  });
  return jsonResponse(200, { workspaceId: workspace.id, message: publicMessage(result.message) });
}
