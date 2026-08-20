import type { CronFireLogEntry } from "../types.ts";
import { jsonbStringify } from "../persistence/durable-map.ts";
import type { PgPool } from "../persistence/pg-pool.ts";

export interface CronFirePage {
  runs: CronFireLogEntry[];
  total: number;
}

export interface CronFireStore {
  ready(): Promise<void>;
  record(cronId: string, entry: CronFireLogEntry): Promise<void>;
  import(cronId: string, entries: CronFireLogEntry[]): Promise<void>;
  list(cronId: string, limit?: number): Promise<CronFirePage>;
  delete(cronId: string): Promise<void>;
}

export function createMemoryCronFireStore(): CronFireStore {
  const byCron = new Map<string, Map<string, CronFireLogEntry>>();
  const record = (cronId: string, entry: CronFireLogEntry) => {
    let entries = byCron.get(cronId);
    if (!entries) {
      entries = new Map();
      byCron.set(cronId, entries);
    }
    entries.set(entry.fireKey, { ...entries.get(entry.fireKey), ...entry });
  };
  return {
    async ready() {},
    async record(cronId, entry) {
      record(cronId, entry);
    },
    async import(cronId, entries) {
      for (const entry of entries) record(cronId, entry);
    },
    async list(cronId, limit) {
      const all = [...(byCron.get(cronId)?.values() ?? [])].sort(
        (a, b) => a.firedAt - b.firedAt || a.fireKey.localeCompare(b.fireKey),
      );
      return { runs: limit === undefined ? all : all.slice(-limit), total: all.length };
    },
    async delete(cronId) {
      byCron.delete(cronId);
    },
  };
}

export function createPostgresCronFireStore(
  pg: PgPool,
  cronTable = "crons",
  fireTable = "cron_fire_log",
): CronFireStore {
  for (const table of [cronTable, fireTable]) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error(`invalid table name: ${table}`);
  }
  const schema = [
    `CREATE TABLE IF NOT EXISTS ${fireTable} (
        cron_id TEXT NOT NULL,
        fire_key TEXT NOT NULL,
        fired_at BIGINT NOT NULL,
        json JSONB NOT NULL,
        PRIMARY KEY (cron_id, fire_key),
        FOREIGN KEY (cron_id) REFERENCES ${cronTable}(id) ON DELETE CASCADE
      )`,
    `CREATE INDEX IF NOT EXISTS ${fireTable}_cron_fired_idx ON ${fireTable} (cron_id, fired_at DESC, fire_key DESC)`,
    `INSERT INTO ${fireTable} (cron_id, fire_key, fired_at, json)
       SELECT source.id, entry->>'fireKey', (entry->>'firedAt')::BIGINT, entry
       FROM ${cronTable} source
       CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(source.json->'fireLog') = 'array' THEN source.json->'fireLog' ELSE '[]'::jsonb END
       ) AS entry
       WHERE entry ? 'fireKey' AND entry ? 'firedAt'
       ON CONFLICT (cron_id, fire_key) DO UPDATE
       SET fired_at = EXCLUDED.fired_at, json = ${fireTable}.json || EXCLUDED.json`,
    `UPDATE ${cronTable} SET json = json - 'fireLog' WHERE json ? 'fireLog'`,
  ];
  let readyP: Promise<void> | undefined;
  const ready = () =>
    (readyP ??= (async () => {
      try {
        if (!pg.schema) throw new Error("cron fire history requires schema-capable Postgres storage");
        for (const statement of schema) await pg.schema(statement);
      } catch (error) {
        readyP = undefined;
        throw error;
      }
    })());
  const importEntries = async (cronId: string, entries: CronFireLogEntry[]) => {
    if (!entries.length) return;
    await ready();
    await pg.query(
      `INSERT INTO ${fireTable} (cron_id, fire_key, fired_at, json)
       SELECT $1, entry->>'fireKey', (entry->>'firedAt')::BIGINT, entry
       FROM jsonb_array_elements($2::jsonb) entry
       ON CONFLICT (cron_id, fire_key) DO UPDATE
       SET fired_at = EXCLUDED.fired_at, json = ${fireTable}.json || EXCLUDED.json`,
      [cronId, jsonbStringify(entries)],
    );
  };
  return {
    ready,
    async record(cronId, entry) {
      await importEntries(cronId, [entry]);
    },
    async import(cronId, entries) {
      await importEntries(cronId, entries);
    },
    async list(cronId, limit) {
      await ready();
      const [count, rows] = await Promise.all([
        pg.q(`SELECT COUNT(*)::BIGINT AS total FROM ${fireTable} WHERE cron_id = $1`, [cronId]),
        limit === undefined
          ? pg.q(`SELECT json FROM ${fireTable} WHERE cron_id = $1 ORDER BY fired_at, fire_key`, [cronId])
          : pg.q(
              `SELECT json FROM (
                 SELECT fired_at, fire_key, json FROM ${fireTable}
                 WHERE cron_id = $1 ORDER BY fired_at DESC, fire_key DESC LIMIT $2
               ) recent ORDER BY fired_at, fire_key`,
              [cronId, limit],
            ),
      ]);
      return { runs: rows.map((row) => row.json as CronFireLogEntry), total: Number(count[0]?.total ?? 0) };
    },
    async delete(cronId) {
      await ready();
      await pg.query(`DELETE FROM ${fireTable} WHERE cron_id = $1`, [cronId]);
    },
  };
}
