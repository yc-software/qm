import type { PgPool, PgQueryOptions } from "../persistence/pg-pool.ts";
import { boundTenant, withoutTenant, withTenant } from "./context.ts";
import { ownerPgPool } from "./owner-pool.ts";

export type Claimed<T> = T & { tenantId?: string };

export async function claimAcrossTenants(
  store: PgPool,
  text: string,
  params: unknown[] = [],
  options?: PgQueryOptions,
): ReturnType<PgPool["query"]> {
  if (boundTenant() !== undefined) throw new Error("A cross-tenant claim cannot run while a tenant is bound");
  const owner = ownerPgPool(store);
  if (owner !== store) await store.pool();
  return owner.query(text, params, options);
}

export function inTenantOf<T>(tenantId: string | undefined, fn: () => T): T {
  return tenantId === undefined ? withoutTenant(fn) : withTenant(tenantId, fn);
}

export function rowTenant(row: Record<string, unknown>): { tenantId?: string } {
  return row.tenant_id == null ? {} : { tenantId: String(row.tenant_id) };
}

export async function forEachTenant(store: PgPool, fn: () => Promise<unknown>): Promise<void> {
  const { rows } = await claimAcrossTenants(store, "SELECT id::text AS id FROM tenants ORDER BY id");
  for (const row of rows) await withTenant(String(row.id), fn);
}
