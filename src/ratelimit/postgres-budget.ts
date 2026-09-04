import { createPgPool } from "../persistence/pg-pool.ts";
import type { BudgetTracker } from "./budget.ts";
import { DEFAULT_BUDGET_WINDOW_MS } from "./budget.ts";
import { errMessage } from "../util/errors.ts";

export function createPostgresBudgetTracker(
  connectionString: string,
  opts: { limitUsd?: number; orgLimitUsd?: number; windowMs?: number } = {},
): BudgetTracker {
  const limitUsd = opts.limitUsd ?? Infinity;
  const orgLimitUsd = opts.orgLimitUsd ?? Infinity;
  const windowMs = opts.windowMs ?? DEFAULT_BUDGET_WINDOW_MS;
  const orgKey = "@org";
  const { q } = createPgPool(connectionString, [
    `CREATE TABLE IF NOT EXISTS budget_spend(
        id BIGSERIAL PRIMARY KEY,
        principal_id TEXT NOT NULL,
        at BIGINT NOT NULL,
        usd DOUBLE PRECISION NOT NULL
      )`,
    `CREATE INDEX IF NOT EXISTS budget_spend_by_principal_at ON budget_spend(principal_id, at)`,
  ]);

  return {
    async check(principalId, now = Date.now()) {
      const rows = await q(
        "SELECT COALESCE(SUM(usd), 0) AS spent FROM budget_spend WHERE principal_id = $1 AND at >= $2",
        [principalId, now - windowMs],
      );
      const spentUsd = Number(rows[0]?.spent ?? 0);
      if (spentUsd >= limitUsd) return { allowed: false, spentUsd, limitUsd };
      const orgRows = await q(
        "SELECT COALESCE(SUM(usd), 0) AS spent FROM budget_spend WHERE principal_id = $1 AND at >= $2",
        [orgKey, now - windowMs],
      );
      const orgSpent = Number(orgRows[0]?.spent ?? 0);
      return { allowed: orgSpent < orgLimitUsd, spentUsd: orgSpent, limitUsd: orgLimitUsd };
    },
    async record(principalId, costUsd, now = Date.now()) {
      try {
        for (const key of [principalId, orgKey]) {
          await q(
            `WITH ins AS (INSERT INTO budget_spend(principal_id, at, usd) VALUES ($1, $2, $3))
             DELETE FROM budget_spend WHERE principal_id = $1 AND at < $4`,
            [key, now, costUsd, now - windowMs],
          );
        }
      } catch (err) {
        console.error("[budget] failed to persist spend:", errMessage(err));
      }
    },
  };
}
