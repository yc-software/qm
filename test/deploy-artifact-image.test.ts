import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDeployStore,
  type DeployStore,
  type Deployment,
  type DeploymentVersion,
} from "../src/deploy/deploy-store.ts";
import { createDeployService, type DeployService } from "../src/deploy/deploy-service.ts";
import type { DeployReconcileInput } from "../src/deploy/deploy-provider.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { scopeId } from "../src/types.ts";

interface ProviderProbe {
  appliedImages: Array<string | undefined>;
}

function flyLikeService(): { deploy: DeployService; deployStore: DeployStore; probe: ProviderProbe } {
  const deployStore = createDeployStore();
  const probe: ProviderProbe = { appliedImages: [] };
  const deploy = createDeployService({
    deployStore,
    acl: createAclStore(),
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    deployDir: mkdtempSync(join(tmpdir(), "deploy-img-")),
    provider: {
      profile: { managedScaleToZero: true },
      apply: async (_d: Deployment, version: DeploymentVersion) => {
        probe.appliedImages.push(version.image);
        const image = version.image ?? `registry.fly.io/app:v${version.version}`;
        return { host: "app.flycast", port: 80, image };
      },
      destroy: async () => {},
    },
  });
  return { deploy, deployStore, probe };
}

const owner = scopeId("personal", "U1");

test("deploy records the provider's converged image ref onto the version", async () => {
  const { deploy, deployStore } = flyLikeService();
  const d = await deploy.deploy({
    ownerScopeId: owner,
    createdBy: "U1",
    entrypoint: "node s.js",
    files: [{ path: "s.js", data: "x" }],
  });
  assert.equal(
    (await deployStore.versionOf(d.id, 1))!.image,
    "registry.fly.io/app:v1",
    "v1 image persisted after apply",
  );
});

test("redeploy builds a new image and records it; each version keeps its own ref", async () => {
  const { deploy, deployStore } = flyLikeService();
  const d = await deploy.deploy({
    ownerScopeId: owner,
    createdBy: "U1",
    entrypoint: "node s.js",
    files: [{ path: "s.js", data: "v1" }],
  });
  await deploy.redeploy(d.id, { entrypoint: "node s.js", files: [{ path: "s.js", data: "v2" }] });
  assert.equal((await deployStore.versionOf(d.id, 1))!.image, "registry.fly.io/app:v1");
  assert.equal((await deployStore.versionOf(d.id, 2))!.image, "registry.fly.io/app:v2");
});

test("rollback reuses the stored image — the provider gets the recorded ref, never rebuilds", async () => {
  const { deploy, deployStore, probe } = flyLikeService();
  const d = await deploy.deploy({
    ownerScopeId: owner,
    createdBy: "U1",
    entrypoint: "node s.js",
    files: [{ path: "s.js", data: "v1" }],
  });
  await deploy.redeploy(d.id, { entrypoint: "node s.js", files: [{ path: "s.js", data: "v2" }] });
  probe.appliedImages.length = 0;

  await deploy.rollbackDeployment(d.id, 1);
  assert.deepEqual(
    probe.appliedImages,
    ["registry.fly.io/app:v1"],
    "rollback hands the provider the stored v1 image (no rebuild)",
  );
  assert.equal((await deployStore.get(d.id))!.currentVersion, 1);
  assert.equal((await deployStore.versionOf(d.id, 1))!.image, "registry.fly.io/app:v1");
});

test("a runtime-mount provider (no image) leaves versions image-less — Docker behavior unchanged", async () => {
  const deployStore = createDeployStore();
  const deploy = createDeployService({
    deployStore,
    acl: createAclStore(),
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    deployDir: mkdtempSync(join(tmpdir(), "deploy-noimg-")),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 9200 }),
      destroy: async () => {},
    },
  });
  const d = await deploy.deploy({
    ownerScopeId: owner,
    createdBy: "U1",
    entrypoint: "node s.js",
    files: [{ path: "s.js", data: "x" }],
  });
  assert.equal(
    "image" in (await deployStore.versionOf(d.id, 1))!,
    false,
    "no image recorded for a runtime-mount provider",
  );
});

