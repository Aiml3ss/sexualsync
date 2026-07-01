import { normalizeEmail } from "./_auth.js";

const textEncoder = new TextEncoder();

export function cleanIdempotencyKey(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._:-]/g, "")
    .slice(0, 128);
}

function base64Url(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function idempotentId({ namespace, key, prefix, workspaceId, actorEmail, entityId = "" }) {
  const cleanedKey = cleanIdempotencyKey(key);
  if (!cleanedKey) return "";
  const material = [
    namespace,
    workspaceId || "",
    normalizeEmail(actorEmail),
    entityId || "",
    cleanedKey
  ].join("\0");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(material)));
  return `${prefix}_${base64Url(digest).slice(0, 32)}`;
}
