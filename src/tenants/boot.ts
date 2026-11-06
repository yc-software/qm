import type { PgPool } from "../persistence/pg-pool.ts";
import { withTenant } from "./context.ts";

export const BOOT_TENANT_TTL_MS = 5_000;

export function bootTenantReader(db: Pick<PgPool, "q">): () => Promise<string | undefined> {
  let cached: { at: number; read: Promise<string | undefined> } | undefined;
  return () => {
    if (cached && Date.now() - cached.at < BOOT_TENANT_TTL_MS) return cached.read;
    const read = db
      .q("SELECT qm_boot_tenant()::text AS id")
      .then((rows) => (rows[0]?.id as string | null) ?? undefined);
    const entry = { at: Date.now(), read };
    cached = entry;
    read.catch(() => cached === entry && (cached = undefined));
    return read;
  };
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
