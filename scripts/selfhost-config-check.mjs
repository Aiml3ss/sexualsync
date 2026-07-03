// Self-host edition config/docs validator.
//
// Validation only: checks that the self-host scaffolding is present and
// coherent and that the runtime default is still "cloudflare". It performs NO
// deployment actions and is intentionally NOT part of the `deploy` chain.
//
// Run with: npm run selfhost:check

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const failures = [];

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}
function exists(file) {
  return fs.existsSync(path.join(root, file));
}
function assert(condition, message) {
  if (!condition) failures.push(message);
}

// --- Docs present and on-message -------------------------------------------

const docs = [
  "docs/self-host/README.md",
  "docs/self-host/ARCHITECTURE.md",
  "docs/self-host/MIGRATION_PLAN.md",
  "docs/self-host/CONFIG.md"
];
docs.forEach((doc) => assert(exists(doc), `Self-host doc missing: ${doc}`));

if (exists("docs/self-host/README.md")) {
  const readme = read("docs/self-host/README.md");
  assert(/not a (hard )?fork/i.test(readme), "README must state this is an edition, not a hard fork.");
  assert(readme.includes("SELF_HOST_TARGET"), "README must name the SELF_HOST_TARGET selector.");
  assert(/cloudflare/i.test(readme) && /default/i.test(readme), "README must state Cloudflare stays the default path.");
  assert(/LICENSE|license/.test(readme), "README must flag the license change needed before public self-host release.");
}

if (exists("docs/self-host/ARCHITECTURE.md")) {
  const arch = read("docs/self-host/ARCHITECTURE.md");
  ["StoreAdapter", "ObjectStorageAdapter", "RealtimeStateAdapter"].forEach((iface) => {
    assert(arch.includes(iface), `ARCHITECTURE must document the ${iface} interface.`);
  });
}

if (exists("docs/self-host/MIGRATION_PLAN.md")) {
  const plan = read("docs/self-host/MIGRATION_PLAN.md");
  [
    /Postgres\/SQLite .*STORE/i,
    /S3\/MinIO/i,
    /WebSocket room/i,
    /advisory[- ]lock/i,
    /SMTP/i,
    /Docker Compose/i,
    /[Ll]icense/
  ].forEach((re) => {
    assert(re.test(plan), `MIGRATION_PLAN checklist missing item matching ${re}.`);
  });
  // "TODO-free but explicit": the plan should track status, not litter TODOs.
  assert(!/\bTODO\b/.test(plan), "MIGRATION_PLAN should use an explicit status table, not TODO markers.");
}

// --- Env template -----------------------------------------------------------

assert(exists(".env.selfhost.example"), ".env.selfhost.example must exist.");
if (exists(".env.selfhost.example")) {
  const envExample = read(".env.selfhost.example");
  assert(/^\s*SELF_HOST_TARGET=node\s*$/m.test(envExample), ".env.selfhost.example must set SELF_HOST_TARGET=node.");
  assert(/local email\/password accounts are enabled automatically/i.test(envExample), ".env.selfhost.example must document zero-config local password auth.");
  assert(/PLACEHOLDER/.test(envExample), ".env.selfhost.example must clearly mark not-yet-wired placeholders.");
  ["DATABASE_URL", "S3_BUCKET", "ROOM_WS_URL", "SMTP_HOST"].forEach((v) => {
    assert(envExample.includes(v), `.env.selfhost.example missing planned adapter var ${v}.`);
  });
}

// The Cloudflare-focused env example should point at the self-host template
// without being rewritten around it.
if (exists(".env.example")) {
  assert(read(".env.example").includes(".env.selfhost.example"), ".env.example should point readers at .env.selfhost.example.");
}

// --- Runtime marker: default must be cloudflare -----------------------------

assert(exists("functions/api/_runtime.js"), "functions/api/_runtime.js runtime marker must exist.");
if (exists("functions/api/_runtime.js")) {
  const src = read("functions/api/_runtime.js");
  assert(src.includes('DEFAULT_RUNTIME_TARGET = RUNTIME_CLOUDFLARE'), "Runtime default must be cloudflare.");
  assert(src.includes('RUNTIME_NODE = "node"'), "Runtime must recognize the node target.");

  // Exercise the module so this check actually proves the contract, not just
  // greps for it.
  try {
    const mod = await import(pathToFileURL(path.join(root, "functions/api/_runtime.js")).href);
    assert(mod.runtimeTarget(undefined) === "cloudflare", "runtimeTarget(undefined) must resolve to cloudflare.");
    assert(mod.runtimeTarget({}) === "cloudflare", "runtimeTarget({}) must resolve to cloudflare.");
    assert(mod.runtimeTarget({ SELF_HOST_TARGET: "typo" }) === "cloudflare", "Unknown SELF_HOST_TARGET must fall back to cloudflare.");
    assert(mod.runtimeTarget({ SELF_HOST_TARGET: "node" }) === "node", "SELF_HOST_TARGET=node must be recognized.");
    assert(mod.isCloudflareRuntime({}) === true, "isCloudflareRuntime must be true by default.");
  } catch (error) {
    assert(false, `Could not load runtime marker: ${error?.message || error}`);
  }
}

