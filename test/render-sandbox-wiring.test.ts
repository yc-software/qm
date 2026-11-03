import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { withTenant } from "../src/tenants/context.ts";
import { TenantSettingMissingError } from "../src/tenants/settings.ts";
import { testTenantSettings } from "./support/build-app.ts";
import { testTenants } from "./support/test-tenants.ts";
import { testConfig } from "./support/test-config.ts";

const [TEST_TENANT] = testTenants();

test("Render sandboxes can start without S3 storage configuration", async () => {
  const built = buildApp(
    testConfig({
      workspaceStore: "postgres",
      snapshotStore: "local",
      s3Bucket: undefined,
      renderSandbox: { image: `ghcr.io/yc-software/qm/sandbox-base:${"c".repeat(40)}@sha256:${"d".repeat(64)}` },
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
  const built = buildApp(testConfig({ workspaceStore: "postgres" }), {
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
