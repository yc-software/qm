import type { PgPool } from "../persistence/pg-pool.ts";

export type TenantResolver = {
  forHost(host: string): Promise<string | null>;
  forSlackTeam(teamId: string): Promise<string | null>;
};

export function singleTenantResolver(pool: Pick<PgPool, "q">): TenantResolver {
  const only = async (): Promise<string | null> => {
    const rows = await pool.q("SELECT id::text AS id FROM tenants LIMIT 2");
    return rows.length === 1 ? String(rows[0]!.id) : null;
  };
  return { forHost: only, forSlackTeam: only };
}
