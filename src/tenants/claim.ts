import { createPgPool, type PgPool, type PgQueryOptions } from "../persistence/pg-pool.ts";
import { boundTenant, withoutTenant, withTenant } from "./context.ts";

export type Claimed<T> = T & { tenantId?: string };

const ownerPools = new Map<string, PgPool>();

function ownerDatabaseUrl(): URL {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url)
    throw new Error("Set DATABASE_OWNER_URL to the table owner login so background work can claim across tenants");
  return new URL(url);
}

export function requireOwnerDatabase(): void {
  ownerDatabaseUrl();
}

function ownerPool(appDatabaseUrl: string): PgPool {
  const owner = ownerDatabaseUrl();
  const url = new URL(appDatabaseUrl);
  url.username = owner.username;
  url.password = owner.password;
  const key = url.toString();
  const existing = ownerPools.get(key);
  if (existing) return existing;
  const pool = createPgPool(key);
  ownerPools.set(key, pool);
  return pool;
}

export function claimAcrossTenants(
  appDatabaseUrl: string,
  text: string,
  params: unknown[] = [],
  options?: PgQueryOptions,
): ReturnType<PgPool["query"]> {
  if (boundTenant() !== undefined)
    return Promise.reject(new Error("A cross-tenant claim cannot run while a tenant is bound"));
  return ownerPool(appDatabaseUrl).query(text, params, options);
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
