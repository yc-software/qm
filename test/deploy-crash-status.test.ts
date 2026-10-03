import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/app.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createDirectoryStore } from "../src/directory/directory-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { DeployProvider, DeployRunState } from "../src/deploy/deploy-provider.ts";
import { scopeId } from "../src/types.ts";

function harness(opts: { managedScaleToZero?: boolean; runState?: () => Promise<DeployRunState | null> } = {}) {
  const container = { alive: true, probes: 0, applies: 0 };
  const provider: DeployProvider = {
    profile: { managedScaleToZero: opts.managedScaleToZero ?? false },
    apply: async () => {
      container.applies++;
      container.alive = true;
      return { host: "127.0.0.1", port: 5000 };
    },
    destroy: async () => {},
    logs: async () => "boot failed: cannot find module",
    runState: async () => {
      container.probes++;
      if (opts.runState) return opts.runState();
      return container.alive ? { running: true } : { running: false, exitCode: 7 };
    },
  };
  const deployStore = createDeployStore();
  const acl = createAclStore();
  const deploy = createDeployService({
    deployStore,
    provider,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl,
    deployDir: mkdtempSync(join(tmpdir(), "deploy-crash-")),
  });
  const app = createApp({
    deploy,
    acl,
    directory: createDirectoryStore(),
    sessions: createMemorySessionStore(),
    identity: createIdentityService(),
  } as unknown as Parameters<typeof createApp>[0]);
  const publish = () =>
    deploy.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "x", files: [] });
  return { deploy, deployStore, app, container, publish };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("an explicit viewer read records an exited container as crashed, keeps its logs, and shows diagnostics only to readers", async () => {
  const { app, deployStore, container, publish } = harness();
  const d = await publish();
  container.alive = false;

  const [seen] = await app.listDeploymentsForViewer("U1");
  assert.equal(seen?.status, "crashed");
  assert.equal(seen?.crash?.exitCode, 7);
  assert.equal((await deployStore.get(d.id))!.status, "crashed");
  assert.deepEqual(await app.deploymentLogsFor(d.id, "U1", { tailLines: 50 }), {
    status: "ok",
    logs: "boot failed: cannot find module",
  });
  assert.deepEqual(await app.listDeploymentsForViewer("U-stranger"), []);
  assert.equal((await app.deploymentLogsFor(d.id, "U-stranger", { tailLines: 50 })).status, "denied");
});

test("capability auth and internal lookups read the stored row without probing the provider", async () => {
  const { app, deploy, container, publish } = harness();
  const d = await publish();
  container.alive = false;

  await app.getDeployment(d.id);
  await app.getDeployment(d.name ?? d.id);
  await deploy.listDeployments();
  await app.reachDeployment(d.id, "U1");
  assert.equal(container.probes, 0);
  assert.equal((await app.getDeployment(d.id))!.status, "running");
});

test("repeated viewer reads share one bounded probe while the container stays up", async () => {
  const { app, container, publish } = harness();
  await publish();

  await Promise.all([app.listDeploymentsForViewer("U1"), app.listDeploymentsForViewer("U1")]);
  await app.listDeploymentsForViewer("U1");
  assert.equal(container.probes, 1);
});

test("no signal, a transient probe failure, or a managed platform never records a crash", async () => {
  for (const opts of [
    { runState: async () => null },
    {
      runState: async () => {
        throw new Error("docker daemon unavailable");
      },
    },
    { managedScaleToZero: true, runState: async () => ({ running: false, exitCode: 1 }) },
  ]) {
    const { deploy, deployStore, publish } = harness(opts);
    const d = await publish();
    assert.equal((await deploy.refreshRunState(d)).status, "running");
    assert.equal((await deployStore.get(d.id))!.status, "running");
  }
});

test("a stale exited probe cannot mark a same-version restart that finished first as crashed", async () => {
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => (release = resolve));
  const { deploy, deployStore, container, publish } = harness({
    runState: async () => {
      const alive = container.alive;
      if (container.probes === 1) await stalled;
      return alive ? { running: true } : { running: false, exitCode: 7 };
    },
  });
  const d = await publish();
  container.alive = false;

  const read = deploy.refreshRunState(d);
  await deploy.rollbackDeployment(d.id, 1);
  assert.equal(container.applies, 2);
  release();
  const after = await read;

  assert.equal(after.status, "running");
  assert.equal(after.appliedVersion, 1);
  assert.equal((await deployStore.get(d.id))!.status, "running");
  assert.equal(container.probes, 2);
});

test("a same-version restart queued behind an in-flight crash record still ends running with the crash cleared", async () => {
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => (release = resolve));
  const { deploy, deployStore, container, publish } = harness({
    runState: async () => {
      if (container.probes === 2) await stalled;
      return { running: false, exitCode: 7 };
    },
  });
  const d = await publish();
  container.alive = false;

  const read = deploy.refreshRunState(d);
  while (container.probes < 2) await settle();
  const restart = deploy.rollbackDeployment(d.id, 1);
  await settle();
  assert.equal(container.applies, 1);
  release();
  assert.equal((await read).status, "crashed");
  await restart;

  const final = (await deployStore.get(d.id))!;
  assert.equal(final.status, "running");
  assert.equal(final.crash, undefined);
});

test("keep-warm skips a crashed always-on app instead of reporting it warm", async () => {
  const { deploy, deployStore, container, publish } = harness();
  const d = await publish();
  await deploy.setDeploymentAlwaysOn(d.id, true);
  container.alive = false;

  assert.equal(await deploy.keepAlwaysOnWarm(), 0);
  assert.equal((await deployStore.get(d.id))!.status, "crashed");
  assert.equal(container.applies, 1);
});
