import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { withTenant } from "../src/tenants/context.ts";
import { TenantSettingMissingError } from "../src/tenants/settings.ts";
import { TEST_TENANT, testTenantSettings } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { bindTestTenant } from "./support/tenant.ts";

bindTestTenant();

test("Render sandboxes can start without S3 storage configuration", async () => {
  const built = buildApp(
    testConfig({
      workspaceStore: "postgres",
      databaseUrl: "postgres://unused/unused",
      snapshotStore: "local",
      s3Bucket: undefined,
    }),
    {
      tenantSettings: testTenantSettings({
        SANDBOX_BACKEND: "render",
        RENDER_SANDBOX_API_KEY: "render-test-key",
        RENDER_SANDBOX_WORKSPACE_ID: "tea-test",
      }),
    },
  );
  try {
    assert.equal(await withTenant(TEST_TENANT, () => built.sandboxResources.defaultBackend()), "render");
  } finally {
    await built.runtime.stop();
  }
});

test("a tenant's default sandbox backend fails closed without that provider's keys", async () => {
  const built = buildApp(testConfig({ workspaceStore: "postgres", databaseUrl: "postgres://unused/unused" }), {
    tenantSettings: testTenantSettings({ SANDBOX_BACKEND: "render", RENDER_SANDBOX_API_KEY: "render-test-key" }),
  });
  try {
    await assert.rejects(
      withTenant(TEST_TENANT, () => built.sandboxResources.defaultBackend()),
      (error: unknown) =>
        error instanceof TenantSettingMissingError &&
        error.message === "RENDER_SANDBOX_WORKSPACE_ID is not set in this tenant's settings",
    );
    assert.deepEqual(
      (await withTenant(TEST_TENANT, () => built.sandboxResources.profiles())).map((profile) => profile.name).sort(),
      ["sprites"],
    );
  } finally {
    await built.runtime.stop();
  }
});
