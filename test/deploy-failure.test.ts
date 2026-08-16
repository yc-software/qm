import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeployStore, type Deployment } from "../src/deploy/deploy-store.ts";
import type { DeployProvider } from "../src/deploy/deploy-provider.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";

const deployInput = (entrypoint: string) => ({
  ownerScopeId: scopeId("personal", "U1"),
  createdBy: "U1",
  entrypoint,
  files: [{ path: "app.js", data: entrypoint }],
});

function service(provider: DeployProvider) {
  const deployments = createMemoryMap<Deployment>();
  const deployStore = createDeployStore(deployments);
  const deploy = createDeployService({
    deployStore,
    provider,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "deploy-failure-")),
  });
  return { deploy, deployStore, deployments };
}

test("an initial provider failure is durably represented and can be retried", async () => {
  let fail = true;
  const { deploy, deployments } = service({
    profile: { managedScaleToZero: false },
    apply: async () => {
      if (fail) throw new Error("provider apply failed");
      return { host: "127.0.0.1", port: 5000 };
    },
    destroy: async () => {},
  });

  await assert.rejects(deploy.deploy(deployInput("v1")), /provider apply failed/);
  const failed = (await deployments.all())[0]!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.endpoint, null);
  assert.equal(failed.currentVersion, 1);
  assert.equal(failed.appliedVersion, undefined);
  assert.equal(failed.versions.length, 1);

  fail = false;
  const retried = await deploy.redeploy(failed.id, deployInput("v2"));
  assert.equal(retried.status, "running");
  assert.equal(retried.currentVersion, 2);
  assert.equal(retried.appliedVersion, 2);
});

test("a legacy never-applied stopped deployment is normalized to failed", async () => {
  let destroys = 0;
  const { deploy, deployStore } = service({
    profile: { managedScaleToZero: false },
    apply: async () => ({ host: "127.0.0.1", port: 5000 }),
    destroy: async () => {
      destroys++;
    },
  });
  const orphan = await deployStore.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "v1",
    snapshotDir: "/legacy/v1",
    files: [{ path: "app.js", data: "v1" }],
  });

  const normalized = (await deployStore.get(orphan.id))!;

  assert.equal(normalized.status, "failed");
  assert.equal(normalized.appliedVersion, undefined);
  assert.equal(normalized.deployingVersion, 1);
  assert.equal(await deploy.reapIdleDeployments(60_000), 0);
  assert.equal(destroys, 1);
  assert.equal((await deployStore.get(orphan.id))!.deployingVersion, undefined);
});

test("a legacy stopped deployment with an endpoint is cleaned as interrupted", async () => {
  let destroys = 0;
  const { deploy, deployStore } = service({
    profile: { managedScaleToZero: false },
    apply: async () => ({ host: "127.0.0.1", port: 5000 }),
    destroy: async () => {
      destroys++;
    },
  });
  const orphan = await deployStore.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "v1",
    snapshotDir: "/legacy/v1",
    files: [{ path: "app.js", data: "v1" }],
  });
  await deployStore.setEndpoint(orphan.id, { host: "127.0.0.1", port: 5000 });

  assert.equal(await deploy.reapIdleDeployments(60_000), 0);
  assert.equal(destroys, 1);
  const cleaned = (await deployStore.get(orphan.id))!;
  assert.equal(cleaned.status, "failed");
  assert.equal(cleaned.endpoint, null);
  assert.equal(cleaned.deployingVersion, undefined);
});

test("repeated reconcile failures never select an unusable version and a later retry succeeds", async () => {
  let reconciles = 0;
  const { deploy } = service({
    profile: { managedScaleToZero: false },
    apply: async () => assert.fail("reconcile should handle committed versions"),
    reconcile: async (_deployment, version) => {
      reconciles++;
      if (reconciles === 2 || reconciles === 3) throw new Error("provider reconcile failed");
      if (reconciles === 4) {
        assert.equal(readFileSync(join(version.snapshotDir, "app.js"), "utf8"), "v2");
        assert.equal(readFileSync(join(version.homeDir!, ".provider/session"), "utf8"), "same");
      }
      return { host: "127.0.0.1", port: 5000 + reconciles };
    },
    destroy: async () => {},
  });

  const initial = await deploy.deploy(deployInput("v1"));
  const retryInput = {
    ...deployInput("v2"),
    homeFiles: [{ path: ".provider/session", data: "same" }],
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(deploy.redeploy(initial.id, retryInput), /provider reconcile failed/);
    const failed = (await deploy.getDeployment(initial.id))!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.endpoint, null);
    assert.equal(failed.currentVersion, 1);
    assert.equal(failed.appliedVersion, 1);
    assert.equal(failed.versions.length, 2);
    const candidate = failed.versions.find((version) => version.version === 2)!;
    rmSync(candidate.snapshotDir, { recursive: true, force: true });
    rmSync(candidate.homeDir!, { recursive: true, force: true });
  }

  const retried = await deploy.redeploy(initial.id, retryInput);
  assert.equal(retried.status, "running");
  assert.equal(retried.currentVersion, 2);
  assert.equal(retried.appliedVersion, 2);
  assert.equal(retried.versions.length, 2);
});

