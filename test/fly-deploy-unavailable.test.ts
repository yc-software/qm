import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { loadConfig } from "../src/config.ts";
import { createUnavailableFlyDeployProvider } from "../src/deploy/unavailable-fly-deploy-provider.ts";
import type { Deployment } from "../src/deploy/deploy-store.ts";

test("an unset Fly deploy provider refuses publishing without invoking Docker", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "qm-fly-deploy-unavailable-"));
  const built = buildApp(
    loadConfig({
      FLY_APP_NAME: "qm-core",
      DATA_DIR: dataDir,
      HARNESS: "mock",
      SANDBOX_BACKEND: "sprites",
      SPRITES_TOKEN: "test-token",
    }),
  );
  try {
    await assert.rejects(
      built.app.deploy({
        ownerScopeId: "personal:user-1",
        createdBy: "user-1",
        entrypoint: "node server.js",
        files: [{ path: "server.js", data: "" }],
      }),
      /application publishing is unavailable on Fly because qm has no Fly deploy provider/,
    );
  } finally {
    await built.runtime.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("unavailable Fly cleanup never claims external resources were destroyed", async () => {
  const provider = createUnavailableFlyDeployProvider();
  const deployment: Deployment = {
    id: "deployment-1",
    ownerScopeId: "personal:user-1",
    createdBy: "user-1",
    currentVersion: 1,
    appliedVersion: 1,
    status: "running",
    endpoint: { host: "app.example.test", port: 443 },
    versions: [{ version: 1, createdAt: 1, entrypoint: "node server.js", snapshotDir: "/tmp/snapshot" }],
  };
  await assert.rejects(
    provider.destroy(deployment),
    /application publishing is unavailable on Fly because qm has no Fly deploy provider/,
  );
  await assert.rejects(
    provider.destroy({ ...deployment, appliedVersion: undefined, status: "stopped", endpoint: null }),
    /application publishing is unavailable on Fly because qm has no Fly deploy provider/,
  );
});
