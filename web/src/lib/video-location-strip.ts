"use client";

/**
 * Blank GPS location metadata inside MP4/QuickTime containers before a vault
 * clip is encrypted and uploaded. iPhone videos carry the recording location
 * twice inside the `moov` box:
 *
 *   - `moov/udta/©xyz` (classic QuickTime: "+37.3349-122.0090/") — also the
 *     shape Android MP4s use when they geotag at all;
 *   - `moov/meta/keys` + `ilst` items named
 *     `com.apple.quicktime.location.ISO6709` (and `.location.accuracy.*`).
 *
 * Strategy: SAME-SIZE IN-PLACE BLANKING. Matched value bytes are overwritten
 * with spaces; no box is resized, added, or removed, so every chunk offset
 * (`stco`/`co64`) stays valid — the patched file is byte-identical outside
 * the blanked spans and plays everywhere the original did. The result Blob
 * splices [before-moov, patched-moov, after-moov] without buffering `mdat`.
 *
 * FAIL-SAFE: any parse anomaly (unknown structure, truncated box, oversized
 * moov) returns the ORIGINAL file untouched — the status quo (GPS retained)
 * over any risk of corrupting the couple's clip. A structural re-walk of the
 * patched moov must also succeed before the patch is accepted.
 *
 * Out of scope: WebM/Matroska (different container, geotags are practically
 * absent) and full metadata scrubbing (creation dates, device model stay —
 * only location is the severe leak for this app).
 */

// moov for a phone clip is typically well under a few MB (it's index + meta,
// not media). Refuse to buffer anything absurd.
const MAX_MOOV_BYTES = 32 * 1024 * 1024;
// Box types we recurse into when hunting location atoms.
const CONTAINER_TYPES = new Set(["moov", "trak", "udta", "meta", "ilst"]);
const SPACE = 0x20;

export interface VideoLocationStripResult {
  blob: Blob;
  /** True when at least one location atom was found and blanked. */
  stripped: boolean;
}

function boxType(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

// `©xyz` — 0xA9 is not ASCII, so compare bytes, not the string.
function isCopyrightXyz(view: DataView, offset: number): boolean {
  return view.getUint8(offset) === 0xa9
    && view.getUint8(offset + 1) === 0x78
    && view.getUint8(offset + 2) === 0x79
    && view.getUint8(offset + 3) === 0x7a;
}

interface BoxHeader {
  start: number;      // absolute offset of the box in its buffer
  headerSize: number; // 8 or 16
  size: number;       // full box size incl. header
  type: string;
  isXyz: boolean;
}

/** Parse one box header at `offset` inside [offset, end). Null on anomaly. */
function readBoxHeader(view: DataView, offset: number, end: number): BoxHeader | null {
  if (offset + 8 > end) return null;
  let size = view.getUint32(offset);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > end) return null;
    const large = view.getBigUint64(offset + 8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(large);
    headerSize = 16;
  } else if (size === 0) {
    // "to end of enclosing container"
    size = end - offset;
  }
  if (size < headerSize || offset + size > end) return null;
  return { start: offset, headerSize, size, type: boxType(view, offset + 4), isXyz: isCopyrightXyz(view, offset + 4) };
}

/**
 * `meta` is a fullbox (4-byte version/flags before children) in ISO files but
 * a plain container in QuickTime-brand files. Peek: when the first child slot
 * parses as a plausible box (`hdlr`/`keys`/`ilst`/`data`), there is no prefix.
 */
function metaChildOffset(view: DataView, payloadStart: number, payloadEnd: number): number {
  const plausible = new Set(["hdlr", "keys", "ilst", "data", "free"]);
  if (payloadStart + 8 <= payloadEnd && plausible.has(boxType(view, payloadStart + 4))) {
    return payloadStart;
  }
  return payloadStart + 4;
}

/** Collect the 1-based indexes of `keys` entries whose name mentions location. */
function locationKeyIndexes(view: DataView, box: BoxHeader): Set<number> {
  const indexes = new Set<number>();
  const payload = box.start + box.headerSize;
  const end = box.start + box.size;
  // keys is a fullbox: 4 bytes version/flags, then u32 entry_count.
  if (payload + 8 > end) return indexes;
  const count = view.getUint32(payload + 4);
  let cursor = payload + 8;
  for (let index = 1; index <= count; index += 1) {
    if (cursor + 8 > end) break;
    const entrySize = view.getUint32(cursor);
    if (entrySize < 8 || cursor + entrySize > end) break;
    let name = "";
    for (let i = cursor + 8; i < cursor + entrySize; i += 1) {
      name += String.fromCharCode(view.getUint8(i));
    }
    if (name.toLowerCase().includes("location")) indexes.add(index);
    cursor += entrySize;
  }
  return indexes;
}

function blankRange(bytes: Uint8Array, start: number, end: number): void {
  bytes.fill(SPACE, start, end);
}

/** Blank the value bytes of every `data` box inside an ilst item. */
function blankIlstItemValues(view: DataView, bytes: Uint8Array, item: BoxHeader): boolean {
  let cursor = item.start + item.headerSize;
  const end = item.start + item.size;
  let blanked = false;
  for (;;) {
    const child = readBoxHeader(view, cursor, end);
    if (!child) break;
    if (child.type === "data") {
      // data payload: u32 type indicator + u32 locale, then the value.
      const valueStart = child.start + child.headerSize + 8;
      const valueEnd = child.start + child.size;
      if (valueStart < valueEnd) {
        blankRange(bytes, valueStart, valueEnd);
        blanked = true;
      }
    }
    cursor = child.start + child.size;
    if (cursor >= end) break;
  }
  return blanked;
}

