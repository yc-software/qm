#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAwsSandbox } from "../src/sandbox/aws-sandbox.ts";
import { createMicrovmApi } from "../src/sandbox/aws-microvm-api.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { scopeId } from "../src/types.ts";

const region = process.env.AWS_SANDBOX_REGION ?? "us-west-2";
const profile = process.env.AWS_SANDBOX_PROFILE ?? "dev";
const s3Bucket = process.env.AWS_SANDBOX_S3_BUCKET;
const imageIdentifier = process.env.AWS_SANDBOX_IMAGE ?? "qm-microvm-sandbox";
const executionRoleArn = process.env.AWS_SANDBOX_EXEC_ROLE_ARN;

const log = (...a: unknown[]) => console.log("[aws-smoke]", ...a);

async function main(): Promise<void> {
  if (!s3Bucket) throw new Error("AWS_SANDBOX_S3_BUCKET is required");
  const ws = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "aws-smoke-ws-")));
  const sandbox = createAwsSandbox(ws, {
    region,
    profile,
    imageIdentifier,
    s3Bucket,
    s3Prefix: "sandbox-smoke",
    ...(executionRoleArn ? { executionRoleArn } : {}),
    snapshotIntervalMs: 0,
  });
  const api = createMicrovmApi({ region, profile });
  const scope = scopeId("personal", `smoke-${Date.now()}`);
  const layers = [{ scopeId: scope, mountPath: "", mode: "rw" as const }];
  let bodyId = "";

  try {
    log("provision #1 (fresh launch)...");
    const h1 = await sandbox.provision(layers);
    bodyId = h1.id;
    log("body", h1.id, "coldStart", h1.coldStart, "endpoint reachable");
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

    log("teardown #1 (snapshot $HOME -> S3, then suspend)...");
    await sandbox.teardown(h1);

    log("provision #2 (should resume the same body, warm)...");
    const h2 = await sandbox.provision(layers);
    assert.equal(h2.id, bodyId, "warm resume reuses the same body");
    assert.equal(h2.coldStart, false, "resumed body is not cold");
    assert.equal(await sandbox.readFile(h2, "notes/marker.txt"), marker, "file present after resume");
    log("warm resume OK, marker intact");
    await sandbox.teardown(h2);

    log("simulating the body dying (8h cap / external terminate)...");
    await api.terminate(bodyId);
    await api.waitForState(bodyId, "TERMINATED", { timeoutMs: 60_000 }).catch(() => {});

    log("provision #3 (fresh body, rehydrate $HOME from S3)...");
    const h3 = await sandbox.provision(layers);
    assert.notEqual(h3.id, bodyId, "a new body was launched");
    bodyId = h3.id;
    assert.equal(h3.coldStart, false, "rehydrated from S3, not cold");
    assert.equal(await sandbox.readFile(h3, "notes/marker.txt"), marker, "durable state survived the body dying");
    log("durability across body death OK");

    log("\n=== ALL LIVE ASSERTIONS PASSED ===");
  } finally {
    log("cleanup: terminate body + delete S3 snapshot...");
    if (bodyId) await api.terminate(bodyId).catch(() => {});
    const { S3Client, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region, profile });
    const key = `sandbox-smoke/${scope.replace(/[^a-zA-Z0-9_.-]/g, "__")}.tar`;
    await s3.send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: key })).catch(() => {});
    log("done");
  }
}

main().catch((e) => {
  console.error("[aws-smoke] FAILED:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
