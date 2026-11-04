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

export interface TenantRow {
  id: string;
  install: boolean;
}

export async function listTenants(store: PgPool): Promise<TenantRow[]> {
  const { rows } = await claimAcrossTenants(
    store,
    "SELECT id::text AS id, id = qm_tenant_id() AS install FROM tenants ORDER BY id",
  );
  return rows.map((row) => ({ id: String(row.id), install: row.install === true }));
}

export async function forEachTenant(store: PgPool, fn: () => Promise<unknown>): Promise<void> {
  for (const tenant of await listTenants(store)) await withTenant(tenant.id, fn);
}

export async function inInstallTenant<T>(store: PgPool, fn: () => Promise<T>): Promise<T> {
  const install = (await withoutTenant(() => listTenants(store))).find((tenant) => tenant.install);
  return inTenantOf(install?.id, fn);
}
