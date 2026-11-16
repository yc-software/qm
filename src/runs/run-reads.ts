import type { PgPool } from "../persistence/pg-pool.ts";
import type { Run, RunStore } from "./run-store.ts";
import { rowToRun, turnOrder } from "./run-rows.ts";

export function createRunReads(
  pg: PgPool,
): Pick<
  RunStore,
  "getByDedupKey" | "activeForThreads" | "activeForThread" | "inFlightForThread" | "activeSessionIds" | "list"
> {
  const { query: q } = pg;
  const reads: Pick<
    RunStore,
    "getByDedupKey" | "activeForThreads" | "activeForThread" | "inFlightForThread" | "activeSessionIds" | "list"
  > = {
    async getByDedupKey(dedupKey) {
      const { rows } = await q(`SELECT * FROM runs WHERE idempotency_key = $1`, [dedupKey]);
      return rows[0] ? rowToRun(rows[0]) : null;
    },

    async activeForThreads(threadRefs) {
      if (!threadRefs.length) return new Map();
      const { rows } = await q(
        `SELECT current.* FROM unnest($1::text[]) AS threads(id)
         CROSS JOIN LATERAL (
           SELECT * FROM runs WHERE session_id = threads.id AND status IN ('pending', 'running')
           ORDER BY status = 'running' DESC, ${turnOrder("runs")} LIMIT 1
         ) current`,
        [[...new Set(threadRefs)]],
      );
      return new Map(
        rows.map((row) => {
          const run = rowToRun(row);
          return [run.sessionId, run];
        }),
      );
    },
    async activeForThread(sessionId: string): Promise<Run | null> {
      return (await reads.activeForThreads([sessionId])).get(sessionId) ?? null;
    },

    async inFlightForThread(sessionId: string): Promise<Run[]> {
      const { rows } = await q(
        `SELECT * FROM runs WHERE session_id = $1 AND status IN ('pending','running') ORDER BY (status = 'running') DESC, ${turnOrder("runs")}`,
        [sessionId],
      );
      return rows.map(rowToRun);
    },

    async activeSessionIds(): Promise<string[]> {
      const { rows } = await q("SELECT DISTINCT session_id FROM runs WHERE status IN ('pending','running')");
      return rows.map((r) => r.session_id as string);
    },

    async list({ limit = 200, threadRef }: { limit?: number; threadRef?: string } = {}): Promise<Run[]> {
      const { rows } = threadRef
        ? await q(
            "SELECT * FROM runs WHERE session_id = $1 OR starts_with(session_id, $1 || ':task:') OR starts_with(session_id, $1 || ':status:') ORDER BY created_at DESC, seq DESC LIMIT $2",
            [threadRef, limit],
          )
        : await q("SELECT * FROM runs ORDER BY created_at DESC, seq DESC LIMIT $1", [limit]);
      return rows.map(rowToRun);
    },
  };
  return reads;
}
