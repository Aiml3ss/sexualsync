// Private Vault endpoint.
//
// The API stores encrypted media bytes in R2 and encrypted text payloads in the
// app store. The passphrase-derived key stays in the browser; Pages Functions
// never receive plaintext video, titles, comments, or moment notes.

import {
  getAuthenticatedIdentity,
  jsonResponse,
  normalizeEmail
} from "./_auth.js";
import {
  authorizeWorkspaceAccess,
  workspaceIdFromPayload,
  workspaceIdFromRequest
} from "./_workspaces.js";
import { appendAudit } from "./_audit.js";
import { broadcastRoomEvent } from "./_live_room.js";
import {
  MAX_VAULT_COMMENTS,
  MAX_VAULT_ITEMS,
  MAX_VAULT_MOMENTS,
  VAULT_DEFAULT_DISPLAY_TITLE,
  VAULT_REACTION_CATALOG,
  cleanBase64,
  cleanText,
  deleteVaultItemMedia,
  encryptedBoxFromParts,
  isVaultReaction,
  mutateVault,
  normalizeVaultReaction,
  ownsVaultItem,
  publicVaultItem,
  readVault,
  vaultMediaKey
} from "./_vault.js";
import { cleanIdempotencyKey, idempotentId } from "./_idempotency.js";

const MAX_ENCRYPTED_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_ENCRYPTED_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_KDF_ITERATIONS = 210000;
const VIDEO_TYPES_BY_EXTENSION = {
  "3g2": "video/3gpp2",
  "3gp": "video/3gpp",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mp4: "video/mp4",
  qt: "video/quicktime",
  webm: "video/webm"
};

function mediaBucket(env) {
  const bucket = env?.VAULT_MEDIA;
  return bucket && typeof bucket.put === "function" ? bucket : null;
}

function mediaStorageUnavailable() {
  return jsonResponse(503, { error: "Vault media storage is not configured." });
}

function formValue(form, key, max = 160) {
  return cleanText(form.get(key), max);
}

function formBase64(form, key, max = 24000) {
  return cleanBase64(form.get(key), max);
}

function cleanCryptoVersion(value) {
  return cleanText(value, 20) === "v2" ? "v2" : "";
}

function formEncryptedBox(form, ciphertextKey, ivKey, maxCiphertext = 24000, versionKey = "") {
  if (!form.has(ciphertextKey) && !form.has(ivKey)) return null;
  const ciphertext = formBase64(form, ciphertextKey, maxCiphertext);
  const iv = formBase64(form, ivKey, 120);
  if (!ciphertext && !iv) return { ciphertext: "", iv: "" };
  if (!ciphertext || !iv) return null;
  return {
    ...(cleanCryptoVersion(versionKey ? form.get(versionKey) : "") ? { v: "v2" } : {}),
    ciphertext,
    iv
  };
}