/**
 * Phase 1 — collect the location key indexes from every `keys` box first,
 * so blanking works regardless of whether `keys` precedes `ilst` on disk.
 * Returns false on a structural anomaly.
 */
function collectLocationKeys(view: DataView, start: number, end: number, keyIndexes: Set<number>): boolean {
  let cursor = start;
  while (cursor < end) {
    const box = readBoxHeader(view, cursor, end);
    if (!box) return false;
    if (box.type === "keys" && !box.isXyz) {
      for (const index of locationKeyIndexes(view, box)) keyIndexes.add(index);
    } else if (!box.isXyz && CONTAINER_TYPES.has(box.type)) {
      const payloadStart = box.type === "meta"
        ? metaChildOffset(view, box.start + box.headerSize, box.start + box.size)
        : box.start + box.headerSize;
      if (!collectLocationKeys(view, payloadStart, box.start + box.size, keyIndexes)) return false;
    }
    cursor = box.start + box.size;
  }
  return true;
}

/**
 * Phase 2 — recursive blank pass. Returns the number of blanked value spans,
 * or -1 on a structural anomaly (caller must discard the patch).
 */
function walkAndBlank(view: DataView, bytes: Uint8Array, start: number, end: number, keyIndexes: Set<number>): number {
  let cursor = start;
  let blanked = 0;
  while (cursor < end) {
    const box = readBoxHeader(view, cursor, end);
    if (!box) return -1;

    if (box.isXyz) {
      // ©xyz payload: u16 string size + u16 language, then the coordinate
      // string. Blank everything after the box header — players tolerate a
      // space-filled annotation; the coordinates are gone.
      const valueStart = box.start + box.headerSize;
      const valueEnd = box.start + box.size;
      if (valueStart < valueEnd) {
        blankRange(bytes, valueStart, valueEnd);
        blanked += 1;
      }
    } else if (box.type === "ilst") {
      // ilst item types are u32 indexes into keys (when keys is present).
      let itemCursor = box.start + box.headerSize;
      const ilstEnd = box.start + box.size;
      while (itemCursor < ilstEnd) {
        const item = readBoxHeader(view, itemCursor, ilstEnd);
        if (!item) return -1;
        const index = view.getUint32(item.start + 4);
        if (keyIndexes.has(index)) {
          if (blankIlstItemValues(view, bytes, item)) blanked += 1;
        }
        itemCursor = item.start + item.size;
      }
    } else if (CONTAINER_TYPES.has(box.type)) {
      const payloadStart = box.type === "meta"
        ? metaChildOffset(view, box.start + box.headerSize, box.start + box.size)
        : box.start + box.headerSize;
      const inner = walkAndBlank(view, bytes, payloadStart, box.start + box.size, keyIndexes);
      if (inner < 0) return -1;
      blanked += inner;
    }

    cursor = box.start + box.size;
  }
  return blanked;
}

/** Pure verification walk — same traversal, no writes. */
function structureParses(view: DataView, start: number, end: number): boolean {
  let cursor = start;
  while (cursor < end) {
    const box = readBoxHeader(view, cursor, end);
    if (!box) return false;
    if (!box.isXyz && CONTAINER_TYPES.has(box.type)) {
      const payloadStart = box.type === "meta"
        ? metaChildOffset(view, box.start + box.headerSize, box.start + box.size)
        : box.start + box.headerSize;
      if (!structureParses(view, payloadStart, box.start + box.size)) return false;
    }
    cursor = box.start + box.size;
  }
  return true;
}

/** Locate the top-level `moov` box by reading only box headers off the Blob. */
async function findMoov(file: Blob): Promise<{ offset: number; size: number } | null> {
  let cursor = 0;
  while (cursor + 8 <= file.size) {
    const header = new DataView(await file.slice(cursor, Math.min(cursor + 16, file.size)).arrayBuffer());
    if (header.byteLength < 8) return null;
    let size = header.getUint32(0);
    let headerSize = 8;
    if (size === 1) {
      if (header.byteLength < 16) return null;
      const large = header.getBigUint64(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(large);
      headerSize = 16;
    } else if (size === 0) {
      size = file.size - cursor;
    }
    if (size < headerSize || cursor + size > file.size) return null;
    const type = String.fromCharCode(header.getUint8(4), header.getUint8(5), header.getUint8(6), header.getUint8(7));
    if (type === "moov") return { offset: cursor, size };
    cursor += size;
  }
  return null;
}

/**
 * Returns the file with location atoms blanked (same byte length), or the
 * ORIGINAL file when nothing was found / anything looked unusual.
 */
export async function stripVideoLocationMetadata(file: Blob): Promise<VideoLocationStripResult> {
  try {
    const moov = await findMoov(file);
    if (!moov || moov.size > MAX_MOOV_BYTES) return { blob: file, stripped: false };

    const bytes = new Uint8Array(await file.slice(moov.offset, moov.offset + moov.size).arrayBuffer());
    if (bytes.byteLength !== moov.size) return { blob: file, stripped: false };
    const view = new DataView(bytes.buffer);

    const keyIndexes = new Set<number>();
    if (!collectLocationKeys(view, 0, bytes.byteLength, keyIndexes)) return { blob: file, stripped: false };
    const blanked = walkAndBlank(view, bytes, 0, bytes.byteLength, keyIndexes);
    if (blanked <= 0) return { blob: file, stripped: false };
    // The patch must not have disturbed the box structure.
    if (!structureParses(view, 0, bytes.byteLength)) return { blob: file, stripped: false };

    const patched = new Blob(
      [file.slice(0, moov.offset), bytes, file.slice(moov.offset + moov.size)],
      { type: file.type },
    );
    if (patched.size !== file.size) return { blob: file, stripped: false };
    return { blob: patched, stripped: true };
  } catch {
    return { blob: file, stripped: false };
  }
}
