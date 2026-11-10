import { test, type TestContext } from "node:test";
import { withTenant } from "../../src/tenants/context.ts";
import { loadTenantSettings, noteTenantAppHandle } from "../../src/tenants/settings.ts";
import { TEST_TENANT } from "./test-tenant-id.ts";

export const TEST_APP_HANDLE = "acme1";

export function asCompany<T>(fn: () => Promise<T>): Promise<T> {
  return withTenant(TEST_TENANT, async () => {
    noteTenantAppHandle(TEST_APP_HANDLE);
    try {
      return await fn();
    } finally {
      await loadTenantSettings({ q: async () => [] });
    }
  });
}

export function companyTest(name: string, fn: (t: TestContext) => Promise<void>): void {
  void test(name, (t) => asCompany(() => fn(t)));
}
