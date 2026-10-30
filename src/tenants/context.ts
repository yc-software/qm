import { AsyncLocalStorage } from "node:async_hooks";

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const bound = new AsyncLocalStorage<string>();

function tenantId(id: string): string {
  const normalized = id.toLowerCase();
  if (!TENANT_ID.test(normalized)) throw new Error(`Invalid tenant id: ${JSON.stringify(id)}`);
  return normalized;
}

export function withTenant<T>(id: string, fn: () => T): T {
  return bound.run(tenantId(id), fn);
}

export function enterTenant(id: string): void {
  bound.enterWith(tenantId(id));
}

export function withoutTenant<T>(fn: () => T): T {
  return bound.exit(fn);
}

export function boundTenant(): string | undefined {
  return bound.getStore();
}

export function currentTenant(): string {
  const id = bound.getStore();
  if (!id) throw new Error("No tenant is bound to this operation");
  return id;
}

export function tenantKey(key: string): string {
  const tenant = boundTenant();
  return tenant ? `${tenant}:${key}` : key;
}
