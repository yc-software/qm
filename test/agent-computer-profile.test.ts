import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createSpritesSandbox } from "../src/sandbox/sprites-sandbox.ts";
import { createAwsSandbox } from "../src/sandbox/aws-sandbox.ts";
import { effectiveEgressEnforcement } from "../src/sandbox/sandbox.ts";
import { installFakeMicrovm } from "./support/fake-microvm.ts";

async function withWorkspace<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "agent-computer-profile-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function awsSandbox(extraTools: string[]) {
  const fake = installFakeMicrovm();
  return createAwsSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "aws-profile-"))), {
    region: "us-west-2",
    imageIdentifier: "img",
    s3Bucket: "bucket",
    api: fake.api,
    s3: fake.s3,
    fetchImpl: fake.fetchImpl,
    extraTools,
  });
}

test("the sprites sandbox declares the Agent Computer contract (persistent per-scope computer)", async () => {
  await withWorkspace(async (dir) => {
    const workspace = createLocalWorkspaceStore(dir);
    const sprites = createSpritesSandbox(workspace, { token: "test-token" });

    const { spec, ...contract } = sprites.profile;
    assert.deepEqual(contract, {
      backend: "sprites",
      writablePersistence: "resident_disk",
      processSessions: true,
      egressEnforcement: "none",
    });
    assert.match(spec?.os ?? "", /Ubuntu/);
    assert.equal(spec?.homeDir, "/home/sprite");
    assert.equal(spec?.workdir, "/home/sprite/workspace");
    assert.ok(spec?.notInstalled?.includes("gh"));
    assert.equal(typeof sprites.backupComputer, "function");
  });
});

test("a layer re-describing a hardcoded tool never advertises the binary twice (first occurrence wins)", () => {
  const sb = awsSandbox(["git (deployment Git CLI)"]);
  const gitLines = (sb.profile.spec?.tools ?? []).filter((line) => line.split(/\s+/)[0] === "git");
  assert.deepEqual(gitLines, ["git"], "one advertise line per binary; the hardcoded entry wins");
});

test("a layer that advertises a tool removes it from notInstalled (no install/not-installed contradiction)", () => {
  const sb = awsSandbox(["gcloud (deployment Google Cloud CLI)"]);
  const { spec } = sb.profile;
  assert.ok(spec?.tools?.includes("gcloud (deployment Google Cloud CLI)"), "advertise line joins the tools list");
  assert.ok(!spec?.notInstalled?.includes("gcloud"), "advertised tool is dropped from notInstalled");
  assert.ok(spec?.notInstalled?.includes("kubectl"));
});

test("egress enforcement is effective only when core can mint a reachable proxy token", async () => {
  await withWorkspace((dir) => {
    const sprites = createSpritesSandbox(createLocalWorkspaceStore(dir), {
      token: "test-token",
      egressProxyUrl: "https://egress-proxy.example.com",
    });
    assert.equal(sprites.profile.egressEnforcement, "domain", "the backend declares its configured capability");
    assert.equal(
      effectiveEgressEnforcement(sprites.profile, { signingSecret: "secret" }),
      "none",
      "no reachable core URL means no per-turn token",
    );
    assert.equal(
      effectiveEgressEnforcement(sprites.profile, { apiBaseUrl: "https://core.internal" }),
      "none",
      "no signer means no per-turn token",
    );
    assert.equal(
      effectiveEgressEnforcement(sprites.profile, { signingSecret: "secret", apiBaseUrl: "https://core.internal" }),
      "domain",
    );
  });
});
