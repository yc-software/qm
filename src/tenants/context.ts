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

export function boundTenant(): string | undefined {
  return bound.getStore();
}

export function currentTenant(): string {
  const id = bound.getStore();
  if (!id) throw new Error("No tenant is bound to this operation");
  return id;
}

export function tenantMap<V>(): () => Map<string, V> {
  const tenants = new Map<string, Map<string, V>>();
  return () => {
    const tenant = bound.getStore() ?? "";
    let rows = tenants.get(tenant);
    if (!rows) tenants.set(tenant, (rows = new Map()));
    return rows;
  };
}
