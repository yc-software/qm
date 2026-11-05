import { createPgPool, withPgTransaction, type PgPool, type PoolClient } from "./pg-pool.ts";
import { jsonbStringify } from "../util/text.ts";

export interface DurableMapSelect<T, K extends Extract<keyof T, string>> {
  omit?: readonly K[];
  pickNested?: Partial<Record<Extract<keyof T, string>, readonly string[]>>;
  where?: { field: Extract<keyof T, string>; anyOfFold: readonly string[] };
  limit?: number;
  afterId?: string;
}

export interface DurableMap<T> {
  all(): Promise<T[]>;
  entries(): Promise<Array<[string, T]>>;
  select<K extends Extract<keyof T, string> = never>(query: DurableMapSelect<T, K>): Promise<Array<Omit<T, K>>>;
  selectEntries<K extends Extract<keyof T, string> = never>(
    query: DurableMapSelect<T, K>,
  ): Promise<Array<[string, Omit<T, K>]>>;
  get(id: string): Promise<T | null>;
  put(id: string, value: T): Promise<void>;
  putIfAbsent(id: string, value: T): Promise<T>;
  insertIfAbsent(id: string, value: T): Promise<boolean>;
  merge(id: string, patch: Partial<T>): Promise<T | null>;
  update(id: string, fn: (value: T) => T): Promise<T | null>;
  mutateMany(updates: readonly { id: string; apply: (value: T | null) => T }[]): Promise<T[]>;
  deleteIf(id: string, predicate: (value: T) => boolean): Promise<boolean>;
  delete(id: string): Promise<void>;
  take(id: string): Promise<T | null>;
}

const VERSIONS_TABLE = "durable_map_versions";

