import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import type { DeployProvider } from "../src/deploy/deploy-provider.ts";
import type { DeployEndpoint } from "../src/deploy/deploy-store.ts";
import { scopeId } from "../src/types.ts";

function svc(opts: { managedScaleToZero?: boolean; resolve?: () => Promise<DeployEndpoint | null> } = {}) {
  const deployStore = createDeployStore();
  let applies = 0;
  let resolves = 0;
  const provider: DeployProvider = {
    profile: { managedScaleToZero: opts.managedScaleToZero ?? true },
    apply: async () => {
      applies++;
      return { host: "127.0.0.1", port: 5000 };
    },
    destroy: async () => {},
    ...(opts.resolve
      ? {
          resolveEndpoint: async () => {
            resolves++;
            return opts.resolve!();
          },
        }
      : {}),
  };
  const deploy = createDeployService({
    deployStore,
    provider,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "always-on-")),
  });
  return {
    deploy,
    deployStore,
    get applies() {
      return applies;
    },
    get resolves() {
      return resolves;
    },
  };
}

const owner = { ownerScopeId: scopeId("personal", "U1"), createdBy: "U1" };

test("setDeploymentAlwaysOn flips the flag on and off, and persists", async () => {
  const { deploy, deployStore } = svc();
  const d = await deploy.deploy({ ...owner, entrypoint: "x", files: [] });
  assert.equal((await deployStore.get(d.id))!.alwaysOn, undefined);

  const on = await deploy.setDeploymentAlwaysOn(d.id, true);
  assert.equal(on.alwaysOn, true);
  assert.equal((await deployStore.get(d.id))!.alwaysOn, true);

  const off = await deploy.setDeploymentAlwaysOn(d.id, false);
  assert.ok(!off.alwaysOn);
  assert.ok(!(await deployStore.get(d.id))!.alwaysOn);
});

test("deployOrUpdate carries alwaysOn on create and on update", async () => {
  const { deploy, deployStore } = svc();
  const d = await deploy.deployOrUpdate({ ...owner, name: "warm-app", entrypoint: "x", files: [], alwaysOn: true });
  assert.equal((await deployStore.get(d.id))!.alwaysOn, true);

  await deploy.deployOrUpdate({ ...owner, name: "warm-app", entrypoint: "x", files: [] });
  assert.equal((await deployStore.get(d.id))!.alwaysOn, true);

  await deploy.deployOrUpdate({ ...owner, name: "warm-app", entrypoint: "x", files: [], alwaysOn: false });
  assert.ok(!(await deployStore.get(d.id))!.alwaysOn);
});

test("alwaysOn is visible to the provider at first launch (not applied after the fact)", async () => {
  const deployStore = createDeployStore();
  const seen: Array<boolean | undefined> = [];
  const provider: DeployProvider = {
    profile: { managedScaleToZero: true },
    apply: async (d) => {
      seen.push(d.alwaysOn);
      return { host: "127.0.0.1", port: 5000 };
    },
    destroy: async () => {},
  };
  const deploy = createDeployService({
    deployStore,
    provider,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "always-on-")),
  });
  await deploy.deployOrUpdate({ ...owner, name: "warm-launch", entrypoint: "x", files: [], alwaysOn: true });
  assert.deepEqual(seen, [true]);
});

test("rename and rollback branches carry alwaysOn too", async () => {
  const { deploy, deployStore } = svc();
  const d = await deploy.deployOrUpdate({ ...owner, name: "app-a", entrypoint: "x", files: [] });
  await deploy.deployOrUpdate({ ...owner, name: "app-a", entrypoint: "x", files: [] });

  await deploy.deployOrUpdate({ ...owner, name: "app-b", renameFrom: "app-a", alwaysOn: true });
  assert.equal((await deployStore.get(d.id))!.alwaysOn, true);

  await deploy.deployOrUpdate({ ...owner, name: "app-b", rollbackTo: 1, alwaysOn: false });
  assert.ok(!(await deployStore.get(d.id))!.alwaysOn);
});

test("reaper re-checks alwaysOn under the deploy lock (no stale-snapshot destroy)", async () => {
  const deployStore = createDeployStore();
  let destroys = 0;
  const provider: DeployProvider = {
    profile: { managedScaleToZero: false },
    apply: async () => ({ host: "127.0.0.1", port: 5000 }),
    destroy: async () => {
      destroys++;
    },
  };
  const deploy = createDeployService({
    deployStore,
    provider,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "always-on-")),
  });
  const d = await deploy.deploy({ ...owner, entrypoint: "x", files: [] });

  const realList = deployStore.list.bind(deployStore);
  deployStore.list = async () => {
    const snapshot = (await realList()).map((x) => ({ ...x, alwaysOn: undefined }));
    await deployStore.setAlwaysOn(d.id, true);
    return snapshot;
  };
  const stopped = await deploy.reapIdleDeployments(1, Date.now() + 1_000_000);
  assert.equal(stopped, 0);
  assert.equal(destroys, 0);
  assert.equal((await deployStore.get(d.id))!.status, "running");
});

test("keepAlwaysOnWarm re-ensures a live endpoint only for running always-on deployments", async () => {
  const ctx = svc({ resolve: async () => ({ host: "127.0.0.1", port: 5001 }) });
  const { deploy } = ctx;
  const cold = await deploy.deploy({ ...owner, entrypoint: "x", files: [] });
  const warm = await deploy.deploy({ ...owner, entrypoint: "x", files: [] });
  await deploy.setDeploymentAlwaysOn(warm.id, true);
  const resolvesBefore = ctx.resolves;

  const warmed = await deploy.keepAlwaysOnWarm();
  assert.equal(warmed, 1);
  assert.equal(ctx.resolves, resolvesBefore + 1);
  assert.ok(cold.id !== warm.id);
});

test("keepAlwaysOnWarm skips a deployment whose flag was turned off after the list snapshot", async () => {
  const ctx = svc({ resolve: async () => null });
  const { deploy, deployStore } = ctx;
  const d = await deploy.deploy({ ...owner, entrypoint: "x", files: [] });
  await deploy.setDeploymentAlwaysOn(d.id, true);
  const realList = deployStore.list.bind(deployStore);
  deployStore.list = async () => {
    const snapshot = await realList();
    await deployStore.setAlwaysOn(d.id, false);
    return snapshot;
  };
  const appliesBefore = ctx.applies;
  const warmed = await deploy.keepAlwaysOnWarm();
  assert.equal(warmed, 0);
  assert.equal(ctx.applies, appliesBefore);
});

test("keepAlwaysOnWarm relaunches when the platform has torn the app down", async () => {
  const ctx = svc({ resolve: async () => null });
  const { deploy, deployStore } = ctx;
  const d = await deploy.deploy({ ...owner, entrypoint: "x", files: [] });
  await deploy.setDeploymentAlwaysOn(d.id, true);
  const appliesBefore = ctx.applies;

  const warmed = await deploy.keepAlwaysOnWarm();
  assert.equal(warmed, 1);
  assert.ok(ctx.applies > appliesBefore, "expected a re-apply when no live endpoint exists");
  assert.equal((await deployStore.get(d.id))!.status, "running");
});
