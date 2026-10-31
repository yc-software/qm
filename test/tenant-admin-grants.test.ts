import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { scopeId } from "../src/types.ts";
import { buildApp, testTenantSettings } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

test("admin grants are seeded from the tenant's ADMIN_GRANTS setting, not the environment", async () => {
  const saved = process.env.ADMIN_GRANTS;
  process.env.ADMIN_GRANTS = "env-admin@example.com:org_admin";
  try {
    const built = buildApp(testConfig({ databaseUrl: undefined }), {
      tenantSettings: testTenantSettings({ ADMIN_GRANTS: "tenant-admin@example.com:org_admin" }),
    });
    const target = scopeId("org", "default-org");
    assert.equal(await built.admin.canAdminister({ id: "tenant-admin@example.com", type: "internal" }, target), true);
    assert.equal(await built.admin.canAdminister({ id: "env-admin@example.com", type: "internal" }, target), false);
  } finally {
    if (saved === undefined) delete process.env.ADMIN_GRANTS;
    else process.env.ADMIN_GRANTS = saved;
  }
});
