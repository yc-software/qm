import { AsyncLocalStorage } from "node:async_hooks";

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const bound = new AsyncLocalStorage<string>();

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

export function withoutTenant<T>(fn: () => T): T {
  return bound.exit(fn);
}

export function enterTenant(id: string): void {
  bound.enterWith(firstBind(tenantId(id)));
}

export function boundTenant(): string | undefined {
  return bound.getStore();
}

export function currentTenant(): string {
  const id = bound.getStore();
  if (!id) throw new Error("No tenant is bound to this operation");
  return id;
}
