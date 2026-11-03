import { createPgPool, type PgPool, type PgQueryOptions } from "../persistence/pg-pool.ts";
import { boundTenant, withoutTenant, withTenant } from "./context.ts";

export type Claimed<T> = T & { tenantId?: string };

let ownerPool: PgPool | undefined;

export function useOwnerDatabase(url: string | undefined): void {
  if (!url)
    throw new Error("Set DATABASE_OWNER_URL to the table owner login so background work can claim across tenants");
  ownerPool = createPgPool(url);
}

export async function claimAcrossTenants(
  text: string,
  params: unknown[] = [],
  options?: PgQueryOptions,
): ReturnType<PgPool["query"]> {
  if (boundTenant() !== undefined) throw new Error("A cross-tenant claim cannot run while a tenant is bound");
  if (!ownerPool) throw new Error("Cross-tenant claims need useOwnerDatabase at startup");
  return ownerPool.query(text, params, options);
}

export function crossTenantLoop<A extends unknown[], R>(body: (...args: A) => R): (...args: A) => R {
  return (...args) => withoutTenant(() => body(...args));
}

export async function inTenantOf<T>(tenantId: string | undefined, fn: () => T): Promise<Awaited<T>> {
  return tenantId === undefined ? await withoutTenant(fn) : withTenant(tenantId, fn);
}

export function rowTenant(row: Record<string, unknown>): { tenantId?: string } {
  return row.tenant_id == null ? {} : { tenantId: String(row.tenant_id) };
}
