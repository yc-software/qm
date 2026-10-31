import { AsyncLocalStorage } from "node:async_hooks";

const bound = new AsyncLocalStorage<string>();
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_ID.test(value);
}

export function withTenant<T>(tenant: string, fn: () => T): T {
  if (!isTenantId(tenant)) throw new Error("Invalid tenant id");
  return bound.run(tenant, fn);
}

export function boundTenant(): string | undefined {
  return bound.getStore();
}

export { bound as tenantStorage };
