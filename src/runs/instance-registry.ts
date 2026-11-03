import type { PgMigrationDefinition, PgPool } from "../persistence/pg-pool.ts";

export const INSTANCE_HEARTBEAT_MIGRATIONS: readonly PgMigrationDefinition[] = [
  {
    id: "runs/instance-heartbeats/0001",
    statements: [
      `CREATE TABLE IF NOT EXISTS instance_heartbeats(
         instance_id TEXT PRIMARY KEY,
         build_sha TEXT NOT NULL,
         started_at BIGINT NOT NULL,
         beat_at TIMESTAMPTZ NOT NULL
       )`,
    ],
  },
];

export interface InstanceRegistry {
  beat(): Promise<boolean>;
}

const INSTANCE_LIVENESS_MS = 30_000;

export function createNoopInstanceRegistry(): InstanceRegistry {
  return { beat: async () => false };
}

export function createPostgresInstanceRegistry(
  pg: PgPool,
  opts: { instanceId: string; buildSha: string; startedAt: number; livenessMs?: number },
): InstanceRegistry {
  const livenessMs = opts.livenessMs ?? INSTANCE_LIVENESS_MS;
  for (const migration of INSTANCE_HEARTBEAT_MIGRATIONS) pg.registerMigration(migration);

  return {
    async beat(): Promise<boolean> {
      await pg.query(
        `INSERT INTO instance_heartbeats(instance_id, build_sha, started_at, beat_at)
           VALUES ($1, $2, $3, now())
         ON CONFLICT (instance_id) DO UPDATE SET beat_at = now()`,
        [opts.instanceId, opts.buildSha, String(opts.startedAt)],
      );
      await pg.query(`DELETE FROM instance_heartbeats WHERE beat_at < now() - interval '1 hour'`, []);
      const { rowCount } = await pg.query(
        `SELECT 1 FROM instance_heartbeats
          WHERE build_sha <> $1 AND started_at > $2
            AND beat_at > now() - ($3 || ' milliseconds')::interval
          LIMIT 1`,
        [opts.buildSha, String(opts.startedAt), String(livenessMs)],
      );
      return rowCount > 0;
    },
  };
}
