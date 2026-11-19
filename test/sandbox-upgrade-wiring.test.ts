import { fakeSprites } from "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

test("startup adopts a cold environment target even when it has no session", async () => {
  const built = buildApp(testConfig());
  try {
    const scope = "personal:existing-environment";
    await built.app.createEnvironment({ scopeId: scope, name: "existing", actorId: "existing-environment" });
    await built.sandboxResources.initialize();
    assert.equal(await built.sandboxResources.resolve(scope), null);
    const resources = await built.sandboxResources.list("existing-environment", scope);
    assert.equal(resources.defaultSandboxId, null);
    const resource = resources.sandboxes.find((item) => item.backingScopeId === scope);
    assert.ok(resource?.legacy);
    assert.equal(resource.backingScopeId, scope);
    assert.equal(resource.ownerScopeId, scope);
    assert.equal(resource.state, "unverified");
    assert.equal(resource.personalOnly, true);
    assert.deepEqual(fakeSprites.names(), []);
  } finally {
    await built.runtime.stop();
  }
});
