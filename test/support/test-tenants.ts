import { it as nodeIt, test as nodeTest, type TestContext, type TestOptions } from "node:test";
import { TENANT_HEADER } from "../../plugins/chassis/src/source-auth-sign.ts";
import { isTenantId, withTenant } from "../../src/tenants/context.ts";

export function testTenants(): [string, string] {
  const ids = [process.env.QM_TEST_TENANT, process.env.QM_TEST_OTHER_TENANT];
  if (!ids.every(isTenantId)) throw new Error("QM_TEST_TENANT is unset: run tests through scripts/run-pg-tests.mjs");
  return ids as [string, string];
}

export function tenantBoundUrl(databaseUrl: string, tenant = testTenants()[0]): string {
  const url = new URL(databaseUrl);
  const options = url.searchParams.get("options");
  url.searchParams.set("options", [options, `-c qm.tenant_id=${tenant}`].filter(Boolean).join(" "));
  return url.toString();
}

export function inTestTenant<T>(fn: () => T, tenant = testTenants()[0]): Promise<Awaited<T>> {
  return withTenant(tenant, fn);
}

export function testTenantHeaders(tenant = testTenants()[0]): Record<string, string> {
  return { [TENANT_HEADER]: tenant };
}

type Body = (t: TestContext) => void | Promise<void>;

export function test(name: string, ...args: [Body] | [TestOptions, Body]): void {
  const fn = args.length === 1 ? args[0] : args[1];
  nodeTest(name, args.length === 1 ? {} : args[0], (t) => inTestTenant(() => fn(t)));
}

export function it(name: string, fn: Body): void {
  nodeIt(name, (t) => inTestTenant(() => fn(t)));
}
