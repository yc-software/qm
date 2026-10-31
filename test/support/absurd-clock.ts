import pg from "pg";
import { TURN_QUEUES } from "../../src/turns/absurd-schema.ts";
import { createTurnLedger, TURN_READY_CHANNEL, type TurnLedger } from "../../src/turns/turn-ledger.ts";

export function turnLedgerAt(databaseUrl: string, at: number): TurnLedger {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c absurd.fake_now=${new Date(at).toISOString()}`);
  return createTurnLedger(url.toString());
}

export async function retryDue(databaseUrl: string, opts: { taskId?: string; inMs?: number } = {}): Promise<number> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    let moved = 0;
    for (const queue of TURN_QUEUES) {
      const table = `absurd.${pg.escapeIdentifier(`r_${queue}`)}`;
      const { rowCount } = await client.query(
        `UPDATE ${table} r SET available_at = absurd.current_time() + make_interval(secs => $2::double precision / 1000)
          WHERE r.state = 'sleeping' AND r.wake_event IS NULL AND ($1::uuid IS NULL OR r.task_id = $1)
            AND EXISTS (SELECT 1 FROM ${table} f WHERE f.task_id = r.task_id AND f.state = 'failed')`,
        [opts.taskId ?? null, opts.inMs ?? 0],
      );
      if (rowCount) await client.query("SELECT pg_notify($1, $2)", [TURN_READY_CHANNEL, JSON.stringify(queue)]);
      moved += rowCount ?? 0;
    }
    return moved;
  } finally {
    await client.end();
  }
}

export async function taskQueues(databaseUrl: string, taskIds: (string | null)[]): Promise<(string | null)[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const found = new Map<string, string>();
    for (const queue of TURN_QUEUES) {
      const { rows } = await client.query(
        `SELECT task_id FROM absurd.${pg.escapeIdentifier(`t_${queue}`)} WHERE task_id = ANY($1::uuid[])`,
        [taskIds.filter((id) => id !== null)],
      );
      for (const row of rows) found.set(String(row.task_id), queue);
    }
    return taskIds.map((id) => (id === null ? null : (found.get(id) ?? null)));
  } finally {
    await client.end();
  }
}
