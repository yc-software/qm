import { AsyncLocalStorage } from "node:async_hooks";

const binding = new AsyncLocalStorage<string | undefined>();
const pinned = new AsyncLocalStorage<{ tenant: string | undefined }>();
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_ID.test(value);
}

export function withTenant<T>(id: string, fn: () => T): T {
  if (!isTenantId(id)) throw new Error(`Tenant id must be a lowercase uuid, got ${JSON.stringify(id)}`);
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
