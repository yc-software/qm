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
  assert.deepEqual(keys, [], "the initial create takes no deploy lock");

  await deploy.redeploy(d.id, { entrypoint: "y", files: [] });
  await deploy.rollbackDeployment(d.id, 1);
  await deploy.archiveDeployment(d.id);

  const want = `deploy:${d.id}`;
  assert.deepEqual(keys, [want, want, want], "redeploy, rollback, archive each lock deploy:<id>");
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
