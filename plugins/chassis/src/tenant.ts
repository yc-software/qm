import { AsyncLocalStorage } from "node:async_hooks";

export const tenantStore = new AsyncLocalStorage<string>();
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_ID.test(value);
}

export function tenantId(id: string): string {
  const normalized = id.toLowerCase();
  if (!TENANT_ID.test(normalized)) throw new Error(`Invalid tenant id: ${JSON.stringify(id)}`);
  return normalized;
}

export function withTenant<T>(id: string, fn: () => T): T {
  return tenantStore.run(tenantId(id), fn);
}

export function boundTenant(): string | undefined {
  return tenantStore.getStore();
}
