import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

const TENANT_ID = z.uuid().lowercase();

const binding = new AsyncLocalStorage<string | undefined>();

export function isTenantId(value: unknown): value is string {
  return TENANT_ID.safeParse(value).success;
}

export function withTenant<T>(id: string, fn: () => T): T {
  if (!isTenantId(id)) throw new Error(`Tenant id must be a lowercase uuid, got ${JSON.stringify(id)}`);
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
