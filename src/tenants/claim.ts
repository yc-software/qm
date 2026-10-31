import type { PgPool, Rows } from "../persistence/pg-pool.ts";
import { boundTenant, tenantReady, withoutTenant, withTenant } from "./context.ts";
import type { TenantList } from "./resolver.ts";

type TenantRow<T = Rows[number]> = T & { tenant_id: string };

export async function claimAcrossTenants<T = Rows[number]>(
  db: Pick<PgPool, "ownerPool">,
  text: string,
  params: unknown[] = [],
): Promise<Array<TenantRow<T>>> {
  if (boundTenant()) throw new Error("A cross-tenant claim cannot run while a tenant is bound");
  const { rows } = await (await db.ownerPool()).query(text, params);
  for (const row of rows as Rows) {
    if (typeof row.tenant_id !== "string") throw new Error("A cross-tenant claim must return each row's tenant_id");
  }
  return rows as Array<TenantRow<T>>;
}

export function crossTenantLoop<A extends unknown[], R>(body: (...args: A) => R): (...args: A) => R {
  return (...args) => withoutTenant(() => body(...args));
}

export function inTenantOf<T>(tenantId: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  return tenantId ? withTenant(tenantId, () => whenReady(fn)) : withoutTenant(async () => fn());
}

async function whenReady<T>(fn: () => T | Promise<T>): Promise<T> {
  await tenantReady();
  return fn();
}

export type EachTenant = (fn: () => Promise<unknown>) => Promise<void>;

export function eachTenant(tenants: TenantList): EachTenant {
  return async (fn) => {
    const failures: unknown[] = [];
    for (const tenant of await tenants())
      await withTenant(tenant, () => whenReady(fn)).catch((error: unknown) => failures.push(error));
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, `${failures.length} tenants failed`);
  };
}
