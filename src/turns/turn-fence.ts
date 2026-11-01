import pg from "pg";
import { TURN_QUEUES } from "./absurd-schema.ts";

export interface FenceQueryable {
  query(text: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

function fenceSql(lock: boolean): string {
  const share = lock ? " FOR SHARE" : "";
  const held = TURN_QUEUES.map(
    (queue, priority) => `WHEN ${priority} THEN EXISTS (
      SELECT 1 FROM absurd.${pg.escapeIdentifier(`r_${queue}`)} r WHERE r.run_id = t.absurd_run_id
        AND ((r.state = 'running' AND r.claimed_by = $2 AND r.claim_expires_at > absurd.current_time())
          OR r.state = 'cancelled')${share})`,
  ).join("\n");
  return `SELECT CASE t.claim_priority ${held} ELSE false END AS ok FROM runs t
    WHERE t.id = $1 AND t.status = 'running' AND t.lease_token = $2 AND t.absurd_run_id IS NOT NULL${lock ? " FOR SHARE OF t" : ""}`;
}

const LOCKED_FENCE_SQL = fenceSql(true);
const OBSERVED_FENCE_SQL = fenceSql(false);

export async function turnFenceHeld(
  db: FenceQueryable,
  turnId: string,
  token: string,
  opts: { lock?: boolean } = {},
): Promise<boolean> {
  const { rows } = await db.query(opts.lock === false ? OBSERVED_FENCE_SQL : LOCKED_FENCE_SQL, [turnId, token]);
  return rows[0]?.ok === true;
}
