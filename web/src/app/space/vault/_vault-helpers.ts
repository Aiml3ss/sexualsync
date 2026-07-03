/**
 * Pure utility helpers for the Vault route. Co-located with page.tsx and
 * the split-out _VaultComposer / _VaultCard / _VaultClipLightbox files so
 * they're easy to find when working on Vault, but kept out of those
 * component files so each one stays focused on rendering.
 *
 * Nothing in here touches React state. Anything stateful (decryption with
 * a CryptoKey, blob URL lifecycle, etc.) stays in the components.
 */

import type { ShelfReactionOption } from "@/lib/types";
import { decryptFromString, encryptToString } from "@/lib/device-cipher";

export const VAULT_IOS_FILE_UNREADABLE_MESSAGE =
  "iOS could not share that video with the app. Download it from iCloud or export it to Files, then try again.";

export const VAULT_VIDEO_TYPES_BY_EXTENSION: Record<string, string> = {
  "3g2": "video/3gpp2",
  "3gp": "video/3gpp",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mp4: "video/mp4",
  qt: "video/quicktime",
  webm: "video/webm",
};

export function relativeAge(value: string) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "recently";
  const diff = Date.now() - time;
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function sizeLabel(bytes: number) {
  if (!bytes) return "encrypted";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

export async function vaultMediaTypeForFile(file: File) {
  return vaultMediaTypeFromMetadata(file) || await sniffVaultMediaType(file);
}

function vaultMediaTypeFromMetadata(file: File) {
  const mimeType = file.type.trim().toLowerCase();
  if (mimeType.startsWith("video/")) return mimeType;
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  return VAULT_VIDEO_TYPES_BY_EXTENSION[extension] || "";
}

async function sniffVaultMediaType(file: File) {
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "video/webm";
  }
  if (bytes.length >= 12 && asciiFromBytes(bytes, 4, 8) === "ftyp") {
    const brands = asciiFromBytes(bytes, 8, Math.min(bytes.length, 32));
    if (brands.includes("qt  ")) return "video/quicktime";
    if (brands.includes("3g")) return "video/3gpp";
    return "video/mp4";
  }
  return "";
}

function asciiFromBytes(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.slice(start, end));
}

function vaultTitleCacheKey(workspaceId: string, itemId: string) {
  return `ss:vault:title:${workspaceId}:${itemId}`;
}

// The decrypted Vault title is sensitive (user-chosen label for a private
// clip). It's encrypted at rest with the device key now, so read/write are
// async. Legacy plaintext titles decrypt straight through and upgrade to
// ciphertext on the next write (see device-cipher.ts).
export async function readVaultTitleCache(workspaceId: string, itemId: string): Promise<string> {
  if (typeof window === "undefined") return "";
  try {
    return await decryptFromString(window.localStorage.getItem(vaultTitleCacheKey(workspaceId, itemId)));
  } catch {
    return "";
  }
}

export async function rememberVaultTitle(workspaceId: string, itemId: string, title: string): Promise<void> {
  if (typeof window === "undefined") return;
  const key = vaultTitleCacheKey(workspaceId, itemId);
  const cleanTitle = title.trim();
  try {
    if (cleanTitle) window.localStorage.setItem(key, await encryptToString(cleanTitle));
    else window.localStorage.removeItem(key);
  } catch {}
}

export function vaultUploadErrorMessage(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (
    ["AbortError", "NotFoundError", "NotReadableError", "SecurityError"].includes(name)
    || /could not be read|not readable|permission|security|denied|not found/i.test(message)
  ) {
    return VAULT_IOS_FILE_UNREADABLE_MESSAGE;
  }
  return message || "Couldn't save this clip.";
}

export function readVideoDurationMs(file: File) {
  return new Promise<number>((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    let timeout = 0;
    const finish = (duration: number) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      URL.revokeObjectURL(url);
      resolve(duration);
    };
    timeout = window.setTimeout(() => finish(0), 2500);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
      finish(duration);
    };
    video.onerror = () => {
      finish(0);
    };
    video.src = url;
  });
}

export async function frameFromVideo(video: HTMLVideoElement) {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Couldn't capture this frame.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) => {
    // JPEG, not PNG: a 1080p video frame is ~1.5-4 MB as PNG (where the
    // quality arg is silently ignored) vs ~150-400 KB as JPEG q0.92 — a
    // 5-10× saving on upload, storage, and every re-download. Frames
    // captured before this change are still PNG; the decrypt path sniffs
    // the magic bytes so both render with an accurate type.
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Couldn't capture this frame."));
    }, "image/jpeg", 0.92);
  });
}

export function reactionCaption(option: ShelfReactionOption, name: string) {
  const displayName = String(name || "You").trim().split(/\s+/)[0] || "You";
  if (displayName.toLowerCase() === "you") {
    return option.caption
      .replace(/\{name\} says/g, "You say")
      .replace(/\{name\} is/g, "You are")
      .replace(/\{name\} wants/g, "You want")
      .replace(/Not \{name\}'s vibe/g, "Not your vibe");
  }
  return option.caption.replace(/\{name\}/g, displayName);
}
