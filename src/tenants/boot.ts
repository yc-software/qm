import { createPgPool } from "../persistence/pg-pool.ts";
import { type Tenant, withTenant } from "./context.ts";

export async function readBootTenant(databaseUrl: string): Promise<string | undefined> {
  const db = createPgPool(databaseUrl);
  try {
    return ((await db.q("SELECT qm_boot_tenant()::text AS id"))[0]?.id as string | null) ?? undefined;
  } finally {
    await db.close();
  }
}

let booted: string | undefined;
let bootRead = false;

export function bootTenant(): string | undefined {
  return booted;
}

export function tenancyBooted(): boolean {
  return bootRead;
}

export async function bindBootTenant(read: () => Promise<string | undefined>): Promise<string | undefined> {
  booted = await read();
  bootRead = true;
  return booted;
}

export function inBootTenant<T>(id: string | undefined, fn: (tenant: Tenant | undefined) => T): T {
  return id ? withTenant(id, fn) : fn(undefined);
}
