import { withPgTransaction, type PgPool, type PoolClient } from "../persistence/pg-pool.ts";
import { CoordinationError } from "./types.ts";

export interface CoordinationRunFence {
  runId: string;
  attempt: number;
  sessionId: string;
  leaseToken: string;
}

export function assertRunFence(
  fence: CoordinationRunFence,
  run: {
    status: string;
    attempts: number;
    sessionRecordId?: string | null;
    result?: { sessionId?: string } | null;
    leaseToken: string | null;
    leaseExpiresAt: number | null;
  } | null,
): void {
  if (
    !run ||
    run.status !== "running" ||
    run.attempts !== fence.attempt ||
    (run.sessionRecordId ?? run.result?.sessionId) !== fence.sessionId ||
    !fence.leaseToken ||
    run.leaseToken !== fence.leaseToken ||
    run.leaseExpiresAt === null ||
    run.leaseExpiresAt <= Date.now()
  )
    throw new CoordinationError(
      403,
      "coordination_run_expired",
      "coordination mutation requires its current run lease",
    );
}

export async function withFencedPgTransaction<T>(
  pg: PgPool,
  action: (client: PoolClient) => Promise<T>,
  fence?: CoordinationRunFence,
): Promise<T> {
  const transact = async () =>
    withPgTransaction(await pg.pool(), async (client) => {
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query("SET LOCAL statement_timeout = '15s'");
      const readRun = async () => {
        if (!fence) return null;
        return (
          (
            await client.query(
              `SELECT status, attempts, session_record_id AS "sessionRecordId", lease_token AS "leaseToken",
        lease_expires_at::double precision AS "leaseExpiresAt", result::jsonb AS result FROM runs WHERE id=$1 FOR UPDATE`,
              [fence.runId],
            )
          ).rows[0] ?? null
        );
      };
      const run = await readRun();
      if (fence) assertRunFence(fence, run);
      const result = await action(client);
      if (fence) assertRunFence(fence, run);
      return result;
    });
  return transact();
}
