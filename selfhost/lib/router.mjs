// File-based router that mirrors Cloudflare Pages Functions routing for the
// `functions/` directory, so the same handler files resolve the same way under
// Node.
//
// Conventions matched:
//   - Files/dirs starting with "_" are NOT routes (helpers + _middleware).
//   - `index.js` maps to its parent path.
//   - `[id].js`     -> dynamic param  (params.id)
//   - `[[path]].js` -> catch-all      (params.path = remaining segments array)
//   - Method-specific exports (onRequestGet/Post/...) take precedence over the
//     generic onRequest export.
//   - Exact/param routes beat catch-all routes; more literal segments win ties.

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const METHOD_EXPORTS = {
  GET: "onRequestGet",
  POST: "onRequestPost",
  PUT: "onRequestPut",
  PATCH: "onRequestPatch",
  DELETE: "onRequestDelete",
  HEAD: "onRequestHead",
  OPTIONS: "onRequestOptions"
};

function segmentInfo(seg) {
  if (/^\[\[.+\]\]$/.test(seg)) return { kind: "catchAll", name: seg.replace(/^\[\[|\]\]$/g, "") };
  if (/^\[.+\]$/.test(seg)) return { kind: "param", name: seg.replace(/^\[|\]$/g, "") };
  return { kind: "literal", value: seg };
}

async function walk(dir, base, out) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith("_")) continue; // helpers + _middleware are not routes
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, [...base, entry.name], out);
      continue;
    }
    if (!entry.name.endsWith(".js")) continue;
    const stem = entry.name.slice(0, -3);
    const segs = stem === "index" ? base : [...base, stem];
    out.push({ file: full, segments: segs.map(segmentInfo) });
  }
}

export async function buildRouter(functionsDir) {
  const routes = [];
  await walk(functionsDir, [], routes);
  const cache = new Map();

  async function load(file) {
    if (!cache.has(file)) cache.set(file, import(pathToFileURL(file).href));
    return cache.get(file);
  }

  return {
    routes,
    async match(method, pathname) {
      const parts = pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
      let exact = null;
      let exactScore = -1;
      let catchAll = null;
      let catchScore = -1;

      for (const route of routes) {
        const segs = route.segments;
        const last = segs[segs.length - 1];
        if (last && last.kind === "catchAll") {
          const fixed = segs.slice(0, -1);
          if (parts.length < fixed.length) continue;
          let ok = true;
          let score = 0;
          for (let i = 0; i < fixed.length; i += 1) {
            const seg = fixed[i];
            if (seg.kind === "literal") {
              if (seg.value !== parts[i]) { ok = false; break; }
              score += 2;
            } else {
              score += 1;
            }
          }
          if (ok && score > catchScore) {
            catchScore = score;
            const params = {};
            if (last.name) params[last.name] = parts.slice(fixed.length);
            catchAll = { route, params };
          }
        } else {
          if (segs.length !== parts.length) continue;
          let ok = true;
          let score = 0;
          const params = {};
          for (let i = 0; i < segs.length; i += 1) {
            const seg = segs[i];
            if (seg.kind === "literal") {
              if (seg.value !== parts[i]) { ok = false; break; }
              score += 2;
            } else {
              params[seg.name] = parts[i];
              score += 1;
            }
          }
          if (ok && score > exactScore) {
            exactScore = score;
            exact = { route, params };
          }
        }
      }

      const chosen = exact || catchAll;
      if (!chosen) return null;
      const mod = await load(chosen.route.file);
      const handler = mod[METHOD_EXPORTS[method]] || mod.onRequest || null;
      return { handler, params: chosen.params, file: chosen.route.file };
    }
  };
}
