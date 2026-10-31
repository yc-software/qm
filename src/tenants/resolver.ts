import type { PgPool } from "../persistence/pg-pool.ts";

export type TenantResolver = {
  forHost(host: string): Promise<string | null>;
  forSlackTeam(teamId: string): Promise<string | null>;
};

export type TenantList = () => Promise<string[]>;

const TENANTS_TTL_MS = 60_000;

export function pgTenants(pool: Pick<PgPool, "q">): TenantList {
  let cached: { at: number; tenants: Promise<string[]> } | undefined;
  return () => {
    if (cached && Date.now() - cached.at < TENANTS_TTL_MS) return cached.tenants;
    const tenants = pool
      .q("SELECT id::text AS id FROM tenants ORDER BY id")
      .then((rows) => rows.map((row) => String(row.id)));
    cached = { at: Date.now(), tenants };
    tenants.catch(() => (cached = undefined));
    return tenants;
  };
}

export const MEMORY_TENANT = "00000000-0000-4000-8000-000000000001";

export const memoryTenants: TenantList = async () => [MEMORY_TENANT];

export function singleTenantResolver(tenants: TenantList): TenantResolver {
  const onlyTenant = async (): Promise<string | null> => {
    const all = await tenants();
    return all.length === 1 ? all[0]! : null;
  };
  return { forHost: onlyTenant, forSlackTeam: onlyTenant };
}
