import { boundTenant, withoutTenant, withTenant } from "./context.ts";

export function claimAcrossTenants<T>(claim: () => Promise<T>): Promise<T> {
  if (boundTenant() !== undefined)
    return Promise.reject(new Error("A cross-tenant claim cannot run while a tenant is bound"));
  return claim();
}

export function crossTenantLoop<A extends unknown[], R>(body: (...args: A) => R): (...args: A) => R {
  return (...args) => withoutTenant(() => body(...args));
}

export function inTenantOf<T>(tenantId: string | undefined, fn: () => T): T {
  return tenantId === undefined ? withoutTenant(fn) : withTenant(tenantId, fn);
}

export function rowTenant(row: Record<string, unknown>): { tenantId?: string } {
  return row.tenant_id == null ? {} : { tenantId: String(row.tenant_id) };
}
