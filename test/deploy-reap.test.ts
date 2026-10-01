import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import type { DeployProvider } from "../src/deploy/deploy-provider.ts";
import { scopeId } from "../src/types.ts";

function svc(managedScaleToZero: boolean) {
  const deployStore = createDeployStore();
  let destroys = 0;
  const provider: DeployProvider = {
    profile: { managedScaleToZero },
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
    deployDir: mkdtempSync(join(tmpdir(), "reap-")),
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

test("unmanaged provider: an idle deployment is reaped (destroyed, stopped, endpoint cleared)", async () => {
  const { deploy, deployStore } = svc(false);
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  assert.equal((await deployStore.get(d.id))!.status, "running");

  const stopped = await deploy.reapIdleDeployments(60_000, future);
  assert.equal(stopped, 1);
  assert.equal((await deployStore.get(d.id))!.status, "stopped");
  assert.equal((await deployStore.get(d.id))!.endpoint, null);
});

test("managed provider: reap is a no-op — the platform sleeps/wakes it, endpoint stays valid", async () => {
  const { deploy, deployStore, destroys } = svc(true);
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });

  const stopped = await deploy.reapIdleDeployments(60_000, future);
  assert.equal(stopped, 0);
  assert.equal(destroys, 0);
  assert.equal((await deployStore.get(d.id))!.status, "running");
  assert.deepEqual((await deployStore.get(d.id))!.endpoint, { host: "127.0.0.1", port: 5000 });
});
