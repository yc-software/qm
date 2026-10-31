import { boundTenant, isTenantId, tenantId, tenantStore } from "../../plugins/chassis/src/tenant.ts";
import { scopeId, type ScopeId } from "../types.ts";

export { boundTenant, isTenantId };

type BindHook = (tenant: string) => Promise<unknown>;
const bindHooks = new Map<BindHook, Map<string, Promise<void>>>();

export function onFirstBind(hook: BindHook): () => void {
  bindHooks.set(hook, new Map());
  return () => bindHooks.delete(hook);
}

function prepare(tenant: string): Promise<void> {
  const runs = [...bindHooks].map(([hook, done]) => {
    const existing = done.get(tenant);
    if (existing) return existing;
    const run = Promise.resolve(tenant)
      .then(hook)
      .then(() => undefined);
    done.set(tenant, run);
    run.catch(() => done.get(tenant) === run && done.delete(tenant));
    return run;
  });
  return Promise.all(runs).then(() => undefined);
}

function firstBind(tenant: string): string {
  if (bindHooks.size) prepare(tenant).catch(() => undefined);
  return tenant;
}

export function tenantReady(): Promise<void> {
  return prepare(currentTenant());
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