test("a reconcile-capable provider receives the git diff and marks the applied version", async () => {
  const deployStore = createDeployStore();
  const reconciles: DeployReconcileInput[] = [];
  const deploy = createDeployService({
    deployStore,
    acl: createAclStore(),
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    deployDir: mkdtempSync(join(tmpdir(), "deploy-reconcile-")),
    provider: {
      profile: { managedScaleToZero: true, inPlaceReconcile: true },
      apply: async () => {
        throw new Error("image path should not be used for git-backed versions");
      },
      reconcile: async (_d, _version, input) => {
        reconciles.push(input);
        return { host: "app.flycast", port: 80 };
      },
      destroy: async () => {},
    },
  });

  const d = await deploy.deploy({
    ownerScopeId: owner,
    createdBy: "U1",
    entrypoint: "node s.js",
    files: [
      { path: "s.js", data: "v1" },
      { path: "data.json", data: "1" },
    ],
  });
  await deploy.redeploy(d.id, {
    entrypoint: "node s.js",
    files: [
      { path: "s.js", data: "v1" },
      { path: "data.json", data: "2" },
    ],
  });

  assert.deepEqual([...reconciles[0]!.changedPaths].sort(), ["data.json", "s.js"]);
  assert.ok((reconciles[0]!.gitBundle?.byteLength ?? 0) > 0, "v1 reconcile receives a git bundle");
  assert.deepEqual(reconciles[1]!.changedPaths, ["data.json"], "only the changed file is sent on redeploy");
  assert.ok((reconciles[1]!.gitBundle?.byteLength ?? 0) > 0, "v2 reconcile receives a git bundle");
  assert.equal((await deployStore.get(d.id))!.appliedVersion, 2);
});

test("applied version is marked only after activation metadata is persisted", async () => {
  const baseStore = createDeployStore();
  let destroys = 0;
  const deployStore: DeployStore = {
    ...baseStore,
    markApplied: async () => {
      throw new Error("activation write failed");
    },
  };
  const deploy = createDeployService({
    deployStore,
    acl: createAclStore(),
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    deployDir: mkdtempSync(join(tmpdir(), "deploy-applied-order-")),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 9200 }),
      destroy: async () => {
        destroys++;
      },
    },
  });

  await assert.rejects(
    () =>
      deploy.deploy({
        ownerScopeId: owner,
        createdBy: "U1",
        entrypoint: "node s.js",
        files: [{ path: "s.js", data: "x" }],
      }),
    /activation write failed/,
  );
  const [d] = await baseStore.list();
  assert.equal(d!.appliedVersion, undefined);
  assert.equal(d!.status, "failed");
  assert.equal(d!.endpoint, null);
  assert.equal(destroys, 1);
});

test("a failed redeploy neither selects the candidate nor moves the hosted git current ref", async () => {
  const deployStore = createDeployStore();
  let applies = 0;
  const deploy = createDeployService({
    deployStore,
    acl: createAclStore(),
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    deployDir: mkdtempSync(join(tmpdir(), "deploy-current-ref-")),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => {
        applies++;
        if (applies > 1) throw new Error("apply failed");
        return { host: "127.0.0.1", port: 9200 };
      },
      destroy: async () => {},
    },
  });

  const d = await deploy.deploy({
    ownerScopeId: owner,
    createdBy: "U1",
    entrypoint: "node s.js",
    files: [{ path: "s.js", data: "v1" }],
  });
  const v1 = (await deployStore.versionOf(d.id, 1))!;
  assert.equal(await deployStore.refOf(d.id, "refs/heads/current"), v1.commit);

  await assert.rejects(
    () => deploy.redeploy(d.id, { entrypoint: "node s.js", files: [{ path: "s.js", data: "v2" }] }),
    /apply failed/,
  );
  const after = (await deployStore.get(d.id))!;
  assert.equal(after.status, "failed");
  assert.equal(after.currentVersion, 1, "the failed candidate is recorded without becoming current");
  assert.equal(after.appliedVersion, 1);
  assert.equal(await deployStore.refOf(d.id, "refs/heads/current"), v1.commit);
});

