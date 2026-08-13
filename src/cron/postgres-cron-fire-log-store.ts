import type { PoolClient } from "pg";
import { type PgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import type { Cron, CronFireLogEntry } from "../types.ts";
import { CRON_FIRE_LOG_LIMIT, mergeCronFireLogs, type CronFireLogStore } from "./cron-fire-log-store.ts";

const VERSIONS_TABLE = "durable_map_versions";

function safeTableName(table: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error(`invalid table name: ${table}`);
  return table;
}

export function createPostgresCronFireLogStore(
  pg: PgPool,
  options: { crons?: string; fires?: string; buildSha?: string } = {},
): CronFireLogStore {
  const crons = safeTableName(options.crons ?? "crons");
  const fires = safeTableName(options.fires ?? "cron_fire_log");
  const state = safeTableName(`${fires}_state`);
  let readyP: Promise<void> | null = null;

  async function applySchema(): Promise<void> {
    const statements = [
      `CREATE TABLE IF NOT EXISTS ${crons} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${VERSIONS_TABLE} (tbl TEXT PRIMARY KEY, v BIGINT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${fires}(
         id BIGSERIAL PRIMARY KEY,
         cron_id TEXT NOT NULL REFERENCES ${crons}(id) ON DELETE CASCADE,
         fire_key TEXT NOT NULL,
         fired_at BIGINT NOT NULL,
         entry JSONB NOT NULL,
         UNIQUE(cron_id, fire_key)
       )`,
      `CREATE INDEX IF NOT EXISTS ${fires}_by_cron_fire ON ${fires}(cron_id, fired_at DESC, id DESC)`,
      `CREATE TABLE IF NOT EXISTS ${state}(
         singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
         build_sha TEXT NOT NULL,
         dual_write_until TIMESTAMPTZ NOT NULL
       )`,
    ];
    for (const statement of statements) await (pg.schema ? pg.schema(statement) : pg.query(statement));
    if (options.buildSha) {
      await pg.query(
        `INSERT INTO ${state}(singleton, build_sha, dual_write_until)
         VALUES (TRUE, $1, now() + interval '1 hour')
         ON CONFLICT (singleton) DO UPDATE
           SET build_sha = EXCLUDED.build_sha,
               dual_write_until = EXCLUDED.dual_write_until
         WHERE ${state}.build_sha IS DISTINCT FROM EXCLUDED.build_sha`,
        [options.buildSha],
      );
    }
  }

  async function migrate(client: PoolClient, cronIds?: string[]): Promise<number> {
    const changed = `(NOT (json ? '_cronFireLogHash') OR json->>'_cronFireLogHash' IS DISTINCT FROM md5((json->'fireLog')::text))`;
    const where = cronIds
      ? `WHERE id = ANY($1::text[]) AND json ? 'fireLog' AND ${changed}`
      : `WHERE json ? 'fireLog' AND ${changed}`;
    const filterParams = cronIds ? [cronIds] : [];
    const pending = await client.query(`SELECT EXISTS(SELECT 1 FROM ${crons} ${where}) AS found`, filterParams);
    if (pending.rows[0]?.found !== true) return 0;
    await client.query(
      `INSERT INTO ${VERSIONS_TABLE}(tbl, v) VALUES ($1, 1)
       ON CONFLICT (tbl) DO UPDATE SET v = ${VERSIONS_TABLE}.v + 1`,
      [crons],
    );
    const params: unknown[] = [...filterParams];
    const limit = params.push(CRON_FIRE_LOG_LIMIT);
    const migrated = await client.query(
      `WITH locked AS MATERIALIZED (
         SELECT id, json FROM ${crons} ${where} ORDER BY id FOR UPDATE
       ), expanded AS (
         SELECT l.id AS cron_id, item.entry, item.ordinality
           FROM locked l
           CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(l.json->'fireLog') = 'array' THEN l.json->'fireLog' ELSE '[]'::jsonb END
           ) WITH ORDINALITY AS item(entry, ordinality)
          WHERE jsonb_typeof(item.entry) = 'object'
            AND item.entry ? 'fireKey'
            AND item.entry ? 'firedAt'
       ), entries AS (
         SELECT DISTINCT ON (cron_id, entry->>'fireKey') cron_id, entry
           FROM expanded
          ORDER BY cron_id, entry->>'fireKey', ordinality DESC
       ), capped AS (
         SELECT l.id,
                COALESCE((
                  SELECT jsonb_agg(recent.entry ORDER BY recent.ordinality)
                    FROM (
                      SELECT item.entry, item.ordinality
                        FROM jsonb_array_elements(
                          CASE WHEN jsonb_typeof(l.json->'fireLog') = 'array'
                            THEN l.json->'fireLog' ELSE '[]'::jsonb END
                        ) WITH ORDINALITY AS item(entry, ordinality)
                       ORDER BY item.ordinality DESC
                       LIMIT $${limit}
                    ) recent
                ), '[]'::jsonb) AS fire_log
           FROM locked l
       ), inserted AS (
         INSERT INTO ${fires}(cron_id, fire_key, fired_at, entry)
         SELECT cron_id, entry->>'fireKey', (entry->>'firedAt')::bigint, entry
           FROM entries
         ON CONFLICT (cron_id, fire_key) DO UPDATE
           SET fired_at = EXCLUDED.fired_at,
               entry = ${fires}.entry || EXCLUDED.entry
         RETURNING id
       ), retained AS (
         UPDATE ${crons} c
            SET json = jsonb_set(
              jsonb_set(c.json, '{fireLog}', capped.fire_log),
              '{_cronFireLogHash}',
              to_jsonb(md5(capped.fire_log::text))
            )
           FROM capped
          WHERE c.id = capped.id
         RETURNING c.id
       )
       SELECT (SELECT COUNT(*)::int FROM retained) AS migrated`,
      params,
    );
    return Number(migrated.rows[0]?.migrated ?? 0);
  }

  async function bumpCronVersion(client: PoolClient): Promise<void> {
    await client.query(
      `INSERT INTO ${VERSIONS_TABLE}(tbl, v) VALUES ($1, 1)
       ON CONFLICT (tbl) DO UPDATE SET v = ${VERSIONS_TABLE}.v + 1`,
      [crons],
    );
  }

  async function mixedVersionLive(client: PoolClient): Promise<boolean> {
    if (!options.buildSha) return false;
    const rollout = await client.query(
      `SELECT dual_write_until > now() AS active FROM ${state} WHERE singleton = TRUE`,
    );
    if (rollout.rows[0]?.active === true) return true;
    const relation = await client.query("SELECT to_regclass('instance_heartbeats') AS name");
    if (relation.rows[0]?.name == null) return false;
    const active = await client.query(
      `SELECT 1 FROM instance_heartbeats
        WHERE build_sha <> $1 AND beat_at > now() - interval '30 seconds'
        LIMIT 1`,
      [options.buildSha],
    );
    return Boolean(active.rows[0]);
  }

  async function prune(client: PoolClient, cronIds?: string[]): Promise<void> {
    const params: unknown[] = [];
    const where = cronIds ? `WHERE cron_id = ANY($${params.push(cronIds)}::text[])` : "";
    const limit = params.push(CRON_FIRE_LOG_LIMIT);
    await client.query(
      `DELETE FROM ${fires}
        WHERE id IN (
          SELECT id FROM (
            SELECT id, row_number() OVER (PARTITION BY cron_id ORDER BY fired_at DESC, id DESC) AS position
              FROM ${fires} ${where}
          ) ranked
          WHERE position > $${limit}
        )`,
      params,
    );
  }

  async function initialize(): Promise<void> {
    await applySchema();
    await withPgTransaction(await pg.pool(), async (client) => {
      await migrate(client);
      await prune(client);
    });
  }

  function ready(): Promise<void> {
    if (!readyP) {
      readyP = initialize().catch((error) => {
        readyP = null;
        throw error;
      });
    }
    return readyP;
  }

  return {
    async list(cronIds) {
      await ready();
      if (!cronIds.length) return new Map();
      await withPgTransaction(await pg.pool(), async (client) => {
        await migrate(client, cronIds);
        await prune(client, cronIds);
      });
      const rows = await pg.q(
        `SELECT cron_id, entry FROM ${fires}
          WHERE cron_id = ANY($1::text[])
          ORDER BY cron_id, fired_at, id`,
        [cronIds],
      );
      const result = new Map<string, CronFireLogEntry[]>();
      for (const row of rows) {
        const cronId = String(row.cron_id);
        const entries = result.get(cronId) ?? [];
        entries.push(row.entry as CronFireLogEntry);
        result.set(cronId, entries);
      }
      return result;
    },
    async record(cronId, entry) {
      await ready();
      await withPgTransaction(await pg.pool(), async (client) => {
        const dualWrite = await mixedVersionLive(client);
        if (dualWrite) await bumpCronVersion(client);
        await migrate(client, [cronId]);
        const parent = await client.query(`SELECT json FROM ${crons} WHERE id = $1 FOR UPDATE`, [cronId]);
        if (!parent.rows[0]) return;
        await client.query(
          `INSERT INTO ${fires}(cron_id, fire_key, fired_at, entry)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (cron_id, fire_key) DO UPDATE
             SET fired_at = EXCLUDED.fired_at,
                 entry = ${fires}.entry || EXCLUDED.entry`,
          [cronId, entry.fireKey, entry.firedAt, JSON.stringify(entry)],
        );
        await prune(client, [cronId]);
        if (dualWrite) {
          const cron = parent.rows[0].json as Cron;
          const inline = mergeCronFireLogs(cron.fireLog ?? [], [entry]);
          await client.query(
            `UPDATE ${crons}
                SET json = jsonb_set(
                  jsonb_set(json, '{fireLog}', $2::jsonb),
                  '{_cronFireLogHash}',
                  to_jsonb(md5(($2::jsonb)::text))
                )
              WHERE id = $1`,
            [cronId, JSON.stringify(inline)],
          );
        }
      });
    },
    async delete() {},
  };
}
