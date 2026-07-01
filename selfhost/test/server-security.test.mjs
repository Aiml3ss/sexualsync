import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSelfHostServer } from "../server.mjs";

test("local preview refuses public listen hosts", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sexualsync-public-preview-"));
  try {
    await assert.rejects(
      () => createSelfHostServer({
        host: "0.0.0.0",
        dataDir,
        envOverrides: {
          ALLOW_LOCAL_PREVIEW: "1",
          APP_SESSION_SECRET: "selfhost-server-security-secret-0001"
        }
      }),
      /ALLOW_LOCAL_PREVIEW=1 requires HOST=127\.0\.0\.1/
    );
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("local preview refuses TRUST_PROXY=true even on a loopback host (spoofable XFF bypass — audit M3)", async () => {
  // With TRUST_PROXY=true the loopback check that grants the unauthenticated
  // local-preview identity is derived from the client-supplied X-Forwarded-For,
  // so the two flags must never coexist — the server must refuse to boot.
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sexualsync-preview-proxy-"));
  try {
    await assert.rejects(
      () => createSelfHostServer({
        host: "127.0.0.1",
        trustProxy: true,
        dataDir,
        envOverrides: {
          ALLOW_LOCAL_PREVIEW: "1",
          APP_SESSION_SECRET: "selfhost-server-security-secret-0002"
        }
      }),
      /ALLOW_LOCAL_PREVIEW=1 is incompatible with TRUST_PROXY=true/
    );
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
