// Filesystem-backed Cloudflare R2 bucket shim for the self-host edition.
//
// Implements the subset of the R2 bucket surface the app uses on
// `env.VAULT_MEDIA`: get(key) -> { body, size, httpMetadata }, put(key, value),
// delete(key), plus head(key). With this bound, functions/api/_vault.js and
// functions/api/vault-media.js run UNCHANGED. Vault media is already
// client-side encrypted (E2EE) before upload, so this only moves opaque
// ciphertext bytes.
//
// Keys look like "vault/<workspace>/<item>/<name>" — already sanitized by the
// app's safeKeySegment(). We map them straight onto a directory tree and still
// guard against "..".

import { promises as fs, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";

function safeKey(key) {
  const clean = String(key).replace(/\\/g, "/").replace(/^\/+/, "");
  if (clean.split("/").some((seg) => seg === "..")) {
    throw new Error("Unsafe object storage key");
  }
  return clean;
}

async function toBuffer(value) {
  if (value == null) return Buffer.alloc(0);
  if (typeof value === "string") return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value.arrayBuffer === "function") return Buffer.from(await value.arrayBuffer()); // Blob / File
  if (typeof value.getReader === "function") { // Web ReadableStream
    const reader = value.getReader();
    const chunks = [];
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (typeof value[Symbol.asyncIterator] === "function") { // Node Readable
    const chunks = [];
    for await (const chunk of value) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  return Buffer.from(String(value));
}

export function createFsR2Bucket(dir) {
  const ready = fs.mkdir(dir, { recursive: true }).then(() => {});
  const fileFor = (key) => path.join(dir, safeKey(key));

  return {
    async get(key, opts = {}) {
      await ready;
      const file = fileFor(key);
      let stat;
      try { stat = await fs.stat(file); } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
      if (!stat.isFile()) return null;

      // Honor R2's `range` option so the shared vault-media handler can serve a
      // 206 partial read (iOS <video>/<audio> seeking). `object.range` is the
      // signal it checks; without it the handler falls back to a full 200. With
      // no range option behavior is unchanged (full body, no `range`).
      const want = opts?.range;
      if (want && Number.isFinite(want.offset) && Number.isFinite(want.length)) {
        const offset = Math.max(0, Math.min(want.offset, stat.size));
        const length = Math.max(0, Math.min(want.length, stat.size - offset));
        const end = offset + length - 1;
        const stream = length > 0
          ? createReadStream(file, { start: offset, end })
          : Readable.from([]);
        return {
          key: safeKey(key),
          size: stat.size,
          range: { offset, length },
          body: Readable.toWeb(stream),
          httpMetadata: { contentLength: stat.size },
          async arrayBuffer() {
            if (length === 0) return new ArrayBuffer(0);
            const buf = await fs.readFile(file);
            const slice = buf.subarray(offset, offset + length);
            return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
          }
        };
      }

      return {
        key: safeKey(key),
        size: stat.size,
        body: Readable.toWeb(createReadStream(file)),
        httpMetadata: { contentLength: stat.size },
        async arrayBuffer() {
          const buf = await fs.readFile(file);
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        }
      };
    },

    async head(key) {
      await ready;
      try {
        const stat = await fs.stat(fileFor(key));
        return stat.isFile() ? { key: safeKey(key), size: stat.size, httpMetadata: { contentLength: stat.size } } : null;
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },

    async put(key, value, _opts = {}) {
      await ready;
      const file = fileFor(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const buf = await toBuffer(value);
      const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
      await fs.writeFile(tmp, buf);
      await fs.rename(tmp, file);
      return { key: safeKey(key), size: buf.length };
    },

    async delete(key) {
      await ready;
      await fs.rm(fileFor(key), { force: true });
    },

    // R2 list surface. Walks the media tree and returns objects whose keys
    // start with `prefix`. Used by the /api/health R2 probe and by Vault
    // cleanup scans. Keys are the slash-joined relative paths (the same keys
    // put() was called with).
    async list(options = {}) {
      await ready;
      const prefix = String(options.prefix || "");
      const limit = Number.isFinite(options.limit) ? Math.min(1000, Math.max(1, options.limit)) : 1000;
      const objects = [];
      async function walk(currentDir, rel) {
        if (objects.length >= limit) return;
        let entries;
        try { entries = await fs.readdir(currentDir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (objects.length >= limit) return;
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          const full = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            await walk(full, childRel);
          } else if (entry.isFile() && !entry.name.includes(".tmp-") && childRel.startsWith(prefix)) {
            let size = 0;
            try { size = (await fs.stat(full)).size; } catch { /* ignore */ }
            objects.push({ key: childRel, size });
          }
        }
      }
      await walk(dir, "");
      return { objects: objects.slice(0, limit), truncated: objects.length >= limit, cursor: undefined, delimitedPrefixes: [] };
    }
  };
}
