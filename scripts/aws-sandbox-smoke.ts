#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAwsSandbox, type StoredMicrovm } from "../src/sandbox/aws-sandbox.ts";
import { createMicrovmApi } from "../src/sandbox/aws-microvm-api.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { scopeId } from "../src/types.ts";
import { createNoopAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const region = process.env.AWS_SANDBOX_REGION ?? "us-west-2";
const profile = process.env.AWS_SANDBOX_PROFILE ?? "dev";
const imageIdentifier = process.env.AWS_SANDBOX_IMAGE ?? "qm-microvm-sandbox";
const executionRoleArn = process.env.AWS_SANDBOX_EXEC_ROLE_ARN;

const log = (...a: unknown[]) => console.log("[aws-smoke]", ...a);

async function main(): Promise<void> {
  const ws = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "aws-smoke-ws-")));
  const store = createMemoryMap<StoredMicrovm>();
  const sandbox = createAwsSandbox(ws, {
    store,
    advisoryLock: createNoopAdvisoryLock(),
    region,
    profile,
    imageIdentifier,
    ...(executionRoleArn ? { executionRoleArn } : {}),
  });
  const api = createMicrovmApi({ region, profile });
  const scope = scopeId("personal", `smoke-${Date.now()}`);
  const layers = [{ scopeId: scope, mountPath: "", mode: "rw" as const }];
  let bodyId = "";
  const currentBody = async (): Promise<string> => (await store.get(scope))?.microvmId ?? "";

  try {
    log("provision #1 (fresh launch)...");
    const h1 = await sandbox.provision(layers);
    bodyId = await currentBody();
    log("body", bodyId, "coldStart", h1.coldStart, "endpoint reachable");
    assert.equal(h1.coldStart, true, "first ever provision should be cold");

    log("exec over HTTPS...");
    const echo = await sandbox.run(h1, "echo hello-from-aws-microvm");
    assert.equal(echo.code, 0);
    assert.equal(echo.stdout.trim(), "hello-from-aws-microvm");
    const uname = await sandbox.run(h1, "uname -m; node --version; whoami");
    log("guest:", uname.stdout.trim().replace(/\n/g, " | "));

    const marker = `persist-${Date.now()}`;
    await sandbox.writeFile(h1, "notes/marker.txt", marker);
    assert.equal(await sandbox.readFile(h1, "notes/marker.txt"), marker);
    log("wrote marker", marker);

    log("teardown #1 (suspend)...");
    await sandbox.teardown(h1);

    log("provision #2 (should resume the same body, warm)...");
    const h2 = await sandbox.provision(layers);
    assert.equal(await currentBody(), bodyId, "warm resume reuses the same body");
    assert.equal(h2.coldStart, false, "resumed body is not cold");
    assert.equal(await sandbox.readFile(h2, "notes/marker.txt"), marker, "file present after resume");
    log("warm resume OK, marker intact");
    await sandbox.teardown(h2);

    log("\n=== ALL LIVE ASSERTIONS PASSED ===");
  } finally {
    log("cleanup: terminate body...");
    if (bodyId) await api.terminate(bodyId).catch(() => {});
    log("done");
  }
}

main().catch((e) => {
  console.error("[aws-smoke] FAILED:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
