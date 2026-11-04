import type { PgPool } from "../persistence/pg-pool.ts";

export interface InstanceRegistry {
  beat(): Promise<boolean>;
  retire(): Promise<void>;
}

const INSTANCE_LIVENESS_MS = 30_000;

export function createNoopInstanceRegistry(): InstanceRegistry {
  return { beat: async () => false, retire: async () => {} };
}

export function createPostgresInstanceRegistry(
  pg: PgPool,
  opts: { instanceId: string; deploymentKey: string; startedAt: number; livenessMs?: number },
): InstanceRegistry {
  const livenessMs = opts.livenessMs ?? INSTANCE_LIVENESS_MS;
  const migration = {
    id: "runs/instance-heartbeats/0001",
    statements: [
      `CREATE TABLE IF NOT EXISTS instance_heartbeats(
             instance_id TEXT PRIMARY KEY,
             build_sha TEXT NOT NULL,
             started_at BIGINT NOT NULL,
             beat_at TIMESTAMPTZ NOT NULL
           )`,
    ],
  };
  pg.registerMigration(migration);
  let readyP: Promise<void> | null = null;
  function ready(): Promise<void> {
    if (!readyP) {
      readyP = pg.migrate(migration).catch((e: unknown) => {
        readyP = null;
        throw e;
      });
    }
    return readyP;
  }

  return {
    async beat(): Promise<boolean> {
      await ready();
      await pg.query(
        `INSERT INTO instance_heartbeats(instance_id, build_sha, started_at, beat_at)
           VALUES ($1, $2, $3, now())
         ON CONFLICT (instance_id) DO UPDATE SET beat_at = now()`,
        [opts.instanceId, opts.deploymentKey, String(opts.startedAt)],
      );
      await pg.query(
        `DELETE FROM instance_heartbeats stale
          WHERE NOT EXISTS (
            SELECT 1 FROM instance_heartbeats recent
             WHERE recent.build_sha = stale.build_sha AND recent.beat_at > now() - interval '1 hour'
          )`,
        [],
      );
      const { rowCount } = await pg.query(
        `WITH deployments AS (
           SELECT build_sha, min(started_at) AS started_at, max(beat_at) AS beat_at
             FROM instance_heartbeats GROUP BY build_sha
         )
         SELECT 1 FROM deployments other JOIN deployments own ON own.build_sha = $1
          WHERE other.build_sha <> $1 AND other.started_at > own.started_at
            AND other.beat_at > now() - ($2 || ' milliseconds')::interval
          LIMIT 1`,
        [opts.deploymentKey, String(livenessMs)],
      );
      return rowCount > 0;
    },
    async retire(): Promise<void> {
      if (!readyP) return;
      await pg.query(
        `UPDATE instance_heartbeats SET beat_at = now() - ($2 || ' milliseconds')::interval WHERE instance_id = $1`,
        [opts.instanceId, String(livenessMs)],
      );
    },
  };
}
