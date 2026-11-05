import type { PgPool } from "../persistence/pg-pool.ts";
import { withTenant } from "./context.ts";

export interface ClaimedRow {
  tenantId: string;
  id: string;
}

const NAME = /^[a-z_][a-z0-9_]*$/;

export function claimFunction(name: string, args: string, body: string): string {
  if (!NAME.test(name)) throw new Error(`invalid claim function name: ${name}`);
  return `CREATE OR REPLACE FUNCTION ${name}(${args}) RETURNS TABLE(tenant_id uuid, id text)
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
    AS $claim$ ${body} $claim$`;
}

export async function claimRows(pg: Pick<PgPool, "q">, name: string, params: unknown[] = []): Promise<ClaimedRow[]> {
  if (!NAME.test(name)) throw new Error(`invalid claim function name: ${name}`);
  const args = params.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await pg.q(`SELECT tenant_id::text AS tenant_id, id FROM ${name}(${args})`, params);
  return rows.map((row) => ({ tenantId: String(row.tenant_id), id: String(row.id) }));
}

export async function claimThenBind<T>(
  claim: () => Promise<readonly ClaimedRow[]>,
  work: (id: string) => Promise<T>,
): Promise<T[]> {
  const done: T[] = [];
  for (const { tenantId, id } of await claim()) done.push(await withTenant(tenantId, () => work(id)));
  return done;
}
