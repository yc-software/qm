import { tenantStorage as bound } from "../../plugins/chassis/src/tenant.ts";
import { scopeId, type ScopeId } from "../types.ts";

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isTenantId(id: unknown): id is string {
  return typeof id === "string" && TENANT_ID.test(id);
}

function tenantId(id: string): string {
  const normalized = id.toLowerCase();
  if (!TENANT_ID.test(normalized)) throw new Error(`Invalid tenant id: ${JSON.stringify(id)}`);
  return normalized;
}

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
  return bound.run(firstBind(tenantId(id)), fn);
}

export function enterTenant(id: string): void {
  bound.enterWith(firstBind(tenantId(id)));
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

export function tenantRootScope(): ScopeId {
  return scopeId("org", currentTenant());
}

export function perTenant<V>(create: () => V): () => V {
  const values = new Map<string, V>();
  return () => {
    const id = currentTenant();
    if (!values.has(id)) values.set(id, create());
    return values.get(id)!;
  };
}

export function tenantMap<V>(): () => Map<string, V> {
  const tenants = new Map<string, Map<string, V>>();
  return () => {
    const tenant = currentTenant();
    let rows = tenants.get(tenant);
    if (!rows) tenants.set(tenant, (rows = new Map()));
    return rows;
  };
}

export function tenantKey(key: string): string {
  const tenant = boundTenant();
  return tenant ? `${tenant}:${key}` : key;
}
