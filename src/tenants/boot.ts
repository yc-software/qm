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

export function bootTenant(): string | undefined {
  return booted;
}

export async function bindBootTenant(read: () => Promise<string | undefined>): Promise<string | undefined> {
  booted = await read();
  return booted;
}

export function inBootTenant<T>(tenant: string | undefined, fn: () => T): T {
  return tenant ? withTenant(tenant, fn) : fn();
}
