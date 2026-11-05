import type { PgPool } from "../persistence/pg-pool.ts";

interface Heartbeat {
  superseded: boolean;
  olderRunning: boolean;
}

export interface InstanceRegistry {
  beat(running: boolean): Promise<Heartbeat>;
  retire(): Promise<void>;
}

const INSTANCE_LIVENESS_MS = 30_000;

export function createNoopInstanceRegistry(): InstanceRegistry {
  return { beat: async () => ({ superseded: false, olderRunning: false }), retire: async () => {} };
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
  const runningColumn = {
    id: "runs/instance-heartbeats/0002",
    statements: [`ALTER TABLE instance_heartbeats ADD COLUMN IF NOT EXISTS running BOOLEAN NOT NULL DEFAULT false`],
  };
  pg.registerMigration(migration);
  pg.registerMigration(runningColumn);
  let readyP: Promise<void> | null = null;
  function ready(): Promise<void> {
    if (!readyP) {
      readyP = pg
        .migrate(migration)
        .then(() => pg.migrate(runningColumn))
        .catch((e: unknown) => {
          readyP = null;
          throw e;
        });
    }
    return readyP;
  }

  return {
    async beat(running: boolean): Promise<Heartbeat> {
      await ready();
      const signal = AbortSignal.timeout(Math.max(1_000, Math.floor(livenessMs / 3)));
      await pg.query(
        `INSERT INTO instance_heartbeats(instance_id, build_sha, started_at, beat_at, running)
           VALUES ($1, $2, $3, now(), $4)
         ON CONFLICT (instance_id) DO UPDATE SET beat_at = now(), running = $4`,
        [opts.instanceId, opts.deploymentKey, String(opts.startedAt), running],
        { signal },
      );
      await pg.query(
        `DELETE FROM instance_heartbeats stale
          WHERE NOT EXISTS (
            SELECT 1 FROM instance_heartbeats recent
             WHERE recent.build_sha = stale.build_sha AND recent.beat_at > now() - interval '1 hour'
          )`,
        [],
        { signal },
      );
      const { rows } = await pg.query(
        `WITH deployments AS (
           SELECT build_sha, min(started_at) AS started_at, max(beat_at) AS beat_at,
                  bool_or(running AND beat_at > now() - ($2 || ' milliseconds')::interval) AS running
             FROM instance_heartbeats GROUP BY build_sha
         )
         SELECT coalesce(bool_or(other.started_at > own.started_at
                                 AND other.beat_at > now() - ($2 || ' milliseconds')::interval), false) AS superseded,
                coalesce(bool_or(other.started_at < own.started_at AND other.running), false) AS older_running
           FROM deployments other JOIN deployments own ON own.build_sha = $1
          WHERE other.build_sha <> $1`,
        [opts.deploymentKey, String(livenessMs)],
        { signal },
      );
      const row = rows[0] as { superseded: boolean; older_running: boolean } | undefined;
      return { superseded: row?.superseded ?? false, olderRunning: row?.older_running ?? false };
    },
    async retire(): Promise<void> {
      if (!readyP) return;
      await pg.query(
        `UPDATE instance_heartbeats SET beat_at = now() - ($2 || ' milliseconds')::interval, running = false
          WHERE instance_id = $1`,
        [opts.instanceId, String(livenessMs)],
      );
    },
  };
}
