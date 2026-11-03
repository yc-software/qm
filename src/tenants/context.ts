import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

const TENANT_ID = z.uuid().lowercase();

const binding = new AsyncLocalStorage<string | undefined>();

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

export function whenTenantReady<T>(fn: () => T | Promise<T>): Promise<T> {
  const pending = prepare(currentTenant());
  return pending ? pending.then(fn) : new Promise<T>((resolve) => resolve(fn()));
}

export function withTenant<T>(id: string, fn: () => T): T {
  if (!isTenantId(id)) throw new Error(`Tenant id must be a lowercase uuid, got ${JSON.stringify(id)}`);
  if (bindHooks.size) prepare(id)?.catch(() => undefined);
  return binding.run(id, fn);
}

export function withoutTenant<T>(fn: () => T): T {
  return binding.run(undefined, fn);
}

export function boundTenant(): string | undefined {
  return binding.getStore();
}

export function currentTenant(): string {
  const id = binding.getStore();
  if (id === undefined) throw new Error("No tenant is bound to this work");
  return id;
}
