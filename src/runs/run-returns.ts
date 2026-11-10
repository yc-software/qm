import type { PgPool } from "../persistence/pg-pool.ts";
import { claimRows, type ClaimedRow } from "../tenants/claim.ts";
import type { Run, RunDeliveryState, RunStore } from "./run-store.ts";
import { rowToRun } from "./run-rows.ts";

export const PENDING_RETURNS = `SELECT * FROM (
           SELECT * FROM runs WHERE status IN ('done','failed') AND returned_at IS NULL
           AND session_id LIKE 'agent:main:subagent:%' AND id > $2
           UNION
           SELECT child.* FROM runs wake JOIN runs child
           ON child.tenant_id = wake.tenant_id AND child.id = substring(wake.idempotency_key FROM length('subagent-return:') + 1)
           WHERE wake.status = 'pending' AND wake.attempts = 0 AND wake.turn_user_seq IS NULL
           AND wake.idempotency_key LIKE 'subagent-return:%'
           AND child.status IN ('done','failed') AND child.session_id LIKE 'agent:main:subagent:%'
           AND child.id > $2
         ) pending`;

export function createRunReturns(
  pg: PgPool,
  loaded: (claim: () => Promise<ClaimedRow[]>) => Promise<Run[]>,
): Pick<
  RunStore,
  "setDeliveryState" | "pendingReturns" | "terminalFinished" | "markReturned" | "deferReturn" | "lastFinishedForThreads"
> {
  const { query: q } = pg;
  return {
    async setDeliveryState(runId: string, leaseToken: string | null, state: RunDeliveryState): Promise<boolean> {
      const { rowCount } =
        leaseToken === null
          ? await q(
              "UPDATE runs SET delivery_state=(COALESCE(delivery_state, '{}')::jsonb || $1::jsonb)::text WHERE id=$2",
              [JSON.stringify(state), runId],
            )
          : await q(
              "UPDATE runs SET delivery_state=(COALESCE(delivery_state, '{}')::jsonb || $1::jsonb)::text WHERE id=$2 AND lease_token=$3",
              [JSON.stringify(state), runId, leaseToken],
            );
      return rowCount > 0;
    },

    async pendingReturns(limit = 100, afterId = "", threadRefs) {
      if (threadRefs) {
        const { rows } = await q(`${PENDING_RETURNS} WHERE session_id = ANY($3) ORDER BY id LIMIT $1`, [
          limit,
          afterId,
          threadRefs,
        ]);
        return rows.map(rowToRun);
      }
      return loaded(() => claimRows(pg, "claim_pending_returns", [limit, afterId, Date.now()]));
    },
    async terminalFinished(after, beforeMs, limit) {
      return loaded(() => claimRows(pg, "claim_terminal_runs", [beforeMs, after.finishedAt, after.id, limit]));
    },
    async markReturned(runId) {
      await q("UPDATE runs SET returned_at = $2 WHERE id = $1 AND status IN ('done','failed')", [runId, Date.now()]);
    },
    async deferReturn(runId, delayMs) {
      await q("UPDATE runs SET retry_after = $2 WHERE id = $1 AND status IN ('done','failed')", [
        runId,
        Date.now() + Math.max(0, delayMs),
      ]);
    },
    async lastFinishedForThreads(threadRefs) {
      if (!threadRefs.length) return new Map();
      const { rows } = await q(
        `SELECT last.* FROM unnest($1::text[]) AS threads(id)
         CROSS JOIN LATERAL (
           SELECT * FROM runs WHERE session_id = threads.id AND status IN ('done', 'failed')
           ORDER BY created_at DESC, seq DESC LIMIT 1
         ) last`,
        [[...new Set(threadRefs)]],
      );
      return new Map(
        rows.map((row) => {
          const run = rowToRun(row);
          return [run.sessionId, run];
        }),
      );
    },
  };
}
