import type { PgPool, Rows } from "../persistence/pg-pool.ts";
import { boundTenant, withoutTenant, withTenant } from "./context.ts";
import type { TenantList } from "./resolver.ts";

type TenantRow<T = Rows[number]> = T & { tenant_id: string };

export async function claimAcrossTenants<T = Rows[number]>(
  db: Pick<PgPool, "ownerPool" | "pool">,
  text: string,
  params: unknown[] = [],
): Promise<Array<TenantRow<T>>> {
  const { rows } = await (boundTenant() ? await db.pool() : await db.ownerPool()).query(text, params);
  for (const row of rows as Rows) {
    if (typeof row.tenant_id !== "string") throw new Error("A cross-tenant claim must return each row's tenant_id");
  }
  return rows as Array<TenantRow<T>>;
}

export function inTenantOf<T>(tenantId: string | undefined, fn: () => T): T {
  return tenantId ? withTenant(tenantId, fn) : withoutTenant(fn);
}

export type EachTenant = (fn: () => Promise<unknown>) => Promise<void>;

export function eachTenant(tenants: TenantList): EachTenant {
  return async (fn) => {
    const failures: unknown[] = [];
    for (const tenant of await tenants()) await withTenant(tenant, fn).catch((error: unknown) => failures.push(error));
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, `${failures.length} tenants failed`);
  };
}
