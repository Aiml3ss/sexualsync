import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";

const root = process.cwd();
const dist = path.join(root, "dist");
const nextServerApp = path.join(root, "web", ".next", "server", "app");
const nextBuildStatic = path.join(root, "web", ".next", "static");

// Pinning the service-worker APP_VERSION to the build SHA + timestamp guarantees
// every deploy invalidates every installed PWA cache. Without this the constant
// in sw.js has to be hand-bumped, which is a real-world rollback hazard.
function buildVersionTag() {
  let sha = "local";
  try {
    sha = execSync("git rev-parse --short=10 HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
      .slice(0, 10) || "local";
  } catch {
    sha = process.env.CF_PAGES_COMMIT_SHA?.slice(0, 10) || "local";
  }
  const date = new Date();
  const stamp = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}${String(date.getUTCHours()).padStart(2, "0")}${String(date.getUTCMinutes()).padStart(2, "0")}`;
  return `sexualsync-pwa-${stamp}-${sha}`;
}

const APP_VERSION_TAG = buildVersionTag();

const rootFiles = [
  "legal.css",
  "sw.js",
  "manifest.webmanifest",
  "presentation.html",
  "offline.html",
  "thank-you.html",
  "privacy.html",
  "terms.html",
  "report.html",
  "dmca.html",
  "support.html",
  "app-icon.svg",
  ".well-known/security.txt",
  ".well-known/code-transparency-key.json",
  "_headers",
  "_routes.json",
  "_redirects",
];

const nextPreviewFiles = [
  "index.html",
  "index.rsc",
  "admin.html",
  "admin.rsc",
  "ask.html",
  "ask.rsc",
  "ask-detail.html",
  "ask-detail.rsc",
  "chat.html",
  "chat.rsc",
  "games.html",
  "games.rsc",
  path.join("games", "blind-reveal.html"),
  path.join("games", "blind-reveal.rsc"),
  path.join("games", "pile.html"),
  path.join("games", "pile.rsc"),
  path.join("games", "sex-quiz.html"),
  path.join("games", "sex-quiz.rsc"),
  path.join("games", "green-lights.html"),
  path.join("games", "green-lights.rsc"),
  "ideas.html",
  "ideas.rsc",
  "inspiration.html",
  "inspiration.rsc",
  "limits.html",
  "limits.rsc",
  "more.html",
  "more.rsc",
  "mutual.html",
  "mutual.rsc",
  "onboarding.html",
  "onboarding.rsc",
  "review.html",
  "review.rsc",
  "sexboard.html",
  "sexboard.rsc",
  "share.html",
  "share.rsc",
  "signed-out.html",
  "signed-out.rsc",
  "signin.html",
  "signin.rsc",
  "space.html",
  "space.rsc",
  "splash.html",
  "splash.rsc",
  "tonight.html",
  "tonight.rsc",
  "v1-preview.html",
  "v1-preview.rsc",
  "welcome.html",
  "welcome.rsc",
  path.join("inspiration", "shelf.html"),
  path.join("inspiration", "shelf.rsc"),
  path.join("inspiration", "kink.html"),
  path.join("inspiration", "kink.rsc"),
  path.join("space", "acts.html"),
  path.join("space", "acts.rsc"),
  path.join("space", "health.html"),
  path.join("space", "health.rsc"),
  path.join("space", "limits.html"),
  path.join("space", "limits.rsc"),
  path.join("space", "notes.html"),
  path.join("space", "notes.rsc"),
  path.join("space", "privacy.html"),
  path.join("space", "privacy.rsc"),
  path.join("space", "tutorial.html"),
  path.join("space", "tutorial.rsc"),
  path.join("space", "vault.html"),
  path.join("space", "vault.rsc"),
];

// Root assets that only exist on the Cloudflare edition (Pages routing) or are
// produced by an internal signing step the self-host edition doesn't carry.
// The self-host repo is a curated subset (see scripts/publish-selfhost.mjs), so
// these can be legitimately absent — skip them with a warning instead of failing
// the whole build. Every OTHER root file is required and still throws if missing.
const OPTIONAL_ROOT_FILES = new Set([
  ".well-known/security.txt",
  ".well-known/code-transparency-key.json",
  "_routes.json", // Cloudflare Pages route manifest — no meaning on the Node server.
  "_redirects", // Cloudflare Pages redirects — handled by the reverse proxy on self-host.
]);

function copyFile(relativePath, { optional = false } = {}) {
  const source = path.join(root, relativePath);
  if (optional && !fs.existsSync(source)) {
    console.warn(`build: skipping optional asset absent on this edition: ${relativePath}`);
    return;
  }
  const target = path.join(dist, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function copyDir(source, target) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function copyPresentationScreenshots() {
  const presentation = fs.readFileSync(path.join(root, "presentation.html"), "utf8");
  const screenshotPaths = new Set(
    Array.from(presentation.matchAll(/src="\/(docs\/screenshots\/share\/[^"]+\.png)"/g))
      .map((match) => match[1])
  );

  for (const file of screenshotPaths) copyFile(file);
}

function copyNextPreview() {
  const previewRoot = nextServerApp;
  if (!fs.existsSync(previewRoot)) {
    console.warn("Skipping v1 app copy: no Next build output exists. Run `npm run build:v1-preview` first.");
    return;
  }

  copyDir(nextBuildStatic, path.join(dist, "_next", "static"));

  for (const file of nextPreviewFiles) {
    const source = path.join(previewRoot, file);
    if (!fs.existsSync(source)) {
      console.warn(`Skipping missing v1 preview asset: ${file}`);
      continue;
    }
    const target = path.join(dist, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const file of rootFiles) copyFile(file, { optional: OPTIONAL_ROOT_FILES.has(file) });

// Rewrite the dist copy of sw.js so APP_VERSION reflects this build. The source
// sw.js retains its placeholder constant so local dev still sees a stable name.
const swDistPath = path.join(dist, "sw.js");
if (fs.existsSync(swDistPath)) {
  const original = fs.readFileSync(swDistPath, "utf8");
  const stamped = original.replace(
    /const APP_VERSION = "[^"]+";/,
    `const APP_VERSION = "${APP_VERSION_TAG}";`
  );
  if (stamped === original) {
    throw new Error("build.mjs: failed to inject APP_VERSION into dist/sw.js (constant not matched).");
  }
  fs.writeFileSync(swDistPath, stamped);
  console.log(`build: stamped sw.js APP_VERSION=${APP_VERSION_TAG}`);
}

copyDir(path.join(root, "brand", "marks"), path.join(dist, "brand", "marks"));
copyDir(path.join(root, "brand", "tokens"), path.join(dist, "brand", "tokens"));
copyDir(path.join(root, "brand", "wordmark"), path.join(dist, "brand", "wordmark"));
copyPresentationScreenshots();
copyNextPreview();

// Code-transparency signing is a Cloudflare-edition step (its generator + signing
// key are internal-only and not published to the self-host subset). Run it when
// present; skip with a warning when the self-host edition doesn't carry it.
const transparencyGenerator = path.join(root, "scripts", "generate-code-transparency.mjs");
if (fs.existsSync(transparencyGenerator)) {
  execFileSync(process.execPath, [transparencyGenerator, "--app-version", APP_VERSION_TAG], {
    stdio: "inherit",
    env: {
      ...process.env,
      APP_VERSION_TAG
    }
  });
} else {
  console.warn("build: skipping code-transparency manifest (generator not present in this edition).");
}
