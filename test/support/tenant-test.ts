import { test, type TestContext } from "node:test";
import { withTenant } from "../../src/tenants/context.ts";

export const TEST_TENANT = "00000000-0000-4000-8000-000000000001";

export function tenantTest(name: string, fn: (t: TestContext) => void | Promise<void>): void {
  void test(name, (t) => withTenant(TEST_TENANT, () => fn(t)));
}
