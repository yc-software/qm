import { createPgPool, type PgMigrationDefinition } from "../persistence/pg-pool.ts";
import type { BudgetTracker } from "./budget.ts";
import { DEFAULT_BUDGET_WINDOW_MS } from "./budget.ts";
import { reportFailure } from "../util/errors.ts";
import { tenantTables } from "../tenants/migrations.ts";

export const BUDGET_MIGRATIONS: PgMigrationDefinition[] = [
  {
    id: "ratelimit/budget/0001",
    statements: [
      `CREATE TABLE IF NOT EXISTS budget_spend(
        id BIGSERIAL PRIMARY KEY,
        principal_id TEXT NOT NULL,
        at BIGINT NOT NULL,
        usd DOUBLE PRECISION NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS budget_spend_by_principal_at ON budget_spend(principal_id, at)`,
    ],
  },
  ...tenantTables("ratelimit/budget/0002-tenants", [{ table: "budget_spend", primaryKey: "id" }]),
];

export function createPostgresBudgetTracker(
  connectionString: string,
  opts: { limitUsd?: number; orgLimitUsd?: number; windowMs?: number } = {},
): BudgetTracker {
  const limitUsd = opts.limitUsd ?? Infinity;
  const orgLimitUsd = opts.orgLimitUsd ?? Infinity;
  const windowMs = opts.windowMs ?? DEFAULT_BUDGET_WINDOW_MS;
  const orgKey = "@org";
  const pg = createPgPool(connectionString, BUDGET_MIGRATIONS);

  return {
    async check(tenant, principalId, now = Date.now()) {
      const db = pg.forTenant(tenant);
      const rows = await db.q(
        "SELECT COALESCE(SUM(usd), 0) AS spent FROM budget_spend WHERE tenant_id = $1 AND principal_id = $2 AND at >= $3",
        [tenant.id, principalId, now - windowMs],
      );
      const spentUsd = Number(rows[0]?.spent ?? 0);
      if (spentUsd >= limitUsd) return { allowed: false, spentUsd, limitUsd };
      const orgRows = await db.q(
        "SELECT COALESCE(SUM(usd), 0) AS spent FROM budget_spend WHERE tenant_id = $1 AND principal_id = $2 AND at >= $3",
        [tenant.id, orgKey, now - windowMs],
      );
      const orgSpent = Number(orgRows[0]?.spent ?? 0);
      return { allowed: orgSpent < orgLimitUsd, spentUsd: orgSpent, limitUsd: orgLimitUsd };
    },
    async record(tenant, principalId, costUsd, now = Date.now()) {
      try {
        const db = pg.forTenant(tenant);
        for (const key of [principalId, orgKey]) {
          await db.q(
            `WITH ins AS (INSERT INTO budget_spend(tenant_id, principal_id, at, usd) VALUES ($1, $2, $3, $4))
             DELETE FROM budget_spend WHERE tenant_id = $1 AND principal_id = $2 AND at < $5`,
            [tenant.id, key, now, costUsd, now - windowMs],
          );
        }
      } catch (err) {
        reportFailure("budget: persist spend", err);
      }
    },
  };
}
