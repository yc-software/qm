import { AsyncLocalStorage } from "node:async_hooks";
import { scopeId, type ScopeId } from "../types.ts";
import { uuidSchema } from "../util/ids.ts";

const TENANT_ID = uuidSchema.lowercase();

const binding = new AsyncLocalStorage<string | undefined>();
const pinned = new AsyncLocalStorage<{ tenant: string | undefined }>();

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

export function tenantRootScope(): ScopeId {
  return scopeId("org", currentTenant());
}
