"use client";

/**
 * Downscale + re-encode a user-picked image before it is encrypted and
 * uploaded. One transform buys three things:
 *
 *  1. PRIVACY — the canvas re-encode drops ALL container metadata, including
 *     EXIF GPS. Phone photos otherwise carry the couple's home coordinates
 *     into R2 (with Room Encryption off, the inline message key makes those
 *     bytes decryptable to a KV+R2 dump adversary) and to the partner's
 *     downloaded copy.
 *  2. BANDWIDTH — a 12 MP camera JPEG is ~10-20× more bytes than the ~320 px
 *     bubble it renders in. Both partners pay the full size, both directions.
 *  3. ORIENTATION — createImageBitmap applies the EXIF orientation flag, so
 *     the pixels land upright even though the metadata that said so is gone.
 *
 * Fallback honesty: when decode fails (exotic format the canvas can't read)
 * we send the ORIGINAL file rather than lose the message — that path keeps
 * its EXIF. Videos are out of scope here (vault clips upload as-is; a MOV/MP4
 * location-atom strip is a separate, format-parsing job).
 */

const MAX_EDGE_PX = 1600;
const JPEG_QUALITY = 0.85;

export async function normalizeImageForUpload(
  file: File | Blob,
  maxEdge = MAX_EDGE_PX,
  quality = JPEG_QUALITY,
): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) return file;
      context.drawImage(bitmap, 0, 0, width, height);
      const encoded = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", quality);
      });
      return encoded && encoded.size > 0 ? encoded : file;
    } finally {
      bitmap.close();
    }
  } catch {
    // Undecodable input: send the original rather than losing the message.
    return file;
  }
}
