// Contract test: the client re-encrypt migration's PLACEHOLDERS allowlist
// (web/src/lib/room-reencrypt.ts) MUST contain every "Encrypted …" placeholder
// string the server writes at rest (functions/**).
//
// Why this matters — the bug this guards against:
//   The migration decides whether a field still needs encrypting with
//   `meaningfulText(value)`, which is true for any non-empty string that is NOT
//   in PLACEHOLDERS. If a server placeholder is missing from the set, a row that
//   already holds that placeholder (e.g. a blind-reveal prompt that lost its box)
//   is treated as real plaintext and the migration ENCRYPTS THE PLACEHOLDER
//   STRING itself — permanently replacing the real content with the literal
//   "Encrypted prompt". "Encrypted prompt" was missing, so only blind-reveal
//   prompts were corrupted while every other surface (whose placeholder WAS
//   listed) survived. This test fails if the two sides ever drift again.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const FUNCTIONS_DIR = path.join(REPO, "functions");
const REENCRYPT_FILE = path.join(REPO, "web", "src", "lib", "room-reencrypt.ts");

// A placeholder literal: "Encrypted " followed by lowercase words only, short
// enough to be a label rather than a sentence. Matches the at-rest record
// placeholders ("Encrypted prompt", "Encrypted answer", …) and not error copy.
const PLACEHOLDER_RE = /"(Encrypted [a-z][a-z ]{0,28})"/g;

function walkJs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkJs(full));
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

function placeholdersIn(text) {
  const set = new Set();
  for (const match of text.matchAll(PLACEHOLDER_RE)) set.add(match[1]);
  return set;
}

test("client PLACEHOLDERS covers every server-written at-rest placeholder", () => {
  const serverPlaceholders = new Set();
  for (const file of walkJs(FUNCTIONS_DIR)) {
    for (const value of placeholdersIn(readFileSync(file, "utf8"))) {
      serverPlaceholders.add(value);
    }
  }
  // Sanity: the scan found the known surface placeholders. If this is empty the
  // regex or path is wrong and the parity check below would be vacuously true.
  assert.ok(serverPlaceholders.has("Encrypted prompt"), "scan should see the blind-reveal prompt placeholder");
  assert.ok(serverPlaceholders.size >= 8, `expected many server placeholders, found ${serverPlaceholders.size}`);

  const clientPlaceholders = placeholdersIn(readFileSync(REENCRYPT_FILE, "utf8"));

  const missing = [...serverPlaceholders].filter((value) => !clientPlaceholders.has(value)).sort();
  assert.deepEqual(
    missing,
    [],
    `room-reencrypt.ts PLACEHOLDERS is missing server placeholder(s): ${missing.join(", ")}. `
      + "Add them, or the migration will re-encrypt the placeholder string and destroy the real content.",
  );
});
