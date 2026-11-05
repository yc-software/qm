import { test, type TestContext } from "node:test";
import { withTenant } from "../../src/tenants/context.ts";
import { TEST_TENANT } from "./test-tenant-id.ts";

export { TEST_TENANT };

export function tenantTest(name: string, fn: (t: TestContext) => void | Promise<void>): void {
  void test(name, (t) => withTenant(TEST_TENANT, () => fn(t)));
}
