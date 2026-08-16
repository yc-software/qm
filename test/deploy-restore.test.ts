import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeployStore, type DeployStore } from "../src/deploy/deploy-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { scopeId } from "../src/types.ts";

function harness(failRestore = false) {
  let applies = 0;
  let destroys = 0;
  const deploy = createDeployService({
    deployStore: createDeployStore(),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => {
        applies++;
        if (failRestore && applies > 1) throw new Error("runtime unavailable");
        return { host: "127.0.0.1", port: 20200 + applies };
      },
      destroy: async () => {
        destroys++;
      },
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "deploy-restore-")),
  });
  return { deploy, counts: () => ({ applies, destroys }) };
}

function persistenceFailureHarness(failMethod: "setVersionImage" | "markApplied") {
  const base = createDeployStore();
  let armed = false;
  let failed = false;
  const store = new Proxy(base, {
    get(target, property, receiver) {
      if (property !== failMethod) return Reflect.get(target, property, receiver);
      return async (...args: unknown[]) => {
        if (armed && !failed) {
          failed = true;
          throw new Error(`failed ${failMethod}`);
        }
        return (target[failMethod] as (...values: unknown[]) => Promise<void>)(...args);
      };
    },
  }) as DeployStore;
  let destroys = 0;
  let applies = 0;
  const deploy = createDeployService({
    deployStore: store,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 20300, image: `image:${++applies}` }),
      destroy: async () => {
        destroys++;
      },
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "deploy-restore-persistence-")),
  });
  return {
    deploy,
    arm: () => {
      armed = true;
    },
    destroys: () => destroys,
  };
}

test("restore reapplies the archived current version before marking it running", async () => {
  const { deploy, counts } = harness();
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "server.js",
    files: [],
  });
  await deploy.archiveDeployment(d.id);
  const restored = await deploy.restoreDeployment(d.id);

  assert.deepEqual(counts(), { applies: 2, destroys: 1 });
  assert.equal(restored.status, "running");
  assert.equal(restored.currentVersion, 1);
  assert.equal(restored.appliedVersion, 1);
  assert.equal(restored.endpoint?.port, 20202);
});

test("a failed restore leaves the deployment archived and unreachable", async () => {
  const { deploy, counts } = harness(true);
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "server.js",
    files: [],
  });
  await deploy.archiveDeployment(d.id);

  await assert.rejects(() => deploy.restoreDeployment(d.id), /runtime unavailable/);
  const after = (await deploy.listDeployments()).find((row) => row.id === d.id)!;
  assert.equal(after.status, "archived");
  assert.equal(after.endpoint, null);
  assert.deepEqual(counts(), { applies: 2, destroys: 2 });
  assert.equal((await deploy.reachDeployment(d.id, "U1")).status, "not_found");
});

test("an interrupted restore remains archived while cleanup is retried", async () => {
  const deployStore = createDeployStore();
  const deploy = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 20200 }),
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "deploy-restore-interrupted-")),
  });
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "server.js",
    files: [],
  });
  await deploy.archiveDeployment(d.id);
  await deployStore.markDeploying(d.id, 1);

  const interrupted = (await deployStore.get(d.id))!;
  assert.equal(interrupted.status, "archived");
  assert.equal(interrupted.deployingVersion, 1);
  assert.equal(await deploy.reapIdleDeployments(60_000), 0);
  const cleaned = (await deployStore.get(d.id))!;
  assert.equal(cleaned.status, "archived");
  assert.equal(cleaned.deployingVersion, undefined);
  assert.equal((await deploy.reachDeployment(d.id, "U1")).status, "not_found");
});

test("restore is idempotent for retries and concurrent callers", async () => {
  const { deploy } = harness();
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "server.js",
    files: [],
  });
  await deploy.archiveDeployment(d.id);
  const [first, second] = await Promise.all([deploy.restoreDeployment(d.id), deploy.restoreDeployment(d.id)]);
  assert.equal(first.status, "running");
  assert.equal(second.status, "running");
  assert.equal((await deploy.restoreDeployment(d.id)).status, "running");
});

test("restore uses the applied version when a legacy failed candidate was selected", async () => {
  const deployStore = createDeployStore();
  const applied: number[] = [];
  const deploy = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async (_deployment, version) => {
        applied.push(version.version);
        return { host: "127.0.0.1", port: 20200 + version.version };
      },
      destroy: async () => {},
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "deploy-restore-legacy-")),
  });
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "v1",
    files: [],
  });
  await deployStore.addVersion(d.id, { entrypoint: "v2", snapshotDir: "/legacy/v2" });
  await deployStore.setCurrentVersion(d.id, 2);
  await deploy.archiveDeployment(d.id);

  const restored = await deploy.restoreDeployment(d.id);

  assert.deepEqual(applied, [1, 1]);
  assert.equal(restored.currentVersion, 1);
  assert.equal(restored.appliedVersion, 1);
});

for (const failMethod of ["setVersionImage", "markApplied"] as const) {
  test(`restore destroys the runtime and remains archived when ${failMethod} fails`, async () => {
    const { deploy, arm, destroys } = persistenceFailureHarness(failMethod);
    const d = await deploy.deploy({
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      entrypoint: "server.js",
      files: [],
    });
    await deploy.archiveDeployment(d.id);
    arm();

    await assert.rejects(() => deploy.restoreDeployment(d.id), new RegExp(`failed ${failMethod}`));
    const after = (await deploy.listDeployments()).find((row) => row.id === d.id)!;
    assert.equal(destroys(), 2);
    assert.equal(after.status, "archived");
    assert.equal(after.endpoint, null);
  });
}