export function createPostgresMap<T>(
  pg: PgPool,
  table: string,
  indexedFields: readonly Extract<keyof T, string>[] = [],
): DurableMap<T> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error(`invalid table name: ${table}`);
  const migration = {
    id: `durable-map/${table}/0001`,
    statements: [
      `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${VERSIONS_TABLE} (tbl TEXT PRIMARY KEY, v BIGINT NOT NULL)`,
    ],
  };
  const migrations = [
    migration,
    ...indexedFields.flatMap((field) => {
      if (!/^[a-z_][a-z0-9_]*$/i.test(field)) throw new Error(`invalid index field: ${field}`);
      return [
        {
          id: `durable-map/${table}/lookup-${field.toLowerCase()}-drop`,
          statements: [`SET LOCAL lock_timeout = '3s'`, `DROP INDEX IF EXISTS ${table}_${field.toLowerCase()}_fold`],
        },
        {
          id: `durable-map/${table}/lookup-${field.toLowerCase()}-hash`,
          statements: [
            `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${table}_${field.toLowerCase()}_fold
           ON ${table} USING hash (lower(json->>'${field}'))`,
          ],
        },
        {
          id: `durable-map/${table}/select-${field.toLowerCase()}`,
          statements: [
            `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${table}_${field.toLowerCase()}_fold
           ON ${table} (lower(json->>'${field}'))`,
            `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${table}_${field.toLowerCase()}_unicode
           ON ${table} (id) WHERE json->>'${field}' ~ '[^\\x01-\\x7f]'`,
          ],
        },
        {
          id: `durable-map/${table}/stats-${field.toLowerCase()}`,
          statements: [
            `SET LOCAL lock_timeout = '3s'`,
            `CREATE STATISTICS IF NOT EXISTS ${table}_${field.toLowerCase()}_stats ON (json->>'${field}') FROM ${table}`,
            `ANALYZE ${table}`,
          ],
        },
      ];
    }),
  ];
  for (const definition of migrations) pg.registerMigration(definition);
  let readyP: Promise<void> | null = null;
  function ready(): Promise<void> {
    if (!readyP) {
      readyP = (async () => {
        for (const definition of migrations) await pg.migrate(definition);
      })().catch((e) => {
        readyP = null;
        throw e;
      });
    }
    return readyP;
  }
  const bumpSql = `INSERT INTO ${VERSIONS_TABLE} (tbl, v) VALUES ('${table}', 1)
     ON CONFLICT (tbl) DO UPDATE SET v = ${VERSIONS_TABLE}.v + 1`;
  async function withBump<R>(fn: (client: PoolClient) => Promise<R>): Promise<R> {
    await ready();
    return withPgTransaction(await pg.pool(), async (client) => {
      await client.query(bumpSql);
      return fn(client);
    });
  }
  const CACHE_MAX_AGE_MS = 15_000;
  let cache: { v: string; fetchedAt: number; entries: Array<[string, T]> } | null = null;
  async function snapshot(): Promise<Array<[string, T]>> {
    await ready();
    const vRows = await pg.q(`SELECT v FROM ${VERSIONS_TABLE} WHERE tbl = '${table}'`);
    const v = vRows.length ? String(vRows[0]!.v) : "";
    if (!cache || cache.v !== v || Date.now() - cache.fetchedAt > CACHE_MAX_AGE_MS) {
      const rows = await pg.q(`SELECT id, json FROM ${table} ORDER BY id`);
      cache = { v, fetchedAt: Date.now(), entries: rows.map((row) => [row.id as string, row.json as T]) };
    }
    return structuredClone(cache.entries);
  }
  async function selectRows<K extends Extract<keyof T, string>>(
    query: DurableMapSelect<T, K>,
  ): Promise<Array<[string, Omit<T, K>]>> {
    await ready();
    const params: unknown[] = [[...(query.omit ?? [])]];
    let projection = "json";
    for (const [field, keys] of Object.entries(query.pickNested ?? {})) {
      params.push(field, keys);
      const fieldParam = `$${params.length - 1}`;
      const keysParam = `$${params.length}`;
      const nested = `CASE WHEN jsonb_typeof(json->${fieldParam}) = 'object' THEN
          COALESCE((SELECT jsonb_object_agg(key, value) FROM jsonb_each(json->${fieldParam})
            WHERE key = ANY(${keysParam}::text[])), '{}'::jsonb) ELSE json->${fieldParam} END`;
      projection = `(${projection} || CASE WHEN json ? ${fieldParam} THEN
          jsonb_build_object(${fieldParam}::text, ${nested}) ELSE '{}'::jsonb END)`;
    }
    let sql = `SELECT id, ${projection} - $1::text[] AS json FROM ${table}`;
    if (query.where) {
      const field = query.where.field;
      if (!/^[a-z_][a-z0-9_]*$/i.test(field)) throw new Error(`invalid select field: ${field}`);
      params.push(query.where.anyOfFold.map((v) => v.toLowerCase()));
      sql += ` WHERE id IN (
          SELECT id FROM ${table} WHERE lower(json->>'${field}') = ANY($${params.length}::text[])
          UNION
          SELECT id FROM ${table} WHERE json->>'${field}' ~ '[^\\x01-\\x7f]')`;
    }
    if (query.afterId !== undefined) {
      params.push(query.afterId);
      sql += `${query.where ? " AND" : " WHERE"} id > $${params.length}`;
    }
    sql += " ORDER BY id";
    if (query.limit !== undefined) {
      params.push(query.limit);
      sql += ` LIMIT $${params.length}`;
    }
    const rows = await pg.q(sql, params);
    return rows.map((row) => [row.id as string, row.json as Omit<T, K>]);
  }
  return {
    async all() {
      return (await snapshot()).map(([, value]) => value);
    },
    async entries() {
      return snapshot();
    },
    async select<K extends Extract<keyof T, string> = never>(query: DurableMapSelect<T, K>) {
      return (await selectRows(query)).map(([, value]) => value);
    },
    selectEntries: selectRows,
    async get(id) {
      await ready();
      const rows = await pg.q(`SELECT json FROM ${table} WHERE id = $1`, [id]);
      return rows.length ? (rows[0]!.json as T) : null;
    },
    async put(id, value) {
      await withBump((client) =>
        client.query(
          `INSERT INTO ${table} (id, json) VALUES ($1, $2)
           ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json`,
          [id, jsonbStringify(value)],
        ),
      );
    },
    async putIfAbsent(id, value) {
      const res = await withBump((client) =>
        client.query(
          `INSERT INTO ${table} (id, json) VALUES ($1, $2)
           ON CONFLICT (id) DO UPDATE SET json = ${table}.json
           RETURNING json`,
          [id, jsonbStringify(value)],
        ),
      );
      return res.rows[0]!.json as T;
    },
    async insertIfAbsent(id, value) {
      const inserted = await withBump((client) =>
        client.query(
          `INSERT INTO ${table} (id, json) VALUES ($1, $2)
           ON CONFLICT (id) DO NOTHING`,
          [id, jsonbStringify(value)],
        ),
      );
      return (inserted.rowCount ?? 0) > 0;
    },
    async merge(id, patch) {
      const entries = Object.entries(patch);
      const removeKeys = entries.filter(([, v]) => v === undefined).map(([k]) => k);
      const set = Object.fromEntries(entries.filter(([, v]) => v !== undefined));
      const res = await withBump((client) =>
        client.query(`UPDATE ${table} SET json = (json - $2::text[]) || $3::jsonb WHERE id = $1 RETURNING json`, [
          id,
          removeKeys,
          jsonbStringify(set),
        ]),
      );
      return res.rows.length ? (res.rows[0]!.json as T) : null;
    },
    async update(id, fn) {
      return withBump(async (client) => {
        const current = await client.query(`SELECT json FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
        if (!current.rows[0]) return null;
        const next = fn(current.rows[0].json as T);
        await client.query(`UPDATE ${table} SET json = $2 WHERE id = $1`, [id, jsonbStringify(next)]);
        return next;
      });
    },
    async mutateMany(updates) {
      if (!updates.length) return [];
      return withBump(async (client) => {
        const rows = await client.query(
          `SELECT id, json FROM ${table} WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`,
          [updates.map(({ id }) => id)],
        );
        const current = new Map(rows.rows.map((row) => [row.id as string, row.json as T]));
        const pending = new Map<string, T>();
        const results = updates.map(({ id, apply }) => {
          const next = apply(structuredClone(pending.get(id) ?? current.get(id) ?? null));
          pending.set(id, next);
          return next;
        });
        await client.query(
          `INSERT INTO ${table} (id, json) SELECT id, json FROM jsonb_to_recordset($1::jsonb) AS batch(id text, json jsonb)
           ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json`,
          [jsonbStringify([...pending].map(([id, json]) => ({ id, json })))],
        );
        return results;
      });
    },
    async deleteIf(id, predicate) {
      return withBump(async (client) => {
        const current = await client.query(`SELECT json FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
        if (!current.rows[0] || !predicate(current.rows[0].json as T)) return false;
        await client.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
        return true;
      });
    },
    async delete(id) {
      await withBump((client) => client.query(`DELETE FROM ${table} WHERE id = $1`, [id]));
    },
    async take(id) {
      const res = await withBump((client) => client.query(`DELETE FROM ${table} WHERE id = $1 RETURNING json`, [id]));
      return res.rows.length ? (res.rows[0]!.json as T) : null;
    },
  };
}

export interface PostgresArtifactMaps {
  map<T>(table: string, indexedFields?: readonly Extract<keyof T, string>[]): DurableMap<T>;
  pool: PgPool;
}

export function createPostgresMapFactory(connectionString: string): PostgresArtifactMaps {
  const pg = createPgPool(connectionString);
  return {
    map: <T>(table: string, indexedFields?: readonly Extract<keyof T, string>[]): DurableMap<T> =>
      createPostgresMap<T>(pg, table, indexedFields),
    pool: pg,
  };
}
