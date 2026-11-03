import { fakeSprites } from "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { inTestTenant, tenantTest } from "./support/test-tenants.ts";

tenantTest("startup adopts a cold environment target even when it has no session", async () => {
  const built = buildApp(testConfig());
  try {
    const scope = "personal:existing-environment";
    await inTestTenant(() =>
      built.app.createEnvironment({ scopeId: scope, name: "existing", actorId: "existing-environment" }),
    );
    await built.sandboxResources.initialize();
    const resource = await inTestTenant(() => built.sandboxResources.resolve(scope));
    assert.ok(resource?.legacy);
    assert.equal(resource.backingScopeId, scope);
    assert.equal(resource.ownerScopeId, scope);
    assert.equal(resource.state, "unverified");
    assert.deepEqual(fakeSprites.names(), []);
  } finally {
    await built.runtime.stop();
  }
});
