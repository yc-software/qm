import { createPgPool } from "../persistence/pg-pool.ts";
import {
  activityCreatedAt,
  RUN_ACTIVITY_TTL_MS,
  type RunActivityEntry,
  type RunActivityStore,
} from "./run-activity-store.ts";
import type { Item } from "../sessions/items.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS run_activity(
    id BIGSERIAL PRIMARY KEY,
    run_id TEXT NOT NULL,
    seq BIGINT NOT NULL,
    parent_seq BIGINT,
    type TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_run_activity_run ON run_activity(run_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_run_activity_created ON run_activity(created_at)`,
];

const PRUNE_INTERVAL_MS = 60_000;

export function createPostgresRunActivityStore(connectionString: string): RunActivityStore {
  const pg = createPgPool(connectionString, "runs/activity/0001", SCHEMA);
  const q = pg.query;
  let nextPruneAt = Number.NEGATIVE_INFINITY;

  return {
    async append(runId, entry) {
      const t = Date.now();
      if (t >= nextPruneAt) {
        nextPruneAt = t + PRUNE_INTERVAL_MS;
        await q("DELETE FROM run_activity WHERE created_at < $1", [t - RUN_ACTIVITY_TTL_MS]);
      }
      const [type, seq, payload] =
        "item" in entry ? ["item", entry.item.seq, entry.item] : [entry.marker, entry.seq, entry];
      await q(
        `INSERT INTO run_activity(run_id, seq, type, payload, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [runId, seq, type, JSON.stringify(payload), activityCreatedAt(entry)],
      );
    },

    async list(runId) {
      const { rows } = await q(
        `SELECT type, payload FROM run_activity WHERE run_id=$1 AND type IN ('item', 'text_start', 'sandbox_status') ORDER BY id`,
        [runId],
      );
      return rows.map((r): RunActivityEntry =>
        r.type === "item" ? { item: r.payload as Item } : (r.payload as RunActivityEntry),
      );
    },

    async close() {
      await pg.close();
    },
  };
}
