import { createPgPool } from "../persistence/pg-pool.ts";
import { withTenant } from "./context.ts";

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

export function inBootTenant<T>(tenant: string | undefined, fn: () => T): T {
  return tenant ? withTenant(tenant, fn) : fn();
}
