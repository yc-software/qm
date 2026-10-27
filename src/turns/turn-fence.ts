import pg from "pg";
import { TURN_QUEUES } from "./absurd-schema.ts";

export interface FenceQueryable {
  query(text: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

function fenceSql(): string {
  const held = TURN_QUEUES.map(
    (queue) => `WHEN '${queue}' THEN EXISTS (
      SELECT 1 FROM absurd.${pg.escapeIdentifier(`r_${queue}`)} r WHERE r.run_id = t.absurd_run_id
        AND ((r.state = 'running' AND r.claimed_by = $2) OR r.state = 'cancelled') FOR SHARE)`,
  ).join("\n");
  return `SELECT CASE t.absurd_queue ${held} ELSE false END AS ok FROM runs t
    WHERE t.id = $1 AND t.status = 'running' AND t.lease_token = $2 AND t.absurd_run_id IS NOT NULL FOR SHARE OF t`;
}

export async function turnFenceHeld(db: FenceQueryable, turnId: string, token: string): Promise<boolean> {
  const { rows } = await db.query(fenceSql(), [turnId, token]);
  return rows[0]?.ok === true;
}
