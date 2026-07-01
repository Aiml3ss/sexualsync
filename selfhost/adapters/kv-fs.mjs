// Filesystem-backed Cloudflare KV namespace shim for the self-host edition.
//
// This implements the *Cloudflare KV namespace* surface (get/put/delete/list)
// that functions/api/_kv.js expects on `env.STORE`. With this bound, the
// existing getStore() adapter runs UNCHANGED in its default "kv" mode — no
// product code is aware it is talking to the filesystem instead of KV.
//
// Storage model: one flat directory, one file per key. The filename is the
// URL-encoded key (reversible, never contains "/"), so list() can recover the
// original keys and filter by prefix. Each file holds a JSON envelope
// { v: <stored string>, e: <expiry epoch ms | null> } so TTLs (expirationTtl)
// are honored lazily on read, matching KV semantics.
//
// Scale note: this is built for the single-couple/self-host scale Sexualsync
// targets, not for millions of keys. The Postgres StoreAdapter (migration
// checklist item 1) is the path for larger deployments.

import { promises as fs } from "node:fs";
import path from "node:path";

function encodeKey(key) {
  const name = encodeURIComponent(String(key));
  if (Buffer.byteLength(name) > 240) {
    throw new Error(`FS KV key too long after encoding (>240 bytes): ${String(key).slice(0, 80)}…`);
  }
  return name;
}

function decodeKey(name) {
  try { return decodeURIComponent(name); } catch { return name; }
}

function typeOf(opts) {
  const t = typeof opts === "string" ? opts : opts?.type;
  return t === "json" || t === "arrayBuffer" || t === "stream" || t === "text" ? t : "text";
}

export function createFsKvNamespace(dir) {
  const ready = fs.mkdir(dir, { recursive: true }).then(() => {});
  const fileFor = (key) => path.join(dir, encodeKey(key));

  async function readEnvelope(key) {
    await ready;
    let raw;
    try {
      raw = await fs.readFile(fileFor(key), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    let envelope;
    try { envelope = JSON.parse(raw); } catch { return null; }
    if (envelope && envelope.e && Date.now() > envelope.e) {
      await fs.rm(fileFor(key), { force: true }).catch(() => {});
      return null;
    }
    return envelope;
  }

  return {
    async get(key, opts) {
      const envelope = await readEnvelope(key);
      if (!envelope) return null;
      const value = typeof envelope.v === "string" ? envelope.v : "";
      const type = typeOf(opts);
      if (type === "json") {
        try { return JSON.parse(value); } catch { return null; }
      }
      if (type === "arrayBuffer") {
        const buf = Buffer.from(value, "utf8");
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
      if (type === "stream") {
        return new Blob([value]).stream();
      }
      return value;
    },

    async put(key, value, opts = {}) {
      await ready;
      const ttl = Number(opts?.expirationTtl || 0);
      const expiry = Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl * 1000 : null;
      const envelope = JSON.stringify({ v: String(value), e: expiry });
      const file = fileFor(key);
      const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
      await fs.writeFile(tmp, envelope, "utf8");
      await fs.rename(tmp, file); // atomic publish on the same filesystem
    },

    async delete(key) {
      await ready;
      await fs.rm(fileFor(key), { force: true });
    },

    async list(options = {}) {
      await ready;
      const prefix = String(options.prefix || "");
      const limit = Number.isFinite(options.limit) ? Math.min(1000, Math.max(1, options.limit)) : 1000;
      let names;
      try { names = await fs.readdir(dir); } catch { names = []; }
      const keys = names
        .filter((name) => !name.includes(".tmp-"))
        .map(decodeKey)
        .filter((key) => key.startsWith(prefix))
        .sort();
      const start = Number.parseInt(String(options.cursor || "0"), 10) || 0;
      const page = keys.slice(start, start + limit);
      const next = start + page.length;
      const complete = next >= keys.length;
      return {
        keys: page.map((name) => ({ name })),
        cursor: complete ? undefined : String(next),
        list_complete: complete
      };
    }
  };
}
