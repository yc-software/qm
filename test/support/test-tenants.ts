import { test as nodeTest, type TestContext, type TestOptions } from "node:test";
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

export function inTestTenant<T>(fn: () => T, tenant = testTenants()[0]): T {
  return withTenant(tenant, fn);
}

export function testTenantHeaders(tenant = testTenants()[0]): Record<string, string> {
  return { [TENANT_HEADER]: tenant };
}

type TestBody = (context: TestContext) => void | Promise<void>;

export function tenantTest(name: string, fn: TestBody): Promise<void>;
export function tenantTest(name: string, options: TestOptions, fn: TestBody): Promise<void>;
export function tenantTest(name: string, options: TestOptions | TestBody, fn?: TestBody): Promise<void> {
  const body = typeof options === "function" ? options : fn;
  if (!body) throw new Error(`Test ${name} has no body`);
  return nodeTest(name, typeof options === "function" ? {} : options, (context) => inTestTenant(() => body(context)));
}