// --- Node runtime artifacts (Phase 1) --------------------------------------

[
  "selfhost/server.mjs",
  "selfhost/smoke.mjs",
  "selfhost/package.json",
  "selfhost/README.md",
  "selfhost/lib/router.mjs",
  "selfhost/lib/static.mjs",
  "selfhost/lib/http-bridge.mjs",
  "selfhost/lib/env-bindings.mjs",
  "selfhost/lib/ws-protocol.mjs",
  "selfhost/lib/ws-room.mjs",
  "selfhost/lib/headers.mjs",
  "selfhost/adapters/kv-fs.mjs",
  "selfhost/adapters/r2-fs.mjs",
  "selfhost/test/realtime.test.mjs",
  "Dockerfile",
  "docker-compose.yml",
  ".dockerignore"
].forEach((file) => assert(exists(file), `Self-host runtime artifact missing: ${file}`));

if (exists("selfhost/lib/env-bindings.mjs")) {
  const bindings = read("selfhost/lib/env-bindings.mjs");
  assert(bindings.includes("env.STORE") && bindings.includes("createFsKvNamespace"), "env-bindings must bind STORE to the filesystem KV adapter.");
  assert(bindings.includes("env.VAULT_MEDIA") && bindings.includes("createFsR2Bucket"), "env-bindings must bind VAULT_MEDIA to the filesystem R2 adapter.");
  assert(/env\.ROOMS\s*=\s*rooms/.test(bindings), "env-bindings must bind ROOMS to the in-process room registry.");
  assert(!/env\.STATE\s*=/.test(bindings), "env-bindings must NOT bind STATE (CAS uses the in-process lock fallback for single-process).");
  assert(bindings.includes("sexualsync-selfhost-v"), "env-bindings must provide a package-versioned default APP_VERSION for zero-config self-host.");
}

if (exists("Dockerfile")) {
  const dockerfile = read("Dockerfile");
  assert(/COPY --from=build \/app\/dist\/_headers \.\/_headers/.test(dockerfile), "Docker runtime image must copy _headers to /app/_headers so Node applies security/cache headers.");
}

if (exists("docker-compose.yml")) {
  const compose = read("docker-compose.yml");
  assert(compose.includes('"127.0.0.1:8788:8788"'), "Docker Compose should publish localhost-only by default; public access should go through a TLS reverse proxy.");
}

if (exists("functions/api/_auth.js")) {
  const auth = read("functions/api/_auth.js");
  assert(auth.includes("cf-connecting-ip") && auth.includes("LOCAL_CLIENT_IPS"), "Local preview auth must require loopback client IP when the runtime supplies CF-Connecting-IP.");
}

if (exists("selfhost/server.mjs")) {
  const server = read("selfhost/server.mjs");
  assert(server.includes("isSameOriginUpgrade") && server.includes("origin") && server.includes("Forbidden"), "Self-host WebSocket upgrades must enforce same-origin Origin checks.");
  assert(server.includes("ALLOW_LOCAL_PREVIEW=1 requires HOST=127.0.0.1"), "Local preview mode must refuse public listen hosts.");
  assert(server.includes("local email/password sign-in is enabled"), "Self-host server must report zero-config local password sign-in when external auth is absent.");
}

// --- Cloudflare deploy chain must stay free of self-host -------------------

if (exists("package.json")) {
  const pkg = JSON.parse(read("package.json"));
  ["selfhost:check", "selfhost:build", "selfhost:serve", "selfhost:smoke", "selfhost:test"].forEach((s) => {
    assert(pkg.scripts && pkg.scripts[s], `package.json missing script: ${s}`);
  });
  const deploy = pkg.scripts?.deploy || "";
  assert(deploy.includes("wrangler pages deploy"), "deploy script must remain the Cloudflare Pages deploy.");
  assert(!/selfhost/i.test(deploy), "Cloudflare deploy chain must NOT reference self-host scripts.");
}

if (failures.length) {
  console.error("self-host config check failed:");
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log("self-host config check OK");
