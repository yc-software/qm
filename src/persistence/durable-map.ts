import { randomUUID } from "node:crypto";
import { perTenant } from "../tenants/cache.ts";
import {
  createPgPool,
  withPgTransaction,
  type PgMigrationDefinition,
  type PgPool,
  type PoolClient,
} from "./pg-pool.ts";
import { jsonbStringify } from "../util/text.ts";
import { tenantTables, type TenantTable, type TenantTableOptions } from "../tenants/migrations.ts";
import { claimFunction, claimRows, servingTenant, type ClaimedRow } from "../tenants/claim.ts";

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
  claimIds(): Promise<ClaimedRow[]>;
  claimTenants(): Promise<ClaimedRow[]>;
  deleteBefore(field: Extract<keyof T, string>, cutoff: number): Promise<void>;
  claimTenantsWhere(field: Extract<keyof T, string>, value: string): Promise<ClaimedRow[]>;
  version(): Promise<string>;
}

const VERSIONS_TABLE = "durable_map_versions";

const VERSIONS_TENANCY = tenantTables(`durable-map/${VERSIONS_TABLE}/0010-tenants`, [
  { table: VERSIONS_TABLE, primaryKey: "tbl" },
]);

export function durableMapTenancy(
  table: string,
  { tables = [], ...options }: TenantTableOptions & { tables?: readonly TenantTable[] } = {},
): PgMigrationDefinition[] {
  return tenantTables(`durable-map/${table}/0010-tenants`, [{ table, primaryKey: "id" }, ...tables], options);
}

function claimWhereName(table: string, field: string): string {
  return `claim_${table}_by_${field.toLowerCase()}`;
}

function claimTenantsWhereName(table: string, field: string): string {
  return `claim_${table}_tenants_by_${field.toLowerCase()}`;
}

function assertTableName(table: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error(`invalid table name: ${table}`);
}

