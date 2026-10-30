import type { PgPool, Rows } from "../persistence/pg-pool.ts";
import { withoutTenant, withTenant } from "./context.ts";

export type TenantRow<T = Rows[number]> = T & { tenant_id: string };

export async function claimAcrossTenants<T = Rows[number]>(
  db: Pick<PgPool, "ownerPool">,
  text: string,
  params: unknown[] = [],
): Promise<Array<TenantRow<T>>> {
  const { rows } = await (await db.ownerPool()).query(text, params);
  for (const row of rows as Rows) {
    if (typeof row.tenant_id !== "string") throw new Error("A cross-tenant claim must return each row's tenant_id");
  }
  return rows as Array<TenantRow<T>>;
}

export function inTenantOf<T>(tenantId: string | undefined, fn: () => T): T {
  return tenantId ? withTenant(tenantId, fn) : withoutTenant(fn);
}

export async function eachInTenant<T>(
  rows: readonly T[],
  tenantOf: (row: T) => string | undefined,
  fn: (row: T) => Promise<unknown>,
): Promise<void> {
  for (const row of rows) await inTenantOf(tenantOf(row), () => fn(row));
}

export type EachTenant = (fn: () => Promise<unknown>) => Promise<void>;

export function eachTenant(db: Pick<PgPool, "ownerPool"> | undefined): EachTenant {
  if (!db) return async (fn) => void (await withoutTenant(fn));
  return async (fn) => {
    const tenants = await claimAcrossTenants(db, "SELECT id::text AS tenant_id FROM tenants ORDER BY id");
    const failures: unknown[] = [];
    for (const { tenant_id } of tenants)
      await withTenant(tenant_id, fn).catch((error: unknown) => failures.push(error));
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, `${failures.length} tenants failed`);
  };
}
