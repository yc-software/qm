import { test } from "node:test";
import assert from "node:assert/strict";
import { createDisabledDeployProvider } from "../src/deploy/disabled-deploy-provider.ts";
import type { Deployment, DeploymentVersion } from "../src/deploy/deploy-store.ts";

test("disabled deploy provider fails closed without requiring Docker", async () => {
  const provider = createDisabledDeployProvider();
  const version: DeploymentVersion = { version: 1, createdAt: 0, entrypoint: "node app.js", snapshotDir: "/tmp/app" };
  const deployment: Deployment = {
    id: "deployment-1",
    ownerScopeId: "org:test",
    createdBy: "tester",
    currentVersion: 1,
    status: "stopped",
    endpoint: null,
    versions: [version],
  };

  assert.equal(provider.profile.managedScaleToZero, true);
  await assert.rejects(provider.apply(deployment, version), /Hosted app deployments are disabled/);
  await assert.doesNotReject(provider.destroy(deployment));
});