function mapMigrations(
  table: string,
  indexedFields: readonly string[],
  tenancy: readonly PgMigrationDefinition[],
  extraMigrations: readonly PgMigrationDefinition[],
): PgMigrationDefinition[] {
  assertTableName(table);
  const claim = {
    id: `durable-map/${table}/0020-claim-ids`,
    statements: [claimFunction(`claim_${table}`, "", `SELECT tenant_id, id FROM ${table} ORDER BY tenant_id, id`)],
  };
  const claimTenants = {
    id: `durable-map/${table}/0021-claim-tenants`,
    statements: [
      claimFunction(`claim_${table}_tenants`, "", `SELECT DISTINCT tenant_id, '${table}'::text FROM ${table}`),
    ],
  };
  const servingClaims = {
    id: `durable-map/${table}/0022-serving-claims`,
    statements: [
      claimFunction(
        `claim_${table}`,
        "",
        `SELECT tenant_id, id FROM ${table} WHERE true${servingTenant("tenant_id")} ORDER BY tenant_id, id`,
      ),
      claimFunction(
        `claim_${table}_tenants`,
        "",
        `SELECT DISTINCT tenant_id, '${table}'::text FROM ${table} WHERE true${servingTenant("tenant_id")}`,
      ),
    ],
  };
  const migration = {
    id: `durable-map/${table}/0001`,
    statements: [
      `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS ${VERSIONS_TABLE} (tbl TEXT PRIMARY KEY, v BIGINT NOT NULL)`,
    ],
  };
  return [
    migration,
    ...extraMigrations,
    ...VERSIONS_TENANCY,
    ...tenancy,
    ...(tenancy.length ? [claim, claimTenants, servingClaims] : []),
    ...indexedFields.flatMap((field) => {
      if (!/^[a-z_][a-z0-9_]*$/i.test(field)) throw new Error(`invalid index field: ${field}`);
      return [
        {
          id: `durable-map/${table}/claim-${field.toLowerCase()}`,
          statements: [
            claimFunction(
              claimWhereName(table, field),
              "value text",
              `SELECT tenant_id, id FROM ${table} WHERE lower(json->>'${field}') = lower(value) ORDER BY tenant_id, id`,
            ),
          ],
        },
        {
          id: `durable-map/${table}/claim-tenants-${field.toLowerCase()}`,
          statements: [
            claimFunction(
              claimTenantsWhereName(table, field),
              "value text",
              `SELECT DISTINCT tenant_id, '${table}'::text FROM ${table} WHERE lower(json->>'${field}') = lower(value)`,
            ),
            `DROP FUNCTION IF EXISTS ${claimWhereName(table, field)}(text)`,
          ],
        },
        {
          id: `durable-map/${table}/claim-tenants-${field.toLowerCase()}-serving`,
          statements: [
            claimFunction(
              claimTenantsWhereName(table, field),
              "value text",
              `SELECT DISTINCT tenant_id, '${table}'::text FROM ${table}
                WHERE lower(json->>'${field}') = lower(value)${servingTenant("tenant_id")}`,
            ),
          ],
        },
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
}

export function durableMapMigrations(table: string): PgMigrationDefinition[] {
  return mapMigrations(table, [], durableMapTenancy(table), []);
}

export function processMapMigrations(table: string): PgMigrationDefinition[] {
  return mapMigrations(table, [], [], [processLevelMap(table)]);
}

export function createPostgresMap<T>(
  pg: PgPool,
  table: string,
  indexedFields: readonly Extract<keyof T, string>[] = [],
  tenancyOverride?: readonly PgMigrationDefinition[],
  extraMigrations: readonly PgMigrationDefinition[] = [],
): DurableMap<T> {
  assertTableName(table);
  const tenancy = tenancyOverride ?? durableMapTenancy(table);
  const migrations = mapMigrations(table, indexedFields, tenancy, extraMigrations);
  for (const definition of migrations) pg.registerMigration(definition);
  let readyP: Promise<void> | null = null;
  function ready(): Promise<void> {
    if (!readyP) {
      readyP = pg.migrate(migrations).catch((e) => {
        readyP = null;
        throw e;
      });
    }
    return readyP;
  }
  const tenanted = tenancy.length > 0;
  const key = tenanted ? "tenant_id, id" : "id";
  const bumpSql = `INSERT INTO ${VERSIONS_TABLE} (tbl, v) VALUES ('${table}', 1)
     ON CONFLICT (tenant_id, tbl) DO UPDATE SET v = ${VERSIONS_TABLE}.v + 1`;
  async function withBump<R>(fn: (client: PoolClient) => Promise<R>): Promise<R> {
    await ready();
    return withPgTransaction(await pg.pool(), async (client) => {
      if (tenanted) await client.query(bumpSql);
      return fn(client);
    });
  }
  const CACHE_MAX_AGE_MS = 15_000;
  const caches = perTenant<{ last?: { v: string; fetchedAt: number; entries: Array<[string, T]> } }>(() => ({}));
  async function version(): Promise<string> {
    await ready();
    if (!tenanted) return randomUUID();
    const vRows = await pg.q(`SELECT v FROM ${VERSIONS_TABLE} WHERE tbl = '${table}'`);
    return vRows.length ? String(vRows[0]!.v) : "";
  }
  async function snapshot(): Promise<Array<[string, T]>> {
    await ready();
    if (!tenanted) {
      const rows = await pg.q(`SELECT id, json FROM ${table} ORDER BY id`);
      return rows.map((row) => [row.id as string, row.json as T]);
    }
    const v = await version();
    const cache = caches();
    if (!cache.last || cache.last.v !== v || Date.now() - cache.last.fetchedAt > CACHE_MAX_AGE_MS) {
      const rows = await pg.q(`SELECT id, json FROM ${table} ORDER BY id`);
      cache.last = { v, fetchedAt: Date.now(), entries: rows.map((row) => [row.id as string, row.json as T]) };
    }
    return structuredClone(cache.last.entries);
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
    async claimIds() {
      if (!tenanted) throw new Error(`${table} holds no tenant rows to claim`);
      await ready();
      return claimRows(pg, `claim_${table}`);
    },
    async claimTenants() {
      if (!tenanted) throw new Error(`${table} holds no tenant rows to claim`);
      await ready();
      return claimRows(pg, `claim_${table}_tenants`);
    },
    async deleteBefore(field, cutoff) {
      await withBump((client) =>
        client.query(`DELETE FROM ${table} WHERE (json->>$2)::double precision < $1`, [cutoff, field]),
      );
    },
    async claimTenantsWhere(field, value) {
      if (!indexedFields.includes(field)) throw new Error(`${table}.${field} is not an indexed field`);
      await ready();
      return claimRows(pg, claimTenantsWhereName(table, field), [value]);
    },
    version,
    async get(id) {
      await ready();
      const rows = await pg.q(`SELECT json FROM ${table} WHERE id = $1`, [id]);
      return rows.length ? (rows[0]!.json as T) : null;
    },
    async put(id, value) {
      await withBump((client) =>
        client.query(
          `INSERT INTO ${table} (id, json) VALUES ($1, $2)
           ON CONFLICT (${key}) DO UPDATE SET json = EXCLUDED.json`,
          [id, jsonbStringify(value)],
        ),
      );
    },
    async putIfAbsent(id, value) {
      const res = await withBump((client) =>
        client.query(
          `INSERT INTO ${table} (id, json) VALUES ($1, $2)
           ON CONFLICT (${key}) DO UPDATE SET json = ${table}.json
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
           ON CONFLICT (${key}) DO NOTHING`,
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
           ON CONFLICT (${key}) DO UPDATE SET json = EXCLUDED.json`,
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

export function processLevelMap(table: string): PgMigrationDefinition {
  return {
    id: `durable-map/${table}/0030-process-level`,
    statements: [
      `DO $process_level$
       BEGIN
         IF EXISTS (SELECT 1 FROM pg_attribute
                     WHERE attrelid = '${table}'::regclass AND attname = 'tenant_id' AND NOT attisdropped) THEN
           DELETE FROM ${table} a USING ${table} b WHERE a.id = b.id AND a.ctid < b.ctid;
           DROP POLICY IF EXISTS tenant_isolation ON ${table};
           ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;
           ALTER TABLE ${table} DROP CONSTRAINT ${table}_pkey;
           ALTER TABLE ${table} DROP COLUMN tenant_id;
           ALTER TABLE ${table} ADD CONSTRAINT ${table}_pkey PRIMARY KEY (id);
         END IF;
       END $process_level$`,
      `DROP FUNCTION IF EXISTS claim_${table}()`,
      `DELETE FROM ${VERSIONS_TABLE} WHERE tbl = '${table}'`,
    ],
  };
}

export interface PostgresArtifactMaps {
  map<T>(
    table: string,
    indexedFields?: readonly Extract<keyof T, string>[],
    tenancy?: readonly PgMigrationDefinition[],
  ): DurableMap<T>;
  pool: PgPool;
}

export function createPostgresMapFactory(connectionString: string): PostgresArtifactMaps {
  const pg = createPgPool(connectionString);
  return {
    map: <T>(
      table: string,
      indexedFields?: readonly Extract<keyof T, string>[],
      tenancy?: readonly PgMigrationDefinition[],
    ): DurableMap<T> => createPostgresMap<T>(pg, table, indexedFields, tenancy),
    pool: pg,
  };
}
