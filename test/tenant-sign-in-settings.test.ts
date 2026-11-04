import assert from "node:assert/strict";
import { test } from "node:test";
import { withTenant } from "../src/tenants/context.ts";
import { configureTenantSettings, tenantAllowedEmails, tenantSettings } from "../src/tenants/settings.ts";

const TENANT_A = "0f0e7c34-6d3b-4c1a-9a51-6a1f6a0c0a01";
const TENANT_B = "0f0e7c34-6d3b-4c1a-9a51-6a1f6a0c0b02";

test("each tenant reads only its own sign-in allowlist, and a tenant without one reads none", async (t) => {
  configureTenantSettings(async (tenant) =>
    tenant === TENANT_A ? { env: { AUTH_ALLOWED_EMAILS: " Alice@A.example ,alice@a.example" } } : {},
  );
  t.after(() => configureTenantSettings(undefined));
  const read = (tenant: string) =>
    withTenant(tenant, async () => {
      await tenantSettings();
      return tenantAllowedEmails();
    });
  assert.deepEqual(await read(TENANT_A), ["alice@a.example"]);
  assert.equal(await read(TENANT_B), undefined);
  assert.equal(tenantAllowedEmails(), undefined);
});
