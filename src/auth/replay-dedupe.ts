import { createPgPool } from "../persistence/pg-pool.ts";

export interface ReplayDedupe {
  readonly durable: boolean;
  claim(eventId: string, expiresAtMs: number): Promise<boolean>;
}

const PRUNE_INTERVAL_MS = 60_000;

export function createMemoryReplayDedupe(now: () => number = Date.now): ReplayDedupe {
  const seen = new Map<string, number>();
  let nextPruneAt = Number.NEGATIVE_INFINITY;
  return {
    durable: false,
    async claim(eventId, expiresAtMs) {
      const t = now();
      if (t >= nextPruneAt) {
        nextPruneAt = t + PRUNE_INTERVAL_MS;
        for (const [id, exp] of seen) if (exp < t) seen.delete(id);
      }
      const existing = seen.get(eventId);
      if (existing !== undefined && existing >= t) return false;
      seen.set(eventId, expiresAtMs);
      return true;
    },
  };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS source_auth_replay (
  event_id TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS source_auth_replay_expires_at ON source_auth_replay (expires_at)`,
];

export function createPostgresReplayDedupe(connectionString: string): ReplayDedupe {
  const pg = createPgPool(connectionString, SCHEMA);
  let nextPruneAt = Number.NEGATIVE_INFINITY;
  return {
    durable: true,
    async claim(eventId, expiresAtMs) {
      const t = Date.now();
      if (t >= nextPruneAt) {
        nextPruneAt = t + PRUNE_INTERVAL_MS;
        await pg.query("DELETE FROM source_auth_replay WHERE expires_at < to_timestamp($1 / 1000.0)", [t]);
      }
      const res = await pg.query(
        `INSERT INTO source_auth_replay (event_id, expires_at)
         VALUES ($1, to_timestamp($2 / 1000.0))
         ON CONFLICT (event_id) DO NOTHING`,
        [eventId, expiresAtMs],
      );
      return res.rowCount === 1;
    },
  };
}
