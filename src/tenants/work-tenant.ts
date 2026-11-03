import type { PgPool } from "../persistence/pg-pool.ts";
import { boundTenant } from "./context.ts";

const SOLE_TENANT_RECHECK_MS = 5_000;

let sole: { checkedAt: number; tenant: Promise<string> } | undefined;

export function workTenant(pg: Pick<PgPool, "q">): Promise<string> {
  const bound = boundTenant();
  if (bound !== undefined) return Promise.resolve(bound);
  if (!sole || Date.now() - sole.checkedAt > SOLE_TENANT_RECHECK_MS) {
    const tenant = pg.q("SELECT qm_bound_tenant()::text AS id").then((rows) => String(rows[0]?.id));
    const entry = { checkedAt: Date.now(), tenant };
    sole = entry;
    tenant.catch(() => {
      if (sole === entry) sole = undefined;
    });
  }
  return sole.tenant;
}
