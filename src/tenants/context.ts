import { AsyncLocalStorage } from "node:async_hooks";
import { uuidSchema } from "../util/ids.ts";

const TENANT_ID = uuidSchema.lowercase();

const binding = new AsyncLocalStorage<string | undefined>();
const pinned = new AsyncLocalStorage<{ tenant: string | undefined }>();

export function isTenantId(value: unknown): value is string {
  return TENANT_ID.safeParse(value).success;
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
  return prepare(currentTenant()) ?? Promise.resolve();
}

export function withTenant<T>(id: string, fn: () => T): T {
  if (!isTenantId(id)) throw new Error(`Tenant id must be a lowercase uuid, got ${JSON.stringify(id)}`);
  if (bindHooks.size) prepare(id)?.catch(() => undefined);
  return bind(id, fn);
}

export function withoutTenant<T>(fn: () => T): T {
  return bind(undefined, fn);
}

export function pinTenant<T>(fn: () => T): T {
  return pinned.run({ tenant: binding.getStore() }, fn);
}

function bind<T>(id: string | undefined, fn: () => T): T {
  const pin = pinned.getStore();
  if (pin && pin.tenant !== id) throw new Error("A transaction is already open for another tenant");
  return binding.run(id, fn);
}

export function boundTenant(): string | undefined {
  return binding.getStore();
}

export function currentTenant(): string {
  const id = binding.getStore();
  if (id === undefined) throw new Error("No tenant is bound to this work");
  return id;
}

export function perTenant<V>(create: () => V): () => V {
  const values = new Map<string, V>();
  return () => {
    const id = currentTenant();
    if (!values.has(id)) values.set(id, create());
    return values.get(id)!;
  };
}
