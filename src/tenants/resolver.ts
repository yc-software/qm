import type { PgPool } from "../persistence/pg-pool.ts";

export type TenantResolver = {
  forHost(host: string): Promise<string | null>;
  forSlackTeam(teamId: string): Promise<string | null>;
};

const ONLY_TENANT_TTL_MS = 60_000;

export function singleTenantResolver(pool: Pick<PgPool, "q">): TenantResolver {
  let cached: { at: number; tenant: Promise<string | null> } | undefined;
  const onlyTenant = (): Promise<string | null> => {
    if (cached && Date.now() - cached.at < ONLY_TENANT_TTL_MS) return cached.tenant;
    const tenant = pool
      .q("SELECT id::text AS id FROM tenants LIMIT 2")
      .then((rows) => (rows.length === 1 ? String(rows[0]!.id) : null));
    cached = { at: Date.now(), tenant };
    tenant.catch(() => (cached = undefined));
    return tenant;
  };
  return { forHost: onlyTenant, forSlackTeam: onlyTenant };
}
