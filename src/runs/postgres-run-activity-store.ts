import { createPgPool } from "../persistence/pg-pool.ts";
import type { Item } from "../sessions/items.ts";
import { RUN_ACTIVITY_TTL_MS, type RunActivityEntry, type RunActivityStore } from "./run-activity-store.ts";

const PRUNE_INTERVAL_MS = 60_000;

export function createPostgresRunActivityStore(connectionString: string): RunActivityStore {
  const pg = createPgPool(connectionString);
  const q = pg.query;
  let nextPruneAt = Number.NEGATIVE_INFINITY;

  return {
    async append(runId, entry) {
      const t = Date.now();
      if (t >= nextPruneAt) {
        nextPruneAt = t + PRUNE_INTERVAL_MS;
        await q("DELETE FROM run_activity WHERE created_at < $1", [t - RUN_ACTIVITY_TTL_MS]);
      }
      const [type, seq, createdAt, payload] =
        "item" in entry
          ? ["item", entry.item.seq, entry.item.createdAt, entry.item]
          : [entry.marker, entry.seq, entry.createdAt, { phase: entry.phase, streamOffset: entry.streamOffset }];
      await q(`INSERT INTO run_activity(run_id, seq, type, payload, created_at) VALUES ($1,$2,$3,$4,$5)`, [
        runId,
        seq,
        type,
        JSON.stringify(payload),
        createdAt,
      ]);
    },

    async list(runId) {
      const { rows } = await q(
        `SELECT seq, type, payload, created_at FROM run_activity
         WHERE run_id=$1 AND type IN ('item', 'text_start') ORDER BY id`,
        [runId],
      );
      return rows.map((r): RunActivityEntry =>
        r.type === "item"
          ? { item: r.payload as Item }
          : { marker: "text_start", seq: Number(r.seq), createdAt: Number(r.created_at), ...(r.payload as object) },
      );
    },

    async close() {
      await pg.close();
    },
  };
}