function formNumber(form, key) {
  const number = Number(form.get(key) || 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function fileLike(value) {
  return value && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.size === "number";
}

function mediaTypeFromUpload(form) {
  const rawType = formValue(form, "mediaType", 80).toLowerCase();
  if (rawType.startsWith("video/")) return rawType;
  const originalName = formValue(form, "originalName", 180).toLowerCase();
  const extension = originalName.match(/\.([a-z0-9]+)$/)?.[1] || "";
  return VIDEO_TYPES_BY_EXTENSION[extension] || "";
}

function clampIterations(value) {
  const number = Number(value || DEFAULT_KDF_ITERATIONS);
  if (!Number.isFinite(number)) return DEFAULT_KDF_ITERATIONS;
  return Math.max(100000, Math.min(600000, Math.round(number)));
}

function actorNameFor(access, actorEmail) {
  return access.actorName
    || access.workspace?.members?.find((member) => normalizeEmail(member.email) === normalizeEmail(actorEmail))?.displayName
    || "Partner";
}

function canDeleteVaultMoment(item, moment, actorEmail) {
  const actor = normalizeEmail(actorEmail);
  return ownsVaultItem(item, actor) || normalizeEmail(moment?.createdByEmail) === actor;
}

function encryptedBoxFromPayload(payload, objectKey, ciphertextKey, ivKey, maxCiphertext = 24000) {
  const nested = payload?.[objectKey] && typeof payload[objectKey] === "object" ? payload[objectKey] : null;
  const hasNested = Boolean(nested);
  const hasFlat = Object.prototype.hasOwnProperty.call(payload || {}, ciphertextKey)
    || Object.prototype.hasOwnProperty.call(payload || {}, ivKey);
  if (!hasNested && !hasFlat) return null;
  const rawCiphertext = hasNested ? nested.ciphertext : payload[ciphertextKey];
  const rawIv = hasNested ? nested.iv : payload[ivKey];
  const rawVersion = hasNested ? nested.v : payload[`${objectKey}Version`];
  const ciphertext = cleanBase64(rawCiphertext, maxCiphertext);
  const iv = cleanBase64(rawIv, 120);
  if (!ciphertext && !iv) return { ciphertext: "", iv: "" };
  if (!ciphertext || !iv) return null;
  return {
    ...(cleanCryptoVersion(rawVersion) ? { v: "v2" } : {}),
    ciphertext,
    iv
  };
}

async function deleteMomentFrame(env, moment) {
  const bucket = env?.VAULT_MEDIA;
  const frameKey = cleanText(moment?.frameKey, 260);
  if (!frameKey || !bucket || typeof bucket.delete !== "function") return;
  await bucket.delete(frameKey).catch(() => {});
}

async function parsePayload(context, method) {
  if (method === "GET") return { kind: "query", payload: {} };
  const type = context.request.headers.get("content-type") || "";
  if (type.includes("multipart/form-data")) {
    try {
      return { kind: "form", payload: await context.request.formData() };
    } catch {
      return { error: jsonResponse(400, { error: "Invalid form upload." }) };
    }
  }
  try {
    return { kind: "json", payload: await context.request.json() };
  } catch {
    return { error: jsonResponse(400, { error: "Invalid JSON." }) };
  }
}

function workspaceIdFromAny(request, kind, payload) {
  if (kind === "form") return workspaceIdFromRequest(request) || cleanText(payload.get("workspaceId"), 64);
  return workspaceIdFromRequest(request) || workspaceIdFromPayload(payload);
}

async function handleUpload(context, access, actorEmail, actorName, form) {
  const bucket = mediaBucket(context.env);
  if (!bucket) return mediaStorageUnavailable();

  if (cleanText(form.get("consentConfirmed"), 20) !== "true") {
    return jsonResponse(400, { error: "Consent confirmation is required." });
  }

  const encryptedFile = form.get("file");
  if (!fileLike(encryptedFile)) return jsonResponse(400, { error: "Encrypted video file is required." });
  if (encryptedFile.size <= 0) return jsonResponse(400, { error: "Encrypted video file is empty." });
  if (encryptedFile.size > MAX_ENCRYPTED_VIDEO_BYTES) {
    return jsonResponse(413, { error: "Vault clips are capped at 100 MB for the MVP." });
  }

  const salt = formBase64(form, "salt", 120);
  const videoIv = formBase64(form, "videoIv", 120);
  if (!salt || !videoIv) return jsonResponse(400, { error: "Encryption metadata is required." });

  const title = encryptedBoxFromParts(form.get("titleCiphertext"), form.get("titleIv"), 4000, form.get("titleVersion")) || { ciphertext: "", iv: "" };
  // The plaintext clip title is locked to a generic placeholder server-side.
  // Any value sent in the `displayTitle` form field is ignored — the real
  // title is carried E2E-encrypted in `title` (decrypted client-side after
  // vault unlock).
  const displayTitle = VAULT_DEFAULT_DISPLAY_TITLE;
  const requestedItemId = formValue(form, "id", 120) || formValue(form, "itemId", 120);
  const itemId = requestedItemId || crypto.randomUUID();
  const mediaKey = vaultMediaKey(access.workspace.id, itemId, "video.enc");
  const now = new Date().toISOString();
  const mediaType = mediaTypeFromUpload(form);
  if (!mediaType) {
    return jsonResponse(400, { error: "Vault only accepts video uploads in the MVP." });
  }
  const originalSize = formNumber(form, "originalSize");
  const durationMs = formNumber(form, "durationMs");
  const iterations = clampIterations(form.get("iterations"));

  await bucket.put(mediaKey, encryptedFile, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: {
      workspaceId: access.workspace.id,
      itemId,
      encrypted: "true"
    }
  });

  const item = {
    id: itemId,
    workspaceId: access.workspace.id,
    mediaKey,
    mediaType,
    mediaSize: encryptedFile.size,
    originalSize,
    durationMs,
    addedByEmail: actorEmail,
    addedByName: actorName,
    addedAt: now,
    updatedAt: now,
    encryption: {
      version: cleanCryptoVersion(form.get("encryptionVersion")) || "v1",
      algorithm: "AES-GCM",
      kdf: "PBKDF2-SHA-256",
      iterations,
      salt,
      videoIv
    },
    displayTitle,
    title,
    reactions: {},
    comments: [],
    moments: []
  };
  let casResult;
  try {
    casResult = await mutateVault(context.env, access.workspace.id, (current) => ({
      value: [item, ...current]
    }));
  } catch (err) {
    // CAS exhausted — best-effort rollback so the encrypted blob doesn't become
    // an orphan in R2 occupying quota with no metadata pointing at it.
    await bucket.delete(mediaKey).catch(() => {});
    return jsonResponse(503, { error: "Vault is busy. Try again." });
  }
  const next = casResult.items;
  await appendAudit(context.env, access.workspace.id, {
    type: "vault_added",
    actorEmail,
    actorName,
    entityType: "vault",
    entityId: item.id,
    metadata: { mediaSize: encryptedFile.size }
  });
  broadcastRoomEvent(context, access.workspace.id, {
    resource: "vault",
    action: "added",
    entityId: item.id,
    actorEmail,
    actorName
  });
  return jsonResponse(200, { workspaceId: access.workspace.id, reactionCatalog: VAULT_REACTION_CATALOG, item: publicVaultItem(item), items: next.map(publicVaultItem) });
}

async function handleMoment(context, access, actorEmail, actorName, form) {
  const bucket = mediaBucket(context.env);
  if (!bucket) return mediaStorageUnavailable();

  const itemId = formValue(form, "id", 120) || formValue(form, "itemId", 120);
  const frame = form.get("frame");
  if (!itemId) return jsonResponse(400, { error: "id required." });
  if (!fileLike(frame)) return jsonResponse(400, { error: "Encrypted screenshot is required." });
  if (frame.size <= 0) return jsonResponse(400, { error: "Encrypted screenshot is empty." });
  if (frame.size > MAX_ENCRYPTED_FRAME_BYTES) {
    return jsonResponse(413, { error: "Moment screenshots are capped at 8 MB." });
  }
  const frameIv = formBase64(form, "frameIv", 120);
  if (!frameIv) return jsonResponse(400, { error: "Screenshot encryption metadata is required." });
  const title = formEncryptedBox(form, "titleCiphertext", "titleIv", 4000, "titleVersion") || { ciphertext: "", iv: "" };
  const note = encryptedBoxFromParts(form.get("noteCiphertext"), form.get("noteIv"), 12000, form.get("noteVersion")) || { ciphertext: "", iv: "" };

  const requestedMomentId = formValue(form, "momentId", 120);
  const momentId = requestedMomentId || crypto.randomUUID();
  const frameKey = vaultMediaKey(access.workspace.id, itemId, `moment-${momentId}.enc`);
  const timestampMs = formNumber(form, "timestampMs");
  await bucket.put(frameKey, frame, {
    httpMetadata: { contentType: "application/octet-stream" },
    customMetadata: {
      workspaceId: access.workspace.id,
      itemId,
      momentId,
      encrypted: "true"
    }
  });

  const now = new Date().toISOString();
  let casResult;
  try {
    casResult = await mutateVault(context.env, access.workspace.id, (current) => {
      const index = current.findIndex((entry) => entry.id === itemId);
      if (index < 0) return { error: { status: 404, message: "Vault item not found." } };
      const item = { ...current[index] };
      const moments = Array.isArray(item.moments) ? [...item.moments] : [];
      if (moments.length >= MAX_VAULT_MOMENTS) {
        return { error: { status: 400, message: "Moment limit reached for this clip." } };
      }
      item.moments = [{
        id: momentId,
        timestampMs,
        frameKey,
        frameVersion: cleanCryptoVersion(form.get("frameVersion")),
        frameIv,
        frameSize: frame.size,
        title,
        note,
        createdByEmail: actorEmail,
        createdByName: actorName,
        createdAt: now
      }, ...moments].slice(0, MAX_VAULT_MOMENTS);
      item.updatedAt = now;
      const next = current.map((entry, idx) => (idx === index ? item : entry));
      return { value: next, item };
    });
  } catch (err) {
    await bucket.delete(frameKey).catch(() => {});
    return jsonResponse(503, { error: "Vault is busy. Try again." });
  }
  if (casResult.error) {
    await bucket.delete(frameKey).catch(() => {});
    return jsonResponse(casResult.error.status, { error: casResult.error.message });
  }
  const item = casResult.items.find((entry) => entry.id === itemId) || casResult.item;
  const items = casResult.items;
  await appendAudit(context.env, access.workspace.id, {
    type: "vault_moment_added",
    actorEmail,
    actorName,
    entityType: "vault",
    entityId: item.id
  });
  broadcastRoomEvent(context, access.workspace.id, {
    resource: "vault",
    action: "moment",
    entityId: item.id,
    actorEmail,
    actorName
  });
  return jsonResponse(200, { workspaceId: access.workspace.id, reactionCatalog: VAULT_REACTION_CATALOG, item: publicVaultItem(item), items: items.map(publicVaultItem) });
}

async function handlePatch(context, access, actorEmail, actorName, payload) {
  const id = cleanText(payload.id || payload.itemId, 120);
  if (!id) return jsonResponse(400, { error: "id required." });
  const action = cleanText(payload.action, 40);
  const now = new Date().toISOString();
  const idempotencyKey = cleanIdempotencyKey(context.request.headers.get("idempotency-key"));

  if (action === "moment_title" || (payload.momentId && payload.title)) {
    const momentId = cleanText(payload.momentId, 120);
    if (!momentId) return jsonResponse(400, { error: "momentId required." });
    const title = encryptedBoxFromPayload(payload, "title", "titleCiphertext", "titleIv", 4000);
    if (!title) return jsonResponse(400, { error: "Encrypted moment title is required." });

    const casResult = await mutateVault(context.env, access.workspace.id, (current) => {
      const index = current.findIndex((entry) => entry.id === id);
      if (index < 0) return { error: { status: 404, message: "Vault item not found." } };
      const item = { ...current[index] };
      const moments = Array.isArray(item.moments) ? [...item.moments] : [];
      const momentIndex = moments.findIndex((entry) => cleanText(entry?.id, 120) === momentId);
      if (momentIndex < 0) return { error: { status: 404, message: "Vault moment not found." } };
      const moment = { ...moments[momentIndex] };
      if (!canDeleteVaultMoment(item, moment, actorEmail)) {
        return { error: { status: 403, message: "Only the moment creator or clip uploader can rename this moment." } };
      }
      moment.title = title;
      moments[momentIndex] = moment;
      item.moments = moments;
      item.updatedAt = now;
      const next = current.map((entry, idx) => (idx === index ? item : entry));
      return { value: next };
    });
    if (casResult.error) return jsonResponse(casResult.error.status, { error: casResult.error.message });
    const item = casResult.items.find((entry) => entry.id === id);
    await appendAudit(context.env, access.workspace.id, {
      type: "vault_moment_title_updated",
      actorEmail,
      actorName,
      entityType: "vault",
      entityId: item.id,
      metadata: { momentId }
    });
    broadcastRoomEvent(context, access.workspace.id, {
      resource: "vault",
      action: "moment_title_updated",
      entityId: item.id,
      actorEmail,
      actorName
    });
    return jsonResponse(200, { workspaceId: access.workspace.id, reactionCatalog: VAULT_REACTION_CATALOG, item: publicVaultItem(item), items: casResult.items.map(publicVaultItem) });
  }

  if (action === "title" || payload.title || Object.prototype.hasOwnProperty.call(payload, "displayTitle")) {
    const title = encryptedBoxFromPayload(payload, "title", "titleCiphertext", "titleIv", 4000);
    // displayTitle is server-controlled. Accepting a client-provided value
    // would re-leak the very plaintext we just locked down. The encrypted
    // `title` payload is the only renaming surface; the visible-before-unlock
    // placeholder is always VAULT_DEFAULT_DISPLAY_TITLE.
    if (!title) return jsonResponse(400, { error: "Encrypted title is required." });

    const casResult = await mutateVault(context.env, access.workspace.id, (current) => {
      const index = current.findIndex((entry) => entry.id === id);
      if (index < 0) return { error: { status: 404, message: "Vault item not found." } };
      const item = { ...current[index] };
      if (!ownsVaultItem(item, actorEmail)) {
        return { error: { status: 403, message: "Only the uploader can rename this clip." } };
      }
      item.title = title;
      item.displayTitle = VAULT_DEFAULT_DISPLAY_TITLE;
      item.updatedAt = now;
      const next = current.map((entry, idx) => (idx === index ? item : entry));
      return { value: next };
    });
    if (casResult.error) return jsonResponse(casResult.error.status, { error: casResult.error.message });
    const item = casResult.items.find((entry) => entry.id === id);
    await appendAudit(context.env, access.workspace.id, {
      type: "vault_title_updated",
      actorEmail,
      actorName,
      entityType: "vault",
      entityId: item.id
    });
    broadcastRoomEvent(context, access.workspace.id, {
      resource: "vault",
      action: "title_updated",
      entityId: item.id,
      actorEmail,
      actorName
    });
    return jsonResponse(200, { workspaceId: access.workspace.id, reactionCatalog: VAULT_REACTION_CATALOG, item: publicVaultItem(item), items: casResult.items.map(publicVaultItem) });
  }

  if (Object.prototype.hasOwnProperty.call(payload, "reaction") || action === "reaction") {
    let resolvedReaction = null;
    let clearReaction = false;
    if (payload.reaction === null || payload.reaction === "") {
      clearReaction = true;
    } else {
      if (!isVaultReaction(payload.reaction)) return jsonResponse(400, { error: "Unknown reaction." });
      resolvedReaction = normalizeVaultReaction(payload.reaction);
    }

    const casResult = await mutateVault(context.env, access.workspace.id, (current) => {
      const index = current.findIndex((entry) => entry.id === id);
      if (index < 0) return { error: { status: 404, message: "Vault item not found." } };
      const item = { ...current[index] };
      const reactions = { ...(item.reactions || {}) };
      if (clearReaction) delete reactions[actorEmail];
      else reactions[actorEmail] = resolvedReaction;
      item.reactions = reactions;
      item.updatedAt = now;
      const next = current.map((entry, idx) => (idx === index ? item : entry));
      return { value: next };
    });
    if (casResult.error) return jsonResponse(casResult.error.status, { error: casResult.error.message });
    const item = casResult.items.find((entry) => entry.id === id);
    await appendAudit(context.env, access.workspace.id, {
      type: "vault_reacted",
      actorEmail,
      actorName,
      entityType: "vault",
      entityId: item.id
    });
    broadcastRoomEvent(context, access.workspace.id, {
      resource: "vault",
      action: "reacted",
      entityId: item.id,
      actorEmail,
      actorName
    });
    return jsonResponse(200, { workspaceId: access.workspace.id, reactionCatalog: VAULT_REACTION_CATALOG, item: publicVaultItem(item), items: casResult.items.map(publicVaultItem) });
  }

  if (action === "comment" || payload.comment) {
    const commentBody = payload.comment && typeof payload.comment === "object"
      ? encryptedBoxFromParts(payload.comment.ciphertext, payload.comment.iv, 12000, payload.comment.v)
      : encryptedBoxFromParts(payload.commentCiphertext, payload.commentIv, 12000, payload.commentVersion);
    if (!commentBody) return jsonResponse(400, { error: "Encrypted comment is required." });
    const requestedCommentId = cleanText(payload.commentId || payload.comment?.id, 120);
    const commentId = requestedCommentId || (idempotencyKey
      ? await idempotentId({
          namespace: "vault:comment",
          key: idempotencyKey,
          prefix: "comment",
          workspaceId: access.workspace.id,
          actorEmail,
          entityId: id
        })
      : crypto.randomUUID());

    const casResult = await mutateVault(context.env, access.workspace.id, (current) => {
      const index = current.findIndex((entry) => entry.id === id);
      if (index < 0) return { error: { status: 404, message: "Vault item not found." } };
      const item = { ...current[index] };
      const comments = Array.isArray(item.comments) ? [...item.comments] : [];
      if (comments.some((comment) => comment.id === commentId)) {
        return { replayedComment: true };
      }
      if (comments.length >= MAX_VAULT_COMMENTS) {
        return { error: { status: 400, message: "Comment limit reached for this clip." } };
      }
      item.comments = [{
        id: commentId,
        email: actorEmail,
        name: actorName,
        body: commentBody,
        at: now
      }, ...comments].slice(0, MAX_VAULT_COMMENTS);
      item.updatedAt = now;
      const next = current.map((entry, idx) => (idx === index ? item : entry));
      return { value: next };
    });
    if (casResult.error) return jsonResponse(casResult.error.status, { error: casResult.error.message });
    const item = casResult.items.find((entry) => entry.id === id);
    if (!casResult.replayedComment) {
      await appendAudit(context.env, access.workspace.id, {
        type: "vault_commented",
        actorEmail,
        actorName,
        entityType: "vault",
        entityId: item.id
      });
      broadcastRoomEvent(context, access.workspace.id, {
        resource: "vault",
        action: "commented",
        entityId: item.id,
        actorEmail,
        actorName
      });
    }
    return jsonResponse(200, { workspaceId: access.workspace.id, reactionCatalog: VAULT_REACTION_CATALOG, item: publicVaultItem(item), items: casResult.items.map(publicVaultItem) });
  }

  return jsonResponse(400, { error: "Unsupported Vault action." });
}

async function handleDelete(context, access, actorEmail, actorName, payload) {
  const id = cleanText(payload.id || payload.itemId, 120);
  if (!id) return jsonResponse(400, { error: "id required." });
  const action = cleanText(payload.action, 40);
  const momentId = cleanText(payload.momentId, 120);

  if (action === "moment" || momentId) {
    if (!momentId) return jsonResponse(400, { error: "momentId required." });

    let removedMoment = null;
    const casResult = await mutateVault(context.env, access.workspace.id, (current) => {
      const index = current.findIndex((entry) => entry.id === id);
      if (index < 0) return { error: { status: 404, message: "Vault item not found." } };
      const item = { ...current[index] };
      const moments = Array.isArray(item.moments) ? item.moments : [];
      const moment = moments.find((entry) => cleanText(entry?.id, 120) === momentId);
      if (!moment) return { error: { status: 404, message: "Vault moment not found." } };
      if (!canDeleteVaultMoment(item, moment, actorEmail)) {
        return { error: { status: 403, message: "Only the moment creator or clip uploader can remove this moment." } };
      }
      removedMoment = moment;
      item.moments = moments.filter((entry) => cleanText(entry?.id, 120) !== momentId);
      item.updatedAt = new Date().toISOString();
      const next = current.map((entry, idx) => (idx === index ? item : entry));
      return { value: next };
    });
    if (casResult.error) return jsonResponse(casResult.error.status, { error: casResult.error.message });
    // Only delete the R2 frame after the CAS write has committed the removal —
    // otherwise a CAS retry would race a deleted-but-still-referenced object.
    if (removedMoment) await deleteMomentFrame(context.env, removedMoment);
    const item = casResult.items.find((entry) => entry.id === id);
    await appendAudit(context.env, access.workspace.id, {
      type: "vault_moment_deleted",
      actorEmail,
      actorName,
      entityType: "vault",
      entityId: item.id,
      metadata: { momentId }
    });
    broadcastRoomEvent(context, access.workspace.id, {
      resource: "vault",
      action: "moment_deleted",
      entityId: item.id,
      actorEmail,
      actorName
    });
    return jsonResponse(200, { workspaceId: access.workspace.id, reactionCatalog: VAULT_REACTION_CATALOG, item: publicVaultItem(item), items: casResult.items.map(publicVaultItem) });
  }

  let removedItem = null;
  const casResult = await mutateVault(context.env, access.workspace.id, (current) => {
    const index = current.findIndex((entry) => entry.id === id);
    if (index < 0) return { error: { status: 404, message: "Vault item not found." } };
    const item = current[index];
    if (!ownsVaultItem(item, actorEmail)) {
      return { error: { status: 403, message: "Only the uploader can remove this clip." } };
    }
    removedItem = item;
    return { value: current.filter((entry) => entry.id !== id) };
  });
  if (casResult.error) return jsonResponse(casResult.error.status, { error: casResult.error.message });
  if (removedItem) await deleteVaultItemMedia(context.env, removedItem);
  await appendAudit(context.env, access.workspace.id, {
    type: "vault_deleted",
    actorEmail,
    actorName,
    entityType: "vault",
    entityId: removedItem.id
  });
  broadcastRoomEvent(context, access.workspace.id, {
    resource: "vault",
    action: "deleted",
    entityId: removedItem.id,
    actorEmail,
    actorName
  });
  return jsonResponse(200, { workspaceId: access.workspace.id, reactionCatalog: VAULT_REACTION_CATALOG, items: casResult.items.map(publicVaultItem) });
}

export async function onRequest(context) {
  const identity = await getAuthenticatedIdentity(context);
  if (!identity.ok) return identity.response;

  const method = context.request.method.toUpperCase();
  const parsed = await parsePayload(context, method);
  if (parsed.error) return parsed.error;

  const workspaceId = workspaceIdFromAny(context.request, parsed.kind, parsed.payload);
  const access = await authorizeWorkspaceAccess(context, identity, workspaceId);
  if (!access.ok) return access.response;
  const actorEmail = normalizeEmail(identity.email);
  const actorName = actorNameFor(access, actorEmail);

  if (method === "GET") {
    const items = await readVault(context.env, access.workspace.id);
    return jsonResponse(200, {
      workspaceId: access.workspace.id,
      reactionCatalog: VAULT_REACTION_CATALOG,
      items: items.map(publicVaultItem)
    });
  }

  if (method === "POST" && parsed.kind === "form") {
    const action = formValue(parsed.payload, "action", 40) || "upload";
    if (action === "moment") return handleMoment(context, access, actorEmail, actorName, parsed.payload);
    return handleUpload(context, access, actorEmail, actorName, parsed.payload);
  }

  if (method === "PATCH" && parsed.kind === "json") {
    return handlePatch(context, access, actorEmail, actorName, parsed.payload);
  }

  if (method === "DELETE" && parsed.kind === "json") {
    return handleDelete(context, access, actorEmail, actorName, parsed.payload);
  }

  return jsonResponse(405, { error: "Method not allowed." });
}