test("archive persists terminal state before destroying an interrupted runtime", async () => {
  const holder: { deployStore?: ReturnType<typeof createDeployStore> } = {};
  const stateDuringDestroy: Partial<Deployment> = {};
  const setup = service({
    profile: { managedScaleToZero: false },
    apply: async () => ({ host: "127.0.0.1", port: 5000 }),
    destroy: async (deployment) => {
      Object.assign(stateDuringDestroy, await holder.deployStore!.get(deployment.id));
    },
  });
  holder.deployStore = setup.deployStore;
  const interrupted = await setup.deployStore.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "v1",
    snapshotDir: "/interrupted/v1",
    files: [{ path: "app.js", data: "v1" }],
  });
  await setup.deployStore.markDeploying(interrupted.id, 1);

  await setup.deploy.archiveDeployment(interrupted.id);

  assert.equal(stateDuringDestroy?.status, "archived");
  assert.equal(stateDuringDestroy?.endpoint, null);
  assert.equal(stateDuringDestroy?.deployingVersion, 1);
  assert.equal((await setup.deployStore.get(interrupted.id))!.deployingVersion, undefined);
});

test("reach cleans an interrupted activation without replaying ephemeral inputs", async () => {
  let applies = 0;
  const { deploy, deployStore } = service({
    profile: { managedScaleToZero: false },
    apply: async () => {
      applies++;
      return { host: "127.0.0.1", port: 5000 };
    },
    destroy: async () => {},
  });
  const interrupted = await deployStore.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "v1",
    snapshotDir: "/interrupted/v1",
    files: [{ path: "app.js", data: "v1" }],
  });
  await deployStore.markDeploying(interrupted.id, 1);

  const reached = await deploy.reachDeployment(interrupted.id, "U1");

  assert.equal(reached.status, "not_found");
  assert.equal(applies, 0);
  const recovered = (await deploy.getDeployment(interrupted.id))!;
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.appliedVersion, undefined);
  assert.equal(recovered.deployingVersion, undefined);
});

test("reach recovers the applied version after cleaning an interrupted redeploy", async () => {
  let applies = 0;
  const { deploy, deployStore } = service({
    profile: { managedScaleToZero: false },
    apply: async () => ({ host: "127.0.0.1", port: 5000 + ++applies }),
    destroy: async () => {},
  });
  const initial = await deploy.deploy(deployInput("v1"));
  await deployStore.addVersion(initial.id, {
    entrypoint: "v2",
    snapshotDir: "/interrupted/v2",
    files: [{ path: "app.js", data: "v2" }],
  });

  const reached = await deploy.reachDeployment(initial.id, "U1");

  assert.equal(reached.status, "ok");
  assert.equal(applies, 2);
  const recovered = (await deploy.getDeployment(initial.id))!;
  assert.equal(recovered.status, "running");
  assert.equal(recovered.currentVersion, 1);
  assert.equal(recovered.appliedVersion, 1);
  assert.equal(recovered.deployingVersion, undefined);
});

test("reaper retries cleanup of an endpoint-less partial activation", async () => {
  let destroys = 0;
  const { deploy, deployments } = service({
    profile: { managedScaleToZero: false },
    apply: async () => {
      throw new Error("partial provider failure");
    },
    destroy: async () => {
      if (++destroys === 1) throw new Error("cleanup failure");
    },
  });

  await assert.rejects(deploy.deploy(deployInput("v1")), /partial provider failure/);
  const pending = (await deployments.all())[0]!;
  assert.equal(pending.status, "failed");
  assert.equal(pending.endpoint, null);
  assert.equal(pending.deployingVersion, 1);

  assert.equal(await deploy.reapIdleDeployments(60_000), 0);
  const cleaned = (await deployments.all())[0]!;
  assert.equal(cleaned.status, "failed");
  assert.equal(cleaned.deployingVersion, undefined);
  assert.equal(destroys, 2);
});

test("a transient lazy restart failure is retried on the next reach", async () => {
  let applies = 0;
  const { deploy } = service({
    profile: { managedScaleToZero: false },
    apply: async () => {
      applies++;
      if (applies === 2) throw new Error("restart failed");
      return { host: "127.0.0.1", port: 5000 + applies };
    },
    resolveEndpoint: async () => null,
    destroy: async () => {},
  });
  const initial = await deploy.deploy(deployInput("v1"));

  await assert.rejects(deploy.reachDeployment(initial.id, "U1"), /restart failed/);
  assert.equal((await deploy.getDeployment(initial.id))!.status, "failed");

  const reached = await deploy.reachDeployment(initial.id, "U1");
  assert.equal(reached.status, "ok");
  assert.equal(applies, 3);
  assert.equal((await deploy.getDeployment(initial.id))!.status, "running");
});

test("a failed update backfills the applied version of a legacy running deployment", async () => {
  let fail = false;
  const { deploy, deployments } = service({
    profile: { managedScaleToZero: false },
    apply: async () => {
      if (fail) throw new Error("provider apply failed");
      return { host: "127.0.0.1", port: 5000 };
    },
    destroy: async () => {},
  });
  const legacy = await deploy.deploy(deployInput("v1"));
  await deployments.merge(legacy.id, { appliedVersion: undefined });
  fail = true;

  await assert.rejects(deploy.redeploy(legacy.id, deployInput("v2")), /provider apply failed/);
  const failed = (await deploy.getDeployment(legacy.id))!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.currentVersion, 1);
  assert.equal(failed.appliedVersion, 1);

  fail = false;
  const reached = await deploy.reachDeployment(legacy.id, "U1");
  assert.equal(reached.status, "ok");
  assert.equal((await deploy.getDeployment(legacy.id))!.status, "running");
});
