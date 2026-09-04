import { createPgPool, type PgPool, type PoolClient } from "./pg-pool.ts";

export interface DurableMap<T> {
  all(): Promise<T[]>;
  entries(): Promise<Array<[string, T]>>;
  get(id: string): Promise<T | null>;
  put(id: string, value: T): Promise<void>;
  putIfAbsent(id: string, value: T): Promise<T>;
  insertIfAbsent?(id: string, value: T): Promise<boolean>;
  merge(id: string, patch: Partial<T>): Promise<T | null>;
  update?(id: string, fn: (value: T) => T): Promise<T | null>;
  deleteIf?(id: string, predicate: (value: T) => boolean): Promise<boolean>;
  delete(id: string): Promise<void>;
  take(id: string): Promise<T | null>;
}

/**
 * Serialize for a Postgres jsonb column. jsonb rejects two things a JS string
 * happily carries: NUL (\u0000) and unpaired surrogate halves — and qm's own
 * truncation helpers can manufacture the latter by slicing mid-emoji. The
 * memory map accepts those values, so production diverged from every
 * in-memory test. Sanitize at the serialization boundary: drop NULs and
 * replace lone surrogates with U+FFFD, recursively, only when a string
 * actually needs it.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function jsonbSafeString(s: string): string {
  let out = s;
  if (out.includes("\u0000")) out = out.replaceAll("\u0000", "");
  if (LONE_SURROGATE.test(out)) out = out.replace(LONE_SURROGATE, "\uFFFD");
  return out;
}

function jsonbSafe(value: unknown): unknown {
  if (typeof value === "string") return jsonbSafeString(value);
  if (Array.isArray(value)) return value.map(jsonbSafe);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[jsonbSafeString(k)] = jsonbSafe(v);
    return out;
  }
  return value;
}

export function jsonbStringify(value: unknown): string {
  return JSON.stringify(jsonbSafe(value));
}

function applyPatch<T>(value: T, patch: Partial<T>): T {
  const next = { ...value } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return next as T;
}

export function createMemoryMap<T>(): DurableMap<T> {
  const m = new Map<string, T>();
  const sortedEntries = () =>
    [...m.entries()].sort(([a], [b]) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });
  return {
    async all() {
      return sortedEntries().map(([, v]) => v);
    },
    async entries() {
      return sortedEntries();
    },
    async get(id) {
      return m.get(id) ?? null;
    },
    async put(id, value) {
      m.set(id, value);
    },
    async putIfAbsent(id, value) {
      const existing = m.get(id);
      if (existing !== undefined) return existing;
      m.set(id, value);
      return value;
    },
    async insertIfAbsent(id, value) {
      if (m.has(id)) return false;
      m.set(id, value);
      return true;
    },
    async merge(id, patch) {
      const v = m.get(id);
      if (v == null) return null;
      const merged = applyPatch(v, patch);
      m.set(id, merged);
      return merged;
    },
    async update(id, fn) {
      const v = m.get(id);
      if (v == null) return null;
      const next = fn(v);
      m.set(id, next);
      return next;
    },
    async deleteIf(id, predicate) {
      const value = m.get(id);
      if (value === undefined || !predicate(value)) return false;
      m.delete(id);
      return true;
    },
    async delete(id) {
      m.delete(id);
    },
    async take(id) {
      const v = m.get(id) ?? null;
      m.delete(id);
      return v;
    },
  };
}

const VERSIONS_TABLE = "durable_map_versions";

export function createPostgresMap<T>(pg: PgPool, table: string): DurableMap<T> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error(`invalid table name: ${table}`);
  let readyP: Promise<void> | null = null;
  function ready(): Promise<void> {
    if (!readyP) {
      const statements = [
        `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS ${VERSIONS_TABLE} (tbl TEXT PRIMARY KEY, v BIGINT NOT NULL)`,
      ];
      readyP = (async () => {
        for (const sql of statements) await (pg.schema ? pg.schema(sql) : pg.query(sql));
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
    const client = await (await pg.pool()).connect();
    try {
      await client.query("BEGIN");
      await client.query(bumpSql);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
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
  return {
    async all() {
      return (await snapshot()).map(([, value]) => value);
    },
    async entries() {
      return snapshot();
    },
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
  map<T>(table: string): DurableMap<T>;
  pool: PgPool;
}

export function createPostgresMapFactory(connectionString: string): PostgresArtifactMaps {
  const pg = createPgPool(connectionString, []);
  return { map: <T>(table: string): DurableMap<T> => createPostgresMap<T>(pg, table), pool: pg };
}
