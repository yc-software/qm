import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { scopeId } from "../src/types.ts";
import type { DeployProvider } from "../src/deploy/deploy-provider.ts";
import type { Deployment, DeploymentVersion } from "../src/deploy/deploy-store.ts";
const tmp = () => mkdtempSync(join(tmpdir(), "deployment-env-"));

function svc(deploymentEnv?: (deployment: Deployment) => Promise<Record<string, string>>) {
  const deployStore = createDeployStore();
  let applied: DeploymentVersion | undefined;
  const provider: DeployProvider = {
    profile: { managedScaleToZero: false },
    apply: async (_d, version) => {
      applied = version;
      return { host: "127.0.0.1", port: 5000 };
    },
    destroy: async () => {},
  };
  const service = createDeployService({
    deployStore,
    provider,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: tmp(),
    ...(deploymentEnv ? { deploymentEnv } : {}),
  });
  return {
    service,
    deployStore,
    get applied() {
      return applied;
    },
  };
}

test("deploy-service: deploymentEnv sees the deployment record and is merged into the version handed to the provider, never persisted", async () => {
  const s = svc(async (deployment) => ({
    AGENT_API_URL: "https://core",
    AGENT_CREDENTIAL_TOKEN: `tok-${deployment.id}-${deployment.createdBy}`,
  }));
  const d = await s.service.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node x",
    files: [],
  });
  assert.equal(s.applied?.env?.AGENT_CREDENTIAL_TOKEN, `tok-${d.id}-U1`, "provider sees the publisher-bound token");
  assert.equal(s.applied?.env?.AGENT_API_URL, "https://core");
  const stored = (await s.deployStore.get(d.id))!.versions[0]!;
  assert.equal(stored.env?.AGENT_CREDENTIAL_TOKEN, undefined, "the stored version record never holds the token");
});

test("deploy-service: without deploymentEnv the provider sees no deployment env", async () => {
  const s = svc();
  await s.service.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "node x", files: [] });
  assert.equal(s.applied?.env?.AGENT_CREDENTIAL_TOKEN, undefined);
});

test("deploy-service: redeploy inherits the current version's env and home files unless the input replaces them", async () => {
  const s = svc(async () => ({ VIEWER_IDENTITY_KEY: "viewer" }));
  const d = await s.service.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node x",
    files: [],
    homeFiles: [{ path: ".npmrc", data: "token" }],
    env: { DB_URL: "postgres://one" },
  });
  const versionAt = async (n: number) => (await s.deployStore.get(d.id))!.versions[n - 1]!;

  await s.service.redeploy(d.id, { entrypoint: "node x", files: [] });
  assert.deepEqual((await versionAt(2)).env, { DB_URL: "postgres://one" }, "omitted env inherits");
  assert.equal((await versionAt(2)).homeDir, (await versionAt(1)).homeDir, "omitted homeFiles inherit");
  assert.deepEqual(s.applied?.env, { DB_URL: "postgres://one", VIEWER_IDENTITY_KEY: "viewer" }, "deploymentEnv on top");

  await s.service.redeploy(d.id, { entrypoint: "node x", files: [], env: { DB_URL: "postgres://two" } });
  assert.deepEqual((await versionAt(3)).env, { DB_URL: "postgres://two" }, "provided env replaces");

  await s.service.redeploy(d.id, { entrypoint: "node x", files: [], env: {}, homeFiles: [] });
  assert.deepEqual((await versionAt(4)).env, {}, "an empty env clears");
  assert.equal((await versionAt(4)).homeDir, undefined, "empty homeFiles clear");
  assert.deepEqual(s.applied?.env, { VIEWER_IDENTITY_KEY: "viewer" });

  await s.service.rollbackDeployment(d.id, 3);
  await s.service.redeploy(d.id, { entrypoint: "node x", files: [] });
  assert.deepEqual((await versionAt(5)).env, { DB_URL: "postgres://two" }, "inherits from the rolled-back version");

  await s.service.redeploy(d.id, { entrypoint: "node x", files: [], stampEnv: { STAMP: "s" } });
  assert.deepEqual((await versionAt(6)).env, { DB_URL: "postgres://two", STAMP: "s" }, "stampEnv merges on top");
});
