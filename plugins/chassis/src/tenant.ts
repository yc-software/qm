import { AsyncLocalStorage } from "node:async_hooks";

const binding = new AsyncLocalStorage<string | undefined>();
const pinned = new AsyncLocalStorage<{ tenant: string | undefined; open: boolean }>();
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_ID.test(value);
}

type BindHook = (tenant: string) => Promise<unknown>;
const bindHooks = new Map<BindHook, Map<string, Promise<void> | true>>();

export function onFirstBind(hook: BindHook): () => void {
  bindHooks.set(hook, new Map());
  return () => bindHooks.delete(hook);
}

function prepare(tenant: string): Promise<void> | undefined {
  const pending: Array<Promise<void>> = [];
  for (const [hook, done] of bindHooks) {
    const existing = done.get(tenant);
    if (existing === true) continue;
    if (existing) {
      pending.push(existing);
      continue;
    }
    const run = Promise.resolve(tenant)
      .then(hook)
      .then(() => void done.set(tenant, true));
    done.set(tenant, run);
    run.catch(() => done.get(tenant) === run && done.delete(tenant));
    pending.push(run);
  }
  return pending.length ? Promise.all(pending).then(() => undefined) : undefined;
}

export function tenantReady(): Promise<void> {
  const id = binding.getStore();
  if (id === undefined) return Promise.reject(new Error("No tenant is bound to this work"));
  return prepare(id) ?? Promise.resolve();
}

export function withTenant<T>(id: string, fn: () => T): T {
  if (!isTenantId(id)) throw new Error(`Tenant id must be a lowercase uuid, got ${JSON.stringify(id)}`);
  if (bindHooks.size) prepare(id)?.catch(() => undefined);
  return bind(id, fn);
}

export function withoutTenant<T>(fn: () => T): T {
  return bind(undefined, fn);
}

export async function pinTenant<T>(fn: () => Promise<T>): Promise<T> {
  const pin = { tenant: binding.getStore(), open: true };
  try {
    return await pinned.run(pin, fn);
  } finally {
    pin.open = false;
  }
}

function bind<T>(id: string | undefined, fn: () => T): T {
  const pin = pinned.getStore();
  if (pin?.open && pin.tenant !== id) throw new Error("A transaction is already open for another tenant");
  return binding.run(id, fn);
}

export function boundTenant(): string | undefined {
  return binding.getStore();
}
