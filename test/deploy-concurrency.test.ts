import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import type { LeaderLease } from "../src/persistence/leader-lease.ts";
import type { AdvisoryLock } from "../src/persistence/advisory-lock.ts";
import type { DeployProvider } from "../src/deploy/deploy-provider.ts";
import { scopeId } from "../src/types.ts";

const nonLeaderLease: LeaderLease = {
  async hold() {
    return null;
  },
};

function svc(opts: { lease?: LeaderLease; lock?: AdvisoryLock; managed?: boolean } = {}) {
  const deployStore = createDeployStore();
  let destroys = 0;
  const provider: DeployProvider = {
    profile: { managedScaleToZero: opts.managed ?? false },
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
    deployDir: mkdtempSync(join(tmpdir(), "concurrency-")),
    ...(opts.lease ? { leaderLease: opts.lease } : {}),
    ...(opts.lock ? { advisoryLock: opts.lock } : {}),
  });
  return {
    deploy,
    deployStore,
    get destroys() {
      return destroys;
    },
  };
}

const future = Date.now() + 1_000_000;

test("reaper: a non-leader skips the sweep — returns 0 and destroys nothing", async () => {
  const { deploy, deployStore, destroys } = svc({ lease: nonLeaderLease });
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  const stopped = await deploy.reapIdleDeployments(60_000, future);
  assert.equal(stopped, 0, "non-leader returns 0");
  assert.equal(destroys, 0, "non-leader destroyed nothing");
  assert.equal((await deployStore.get(d.id))!.status, "running", "the deployment stays running");
});

test("reaper: the leader (default no-op lease) reaps as before", async () => {
  const { deploy, deployStore } = svc();
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  const stopped = await deploy.reapIdleDeployments(60_000, future);
  assert.equal(stopped, 1, "the leader reaps the idle deployment");
  assert.equal((await deployStore.get(d.id))!.status, "stopped");
  assert.equal((await deployStore.get(d.id))!.endpoint, null);
});

test("archive succeeds durably and reaper retries terminal runtime cleanup after provider failure", async () => {
  const deployStore = createDeployStore();
  let destroys = 0;
  const deploy = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 5000 }),
      destroy: async () => {
        if (++destroys === 1) throw new Error("destroy failed");
      },
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "reaper-cleanup-")),
  });
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });

  await deploy.archiveDeployment(d.id);
  const pending = (await deployStore.get(d.id))!;
  assert.equal(pending.status, "archived");
  assert.notEqual(pending.endpoint, null);

  assert.equal(await deploy.reapIdleDeployments(60_000, future), 0);
  const cleaned = (await deployStore.get(d.id))!;
  assert.equal(cleaned.status, "archived");
  assert.equal(cleaned.endpoint, null);
  assert.equal(destroys, 2);
});

test("reaper continues after one deployment cleanup fails", async () => {
  const deployStore = createDeployStore();
  let blockedId = "";
  const deploy = createDeployService({
    deployStore,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 5000 }),
      destroy: async (deployment) => {
        if (deployment.id === blockedId) throw new Error("destroy failed");
      },
    },
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "reaper-continues-")),
  });
  const first = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "one",
    files: [],
  });
  const second = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "two",
    files: [],
  });
  blockedId = first.id;

  assert.equal(await deploy.reapIdleDeployments(60_000, future), 1);
  assert.notEqual((await deployStore.get(first.id))!.endpoint, null);
  assert.equal((await deployStore.get(second.id))!.endpoint, null);
});

function spyLock(): { lock: AdvisoryLock; keys: string[] } {
  const keys: string[] = [];
  const lock: AdvisoryLock = {
    async withLock(key, fn) {
      keys.push(key);
      return fn();
    },
  };
  return { lock, keys };
}

test("withDeployLock: redeploy/rollback/archive each acquire the advisory mutex keyed deploy:<id>", async () => {
  const { lock, keys } = spyLock();
  const { deploy } = svc({ lock });
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  const want = `deploy:${d.id}`;
  assert.deepEqual(keys, [want], "the initial activation locks deploy:<id>");

  await deploy.redeploy(d.id, { entrypoint: "y", files: [] });
  await deploy.rollbackDeployment(d.id, 1);
  await deploy.archiveDeployment(d.id);

  assert.deepEqual(keys, [want, want, want, want], "every activation and archive locks deploy:<id>");
});

test("withDeployLock: same-instance lifecycle ops still serialize (no overlap)", async () => {
  const deployStore = createDeployStore();
  let active = 0;
  let maxActive = 0;
  const provider: DeployProvider = {
    profile: { managedScaleToZero: false },
    apply: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return { host: "127.0.0.1", port: 5000 };
    },
    destroy: async () => {},
  };
  const deploy = createDeployService({
    deployStore,
    provider,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "serialize-")),
  });
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  await Promise.all([
    deploy.redeploy(d.id, { entrypoint: "a", files: [] }),
    deploy.redeploy(d.id, { entrypoint: "b", files: [] }),
  ]);
  assert.equal(maxActive, 1, "two redeploys on one deployment never ran apply() concurrently");
});
