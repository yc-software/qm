import { AsyncLocalStorage } from "node:async_hooks";
import { uuidSchema } from "../util/ids.ts";

const TENANT_ID = uuidSchema.lowercase();

const binding = new AsyncLocalStorage<string | undefined>();
const pinned = new AsyncLocalStorage<{ tenant: string | undefined; open: boolean }>();

export function isTenantId(value: unknown): value is string {
  return TENANT_ID.safeParse(value).success;
}

export function withTenant<T>(id: string, fn: () => T): T {
  if (!isTenantId(id)) throw new Error(`Tenant id must be a lowercase uuid, got ${JSON.stringify(id)}`);
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

export function currentTenant(): string {
  const id = binding.getStore();
  if (id === undefined) throw new Error("No tenant is bound to this work");
  return id;
}
