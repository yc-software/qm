import type { PgPool } from "../persistence/pg-pool.ts";
import { loadTenant } from "./cache.ts";
import { type Tenant, withTenant } from "./context.ts";

export interface ClaimedRow {
  tenantId: string;
  id: string;
}

const NAME = /^[a-z_][a-z0-9_]*$/;

export const servingTenant = (column: string): string => ` AND ${column} IN (SELECT qm_serving_tenants())`;

export function claimFunction(name: string, args: string, body: string): string {
  if (!NAME.test(name)) throw new Error(`invalid claim function name: ${name}`);
  return `DO $claim_function$
BEGIN
  EXECUTE format(
    $function$CREATE OR REPLACE FUNCTION ${name}(${args}) RETURNS TABLE(tenant_id uuid, id text)
      LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = %I, pg_temp
      AS $claim$ ${body.replaceAll("%", "%%")} $claim$$function$,
    current_schema());
END $claim_function$`;
}

export async function claimRows(pg: Pick<PgPool, "q">, name: string, params: unknown[] = []): Promise<ClaimedRow[]> {
  if (!NAME.test(name)) throw new Error(`invalid claim function name: ${name}`);
  const args = params.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await pg.q(`SELECT tenant_id::text AS tenant_id, id FROM ${name}(${args})`, params);
  return rows.map((row) => ({ tenantId: String(row.tenant_id), id: String(row.id) }));
}

export async function claimThenBind<T>(
  claim: () => Promise<readonly ClaimedRow[]>,
  work: (id: string, tenant: Tenant) => Promise<T>,
): Promise<T[]> {
  const done: T[] = [];
  for (const { tenantId, id } of await claim())
    done.push(
      await inTenant(tenantId, (tenant) => work(id, tenant)).catch((e: unknown) => {
        throw new Error(`tenant ${tenantId}`, { cause: e });
      }),
    );
  return done;
}

export async function claimThenLoad<T extends { id: string }>(
  claim: () => Promise<readonly ClaimedRow[]>,
  load: (ids: string[], tenant: Tenant) => Promise<T[]>,
): Promise<Array<T & { tenantId: string }>> {
  const claimed = await claim();
  const byKey = new Map<string, T & { tenantId: string }>();
  for (const tenantId of new Set(claimed.map((row) => row.tenantId))) {
    const ids = claimed.filter((row) => row.tenantId === tenantId).map(({ id }) => id);
    const rows = await inTenant(tenantId, (tenant) => load(ids, tenant)).catch((e: unknown) => {
      throw new Error(`tenant ${tenantId}`, { cause: e });
    });
    for (const row of rows) byKey.set(`${tenantId} ${row.id}`, { ...row, tenantId });
  }
  return claimed.flatMap(({ tenantId, id }) => byKey.get(`${tenantId} ${id}`) ?? []);
}

export function inTenant<T>(id: string, fn: (tenant: Tenant) => Promise<T>): Promise<T> {
  return withTenant(id, async (tenant) => {
    await loadTenant();
    return fn(tenant);
  });
}
