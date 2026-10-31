import { boundTenant, isTenantId, tenantId, tenantStore } from "../../plugins/chassis/src/tenant.ts";
import { scopeId, type ScopeId } from "../types.ts";

export { boundTenant, isTenantId };

const bindHooks = new Set<(tenant: string) => Promise<unknown>>();
const firstBinds = new Map<string, Promise<void>>();

export function onFirstBind(hook: (tenant: string) => Promise<unknown>): () => void {
  bindHooks.add(hook);
  return () => bindHooks.delete(hook);
}

function firstBind(tenant: string): string {
  if (!bindHooks.size || firstBinds.has(tenant)) return tenant;
  let settle!: (ready: Promise<void>) => void;
  const pending = new Promise<void>((resolve) => (settle = resolve));
  pending.catch(() => undefined);
  firstBinds.set(tenant, pending);
  const ready = Promise.all([...bindHooks].map((hook) => hook(tenant))).then(() => undefined);
  ready.catch(() => firstBinds.delete(tenant));
  settle(ready);
  return tenant;
}

export function tenantReady(): Promise<void> {
  return firstBinds.get(currentTenant()) ?? Promise.resolve();
}

export function withTenant<T>(id: string, fn: () => T): T {
  return tenantStore.run(firstBind(tenantId(id)), fn);
}

export function withoutTenant<T>(fn: () => T): T {
  return tenantStore.exit(fn);
}

export function enterTenant(id: string): void {
  tenantStore.enterWith(firstBind(tenantId(id)));
}

export function currentTenant(): string {
  const id = tenantStore.getStore();
  if (!id) throw new Error("No tenant is bound to this operation");
  return id;
}

export function tenantRootScope(): ScopeId {
  return scopeId("org", currentTenant());
}

export function tenantKey(key: string): string {
  const tenant = boundTenant();
  return tenant ? `${tenant}:${key}` : key;
}

export function perTenant<V>(create: () => V): () => V {
  const values = new Map<string, V>();
  return () => {
    const id = currentTenant();
    if (!values.has(id)) values.set(id, create());
    return values.get(id)!;
  };
}
