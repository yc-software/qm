import { createPgPool, type PgPool, type PgQueryOptions } from "../persistence/pg-pool.ts";
import { boundTenant, withoutTenant, withTenant } from "./context.ts";

export type Claimed<T> = T & { tenantId?: string };

let ownerUrl: string | undefined;
let ownerPool: PgPool | undefined;

export function useOwnerDatabase(url: string | undefined): void {
  if (!url)
    throw new Error("Set DATABASE_OWNER_URL to the table owner login so background work can claim across tenants");
  if (url === ownerUrl) return;
  void ownerPool?.close();
  ownerUrl = url;
  ownerPool = undefined;
}

export async function claimAcrossTenants(
  store: Pick<PgPool, "pool">,
  text: string,
  params: unknown[] = [],
  options?: PgQueryOptions,
): ReturnType<PgPool["query"]> {
  if (boundTenant() !== undefined) throw new Error("A cross-tenant claim cannot run while a tenant is bound");
  if (!ownerUrl) throw new Error("Cross-tenant claims need useOwnerDatabase at startup");
  ownerPool ??= createPgPool(ownerUrl);
  await store.pool();
  return ownerPool.query(text, params, options);
}

export function inTenantOf<T>(tenantId: string | undefined, fn: () => T): T {
  return tenantId === undefined ? withoutTenant(fn) : withTenant(tenantId, fn);
}

export function rowTenant(row: Record<string, unknown>): { tenantId?: string } {
  return row.tenant_id == null ? {} : { tenantId: String(row.tenant_id) };
}
