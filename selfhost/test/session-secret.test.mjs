// Self-host zero-config secret bootstrap (selfhost/lib/env-bindings.mjs).
//
// ensureSessionSecret must make a fresh instance secure with no manual step,
// while never overriding an operator-set secret and never changing the secret
// across restarts (a moving secret logs everyone out and strands at-rest data,
// which is keyed by APP_SESSION_SECRET when no DATA_ENCRYPTION_KEY_V* is set).

import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildEnv, ensureSessionSecret } from "../lib/env-bindings.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sexualsync-secret-"));
}

test("generates and persists a strong secret when none is set", () => {
  const dir = tmpDir();
  const env = {};
  ensureSessionSecret(dir, env);

  assert.equal(typeof env.APP_SESSION_SECRET, "string");
  assert.ok(env.APP_SESSION_SECRET.length >= 32, "secret must clear the 32-char floor");
  assert.match(env.APP_SESSION_SECRET, /^[0-9a-f]{64}$/, "256-bit hex");

  const file = path.join(dir, "session-secret");
  assert.ok(fs.existsSync(file), "secret must be persisted");
  assert.equal(fs.readFileSync(file, "utf8").trim(), env.APP_SESSION_SECRET);

  // No group/other access (0600-ish), portable across umasks.
  const mode = fs.statSync(file).mode & 0o077;
  assert.equal(mode, 0, "persisted secret must not be group/other readable");
});

test("reuses the persisted secret across restarts (stable key)", () => {
  const dir = tmpDir();
  const first = {};
  ensureSessionSecret(dir, first);
  const second = {};
  ensureSessionSecret(dir, second);
  assert.equal(second.APP_SESSION_SECRET, first.APP_SESSION_SECRET, "must not rotate on reboot");
});

test("an operator-set secret always wins and is not persisted", () => {
  const dir = tmpDir();
  const env = { APP_SESSION_SECRET: "operator-provided-session-secret-0001" };
  ensureSessionSecret(dir, env);
  assert.equal(env.APP_SESSION_SECRET, "operator-provided-session-secret-0001");
  assert.equal(fs.existsSync(path.join(dir, "session-secret")), false, "operator secret stays in env, not on disk");
});

test("a too-short env secret is treated as unset (generates a strong one)", () => {
  const dir = tmpDir();
  const env = { APP_SESSION_SECRET: "tooshort" };
  ensureSessionSecret(dir, env);
  assert.match(env.APP_SESSION_SECRET, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(path.join(dir, "session-secret")));
});

test("zero-config self-host gets a package-versioned APP_VERSION", () => {
  const dir = tmpDir();
  const env = buildEnv({ dataDir: dir, mediaDir: path.join(dir, "media"), overrides: {} });
  assert.match(env.APP_VERSION, /^sexualsync-selfhost-v\d+\.\d+\.\d+$/);
});
