import type { PgPool } from "../persistence/pg-pool.ts";

export type RowTenants = (table: string, columns: readonly string[], value: string) => Promise<string[]>;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 10_000;

export function ownerRowTenants(db: Pick<PgPool, "ownerPool">): RowTenants {
  const cache = new Map<string, { tenant: string; until: number }>();
  return async (table, columns, value) => {
    const key = `${table}\n${columns.join(",")}\n${value}`;
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return [hit.tenant];
    if (!IDENTIFIER.test(table) || !columns.length || !columns.every((column) => IDENTIFIER.test(column)))
      throw new Error(`Invalid row reference ${table}(${columns.join(", ")})`);
    const match = columns.map((column) => `${column} = $1`).join(" OR ");
    const sql = `SELECT DISTINCT tenant_id::text AS tenant FROM ${table} WHERE ${match}`;
    const { rows } = await (await db.ownerPool()).query<{ tenant: string }>(sql, [value]);
    const tenants = rows.map((row) => String(row.tenant));
    if (tenants.length !== 1) return tenants;
    cache.delete(key);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, { tenant: tenants[0]!, until: Date.now() + CACHE_TTL_MS });
    return tenants;
  };
}
