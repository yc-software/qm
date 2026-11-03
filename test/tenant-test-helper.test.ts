import { test } from "node:test";
import assert from "node:assert/strict";
import { boundTenant } from "../src/tenants/context.ts";
import { tenantTest, testTenants } from "./support/test-tenants.ts";

test("plain tests run unbound", () => {
  assert.equal(boundTenant(), undefined);
});

tenantTest("tenantTest binds the test tenant across awaits", async () => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(boundTenant(), testTenants()[0]);
});

tenantTest("tenantTest passes options and the test context through", { timeout: 5000 }, async (t) => {
  await t.test("subtests inherit the binding", () => assert.equal(boundTenant(), testTenants()[0]));
});