test("a failed git-push deploy restores the hosted current ref", async () => {
  const deployStore = createDeployStore();
  let applies = 0;
  const deploy = createDeployService({
    deployStore,
    acl: createAclStore(),
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    deployDir: mkdtempSync(join(tmpdir(), "deploy-push-current-ref-")),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => {
        const attempt = ++applies;
        if (attempt === 2) throw new Error("apply failed");
        return { host: "127.0.0.1", port: 9200, image: `image:${attempt}` };
      },
      destroy: async () => {},
    },
  });
  const d = await deploy.deploy({
    ownerScopeId: owner,
    createdBy: "U1",
    entrypoint: "node s.js",
    files: [{ path: "s.js", data: "v1" }],
  });
  const v1 = (await deployStore.versionOf(d.id, 1))!;
  const work = mkdtempSync(join(tmpdir(), "deploy-push-current-work-"));
  const repo = await deployStore.repoUrl(d.id);
  execFileSync("git", ["clone", "--quiet", repo, work]);
  writeFileSync(join(work, "s.js"), "v2");
  execFileSync("git", ["add", "s.js"], { cwd: work });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "v2"], { cwd: work });
  const v2Commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: work }).toString().trim();
  const push = (ref: string) =>
    deploy.pushGit(d.id, async () => {
      execFileSync("git", ["push", "--quiet", "--force", repo, `${ref}:refs/heads/current`], {
        cwd: work,
        env: { ...process.env, GIT_NAMESPACE: "pending" },
      });
      return { result: undefined, ok: true };
    });

  await push("HEAD");

  const after = (await deployStore.get(d.id))!;
  assert.equal(after.status, "failed");
  assert.equal(after.currentVersion, 1);
  assert.equal(after.appliedVersion, 1);
  assert.equal(after.versions.length, 2);
  assert.equal(await deployStore.refOf(d.id, "refs/heads/current"), v1.commit);

  await push("HEAD");
  const retried = (await deployStore.get(d.id))!;
  assert.equal(retried.status, "running");
  assert.equal(retried.currentVersion, 2);
  assert.equal(retried.appliedVersion, 2);
  assert.equal(retried.versions.length, 2);
  assert.equal(await deployStore.refOf(d.id, "refs/heads/current"), v2Commit);

  await push(v1.commit!);
  const rolledBack = (await deployStore.get(d.id))!;
  assert.equal(rolledBack.status, "running");
  assert.equal(rolledBack.currentVersion, 1);
  assert.equal(rolledBack.appliedVersion, 1);
  assert.equal(rolledBack.versions.length, 2);
  assert.equal(await deployStore.refOf(d.id, "refs/heads/current"), v1.commit);
});

test("receive-pack discovery does not activate an archived deployment", async () => {
  const deployStore = createDeployStore();
  let applies = 0;
  const deploy = createDeployService({
    deployStore,
    acl: createAclStore(),
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    deployDir: mkdtempSync(join(tmpdir(), "deploy-push-discovery-")),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => {
        applies++;
        return { host: "127.0.0.1", port: 9200 };
      },
      destroy: async () => {},
    },
  });
  const d = await deploy.deploy({
    ownerScopeId: owner,
    createdBy: "U1",
    entrypoint: "node s.js",
    files: [{ path: "s.js", data: "v1" }],
  });
  await deploy.archiveDeployment(d.id);

  await deploy.pushGit(d.id, async () => ({ result: undefined, ok: true }));

  assert.equal(applies, 1);
  assert.equal((await deployStore.get(d.id))!.status, "archived");
});
