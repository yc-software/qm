import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createAclStore } from "../src/acl/acl-store.ts";
import { materializeInbound, sharedManifest, type ArtifactRegistration } from "../src/core/attachments.ts";
import { createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createMicrovmApi } from "../src/sandbox/aws-microvm-api.ts";
import { userFacingFailureText } from "../plugins/chassis/src/failure-copy.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { scopeId, type ScopeId } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";

const owner = scopeId("personal", "U1");

test("an inbound file is saved before the computer starts, and survives a computer failure", async () => {
  const transfer = createMemoryBlobTransferStore();
  const blob = await transfer.put(Readable.from([Buffer.from("hello")]));
  const saved: string[] = [];
  const register: ArtifactRegistration = {
    store: {
      put: async (input: { id: string; name: string }) => {
        saved.push(input.name);
        return { artifact: input, created: true };
      },
    } as never,
    ownerScopeId: owner,
    createdBy: "U1",
    seed: "turn-1",
  };
  const sandbox = {
    writeFileBytes: async () => {
      throw new Error("must not be reached");
    },
  } as unknown as Sandbox;
  const result = await materializeInbound(
    sandbox,
    () => Promise.reject(new Error("provider down")) as Promise<SandboxHandle>,
    [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: 5, blobId: blob.blobId }],
    transfer,
    register,
  );
  assert.deepEqual(saved, ["notes.txt"]);
  assert.equal(result.metas.length, 1);
  assert.ok(result.metas[0]!.artifactId);
  assert.ok(result.unstaged?.has("notes.txt"));
});

test("an inbound file with no durable home still fails loudly when the computer fails", async () => {
  const transfer = createMemoryBlobTransferStore();
  const blob = await transfer.put(Readable.from([Buffer.from("x")]));
  await assert.rejects(
    () =>
      materializeInbound(
        {} as Sandbox,
        () => Promise.reject(new Error("provider down")) as Promise<SandboxHandle>,
        [{ name: "a.txt", mimetype: "text/plain", sizeBytes: 1, blobId: blob.blobId }],
        transfer,
      ),
    /provider down/,
  );
});

test("shared files with the same name get distinct, stable handles", async () => {
  const acl = createAclStore();
  const channel = scopeId("channel", "C1");
  for (const ref of ["artifacts/a1/image.png", "artifacts/b2/image.png", "artifacts/c3/report.pdf"])
    await acl.grant({ ownerScopeId: owner, ref, granteeScopeId: channel, permission: "read", grantedBy: "U1" });
  const first = await acl.handlesFor([channel]);
  const paths = first.map((h) => h.handlePath);
  assert.equal(new Set(paths).size, 3);
  assert.ok(paths.includes("shared/report.pdf"));
  assert.ok(paths.every((p) => p === "shared/report.pdf" || /^shared\/image-[0-9a-f]{8}\.png$/.test(p)));
  const again = await acl.handlesFor([channel]);
  assert.deepEqual(
    again.map((h) => [h.ownerPath, h.handlePath]).sort(),
    first.map((h) => [h.ownerPath, h.handlePath]).sort(),
  );
  assert.doesNotMatch(sharedManifest(first), /post` action/);
});

test("a failed turn keeps its typed reason for the live view", async () => {
  const { runs } = createMemoryRunStore();
  const { run } = await runs.enqueue({
    sessionId: "web:U1:t",
    request: { actor: { id: "U1" }, text: "hi", conversation: { threadRef: "web:U1:t" } } as never,
  });
  const claimed = await runs.claim("w1", 60_000);
  assert.equal(claimed?.id, run.id);
  await runs.fail(run.id, claimed!.leaseToken!, "The prompt is too long for this model.", { retry: false });
  const failed = await runs.get(run.id);
  assert.equal(userFacingFailureText(failed!.result!), "The prompt is too long for this model.");
});

function deployHarness(opts: { failApplies?: Set<number>; resolve?: boolean } = {}) {
  const applied: number[] = [];
  const deployStore = createDeployStore();
  const deploy = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: true },
      apply: async (_d, version) => {
        if (opts.failApplies?.has(version.version)) throw new Error(`v${version.version} never listened`);
        applied.push(version.version);
        return { host: "127.0.0.1", port: 21000 + applied.length };
      },
      resolveEndpoint: async () => null,
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "durable-content-deploy-")),
  });
  return { deploy, deployStore, applied };
}

test("a running app whose endpoint was lost is re-applied on reach instead of 404ing", async () => {
  const { deploy, deployStore, applied } = deployHarness();
  const d = await deploy.deploy({ ownerScopeId: owner, createdBy: "U1", entrypoint: "s.js", files: [] });
  await deployStore.setEndpoint(d.id, null);
  const reach = await deploy.reachDeployment(d.id, "U1");
  assert.equal(reach.status, "ok");
  assert.deepEqual(applied, [1, 1]);
  assert.ok((await deployStore.get(d.id))!.endpoint);
});

test("waking an app after a failed redeploy boots the last version that ran", async () => {
  const { deploy, deployStore, applied } = deployHarness({ failApplies: new Set([2]) });
  const d = await deploy.deploy({ ownerScopeId: owner, createdBy: "U1", entrypoint: "s.js", files: [] });
  await assert.rejects(() => deploy.redeploy(d.id, { entrypoint: "s.js", files: [] }), /never listened/);
  assert.equal((await deployStore.get(d.id))!.currentVersion, 2);
  const reach = await deploy.reachDeployment(d.id, "U1");
  assert.equal(reach.status, "ok");
  assert.deepEqual(applied, [1, 1]);
  assert.equal((await deployStore.get(d.id))!.appliedVersion, 1);
});

test("concurrent deployment field updates do not overwrite each other", async () => {
  const store = createDeployStore();
  const d = await store.create({ ownerScopeId: owner, createdBy: "U1", entrypoint: "s.js", snapshotDir: "/x" });
  await Promise.all([
    store.setDisplayName(d.id, "Shown"),
    store.setOwnerScope(d.id, scopeId("channel", "C9") as ScopeId),
    store.markRunning(d.id, 1, { host: "h", port: 1 }),
  ]);
  const after = (await store.get(d.id))!;
  assert.equal(after.displayName, "Shown");
  assert.equal(after.ownerScopeId, scopeId("channel", "C9"));
  assert.equal(after.status, "running");
  assert.equal(after.appliedVersion, 1);
});

test("a microVM create carrying a client token is retried after a lost response", async () => {
  let posts = 0;
  const api = createMicrovmApi({
    region: "us-east-1",
    credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }),
    fetchImpl: (async () => {
      posts++;
      if (posts === 1) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      return new Response(JSON.stringify({ MicrovmId: "mvm-1" }), { status: 200 });
    }) as typeof fetch,
  });
  const created = await api.runMicrovm({ clientToken: "tok-1" } as never);
  assert.equal(posts, 2);
  assert.ok(created);
});
