import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TransactionSql } from "postgres";
import {
  openPgSql,
  pgClient,
  pgConnectionOptions as driverConnectionOptions,
  pgUnsafe,
  reservePg,
  usePg,
  type PgClient,
  type PgConnection,
  type Sql,
} from "./pg-driver.ts";
import { createKeyedQueue, sleep, withAbort } from "../util/async.ts";
import { errMessage, swallowAs } from "../util/errors.ts";

export { reservePg };
export type { PgClient, Sql };

export type Rows = Record<string, unknown>[];

interface PgPoolingConfig {
  databaseUrl?: string;
  poolUrl?: string;
  caCert?: string;
  queryMax?: number;
  sessionMax?: number;
}

let poolingConfig: PgPoolingConfig = {};

export function configurePgPooling(config: PgPoolingConfig): void {
  if (config.poolUrl && !config.databaseUrl) throw new Error("DATABASE_POOL_URL requires DATABASE_URL");
  for (const [name, value] of [
    ["DATABASE_POOL_MAX", config.queryMax],
    ["DATABASE_DIRECT_POOL_MAX", config.sessionMax],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 100)) {
      throw new Error(`${name} must be an integer between 1 and 100`);
    }
  }
  poolingConfig = { ...config };
}

const migrationQueue = createKeyedQueue();

const sharedPools = new Map<string, { pool: Sql; users: number }>();

async function retainPool(connectionString: string, kind: "query" | "session" | "migration"): Promise<Sql> {
  const key = `${kind}:${connectionString}`;
  const existing = sharedPools.get(key);
  if (existing) {
    existing.users++;
    return existing.pool;
  }
  const setting = kind === "query" ? "DATABASE_POOL_MAX" : "DATABASE_DIRECT_POOL_MAX";
  const max = { query: poolingConfig.queryMax ?? 10, session: poolingConfig.sessionMax ?? 32, migration: 1 }[kind];
  if (!Number.isInteger(max) || max < 1 || max > 100)
    throw new Error(`${setting} must be an integer between 1 and 100`);
  const pooled = kind === "query" && connectionString === poolingConfig.poolUrl;
  const pool = openPgSql(connectionString, {
    max,
    ca: (pooled ? poolingConfig.caCert : undefined) ?? installedCaTrust.ssl?.ca,
    prepare: !pooled,
  });
  sharedPools.set(key, { pool, users: 1 });
  return pool;
}

async function releasePool(
  connectionString: string,
  pool: Sql,
  kind: "query" | "session" | "migration",
): Promise<void> {
  const key = `${kind}:${connectionString}`;
  const entry = sharedPools.get(key);
  if (!entry || entry.pool !== pool) return;
  if (--entry.users === 0) {
    sharedPools.delete(key);
    await usePg(pool, () => pool.end({ timeout: 5 }));
  }
}

function pooledDatabaseUrl(connectionString: string): string {
  const pooled = poolingConfig.poolUrl;
  if (!pooled || connectionString !== poolingConfig.databaseUrl) return connectionString;
  const directUrl = new URL(connectionString);
  const pooledUrl = new URL(pooled);
  if (
    directUrl.username !== pooledUrl.username ||
    directUrl.password !== pooledUrl.password ||
    directUrl.pathname !== pooledUrl.pathname
  ) {
    throw new Error("DATABASE_POOL_URL must preserve the DATABASE_URL database and credentials");
  }
  return pooled;
}

export const PG_MIGRATIONS_TABLE = "qm_schema_migrations";

export interface PgMigrationDefinition {
  id: string;
  statements: readonly string[];
  expectedChecksum?: string;
  legacyId?: string;
}

export interface PgMigration extends PgMigrationDefinition {
  checksum: string;
}

export interface PgQueryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PgPool {
  pool(): Promise<Sql>;
  sessionPool(): Promise<Sql>;
  dedicated(options?: { pinned?: boolean; onclose?: () => void }): Promise<Sql>;
  q(text: string, params?: unknown[], options?: PgQueryOptions): Promise<Rows>;
  query(text: string, params?: unknown[], options?: PgQueryOptions): Promise<{ rows: Rows; rowCount: number }>;
  registerMigration(migration: PgMigrationDefinition): void;
  migrate(migration: PgMigrationDefinition): Promise<void>;
  close(): Promise<void>;
}

function queryTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("Query timeout must be a positive finite number");
  return Math.round(timeoutMs);
}

async function runQuery(
  sql: Sql,
  text: string,
  params: unknown[],
  { signal, timeoutMs }: PgQueryOptions,
): Promise<{ rows: Rows; rowCount: number }> {
  const timeout = queryTimeout(timeoutMs);
  signal?.throwIfAborted();
  let pending: ReturnType<typeof pgUnsafe> | undefined;
  const start = (tx: Sql | TransactionSql) => (pending = pgUnsafe(tx, text, params));
  const result =
    timeout === undefined
      ? start(sql)
      : sql
          .begin((tx) => {
            signal?.throwIfAborted();
            return [tx.unsafe(`SET LOCAL statement_timeout = ${timeout}`), start(tx)];
          })
          .then((results) => results[1]!);
  const cancel = () => void pending?.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const rows = await withAbort(() => result, signal);
    return { rows: [...rows] as Rows, rowCount: rows.count ?? 0 };
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export function withPgTransaction<T>(sql: Sql, fn: (client: PgClient) => Promise<T>): Promise<T> {
  return usePg(sql, () => sql.begin((tx) => fn(pgClient(tx))) as Promise<T>);
}

export function assertOneStatement(stmt: string): void {
  const bare = stmt
    .replace(/--[^\n]*/g, "")
    .replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, "")
    .replace(/'(?:[^']|'')*'/g, "")
    .replace(/;\s*$/, "");
  if (bare.includes(";")) {
    throw new Error(`pg-pool: each schema element must be a single statement (found ';' in: ${stmt.slice(0, 80)}…)`);
  }
}

export function concurrentIndexName(stmt: string): string | undefined {
  return /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_$]*)\s+ON\s/i.exec(
    stmt,
  )?.[1];
}

export function pgMigrationChecksum(statements: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(statements.map((statement) => statement.trim())))
    .digest("hex");
}

export function definePgMigration({ id, statements, expectedChecksum, legacyId }: PgMigrationDefinition): PgMigration {
  if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(id) || id.includes("..")) {
    throw new Error(`pg-pool: invalid migration id ${JSON.stringify(id)}`);
  }
  const normalized = statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
  for (const statement of normalized) assertOneStatement(statement);
  const checksum = pgMigrationChecksum(normalized);
  if (expectedChecksum !== undefined && checksum !== expectedChecksum) {
    throw new Error(
      `pg-pool: migration ${id} source checksum mismatch (expected=${expectedChecksum}, actual=${checksum})`,
    );
  }
  return {
    id,
    statements: normalized,
    checksum,
    ...(legacyId ? { legacyId } : {}),
  };
}

const SCHEMA_LOCK_POLL_MS = 50;

async function lockSchema(client: PgClient, name: string): Promise<void> {
  for (;;) {
    const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [
      name,
    ]);
    if (result.rows[0]?.locked) return;
    await sleep(SCHEMA_LOCK_POLL_MS);
  }
}

export async function applyPgMigrations(pool: Sql, migrations: readonly PgMigration[]): Promise<void> {
  if (!migrations.length) return;
  await withPgConnection(pool, (client) => applyLockedPgMigrations(client, migrations));
}

async function withPgConnection<T>(pool: Sql, fn: (client: PgClient) => Promise<T>): Promise<T> {
  const client = await reservePg(pool);
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function rollback(client: PgClient, context: string): Promise<void> {
  await client.query("ROLLBACK").catch(swallowAs(context, undefined));
}

async function applyLockedPgMigrations(client: PgClient, migrations: readonly PgMigration[]): Promise<void> {
  try {
    await lockSchema(client, "qm:schema-migrations");
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${PG_MIGRATIONS_TABLE}(
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    );
    for (const migration of migrations) {
      const applied = await client.query<{ checksum: string }>(
        `SELECT checksum FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`,
        [migration.id],
      );
      if (applied.rows[0]) {
        if (applied.rows[0].checksum !== migration.checksum) {
          throw new Error(
            `pg-pool: migration ${migration.id} checksum mismatch (database=${applied.rows[0].checksum}, source=${migration.checksum})`,
          );
        }
        continue;
      }
      if (migration.statements.some((statement) => concurrentIndexName(statement))) {
        if (migration.legacyId || !migration.statements.every((statement) => concurrentIndexName(statement))) {
          throw new Error(`pg-pool: concurrent index migration ${migration.id} must contain only concurrent indexes`);
        }
        for (const statement of migration.statements) {
          const name = concurrentIndexName(statement)!;
          const table =
            /\sON\s+(?:ONLY\s+)?([a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?)\s*(?:USING\s+[a-z_]+\s*)?\(/i.exec(
              statement,
            )?.[1];
          if (!table) throw new Error(`pg-pool: unsupported concurrent index target in ${migration.id}`);
          const inspect = () =>
            client.query<{ indisvalid: boolean; indisready: boolean; same_table: boolean; qualified_name: string }>(
              `SELECT i.indisvalid, i.indisready, i.indrelid = t.oid AS same_table,
                    quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS qualified_name
             FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
             JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = $2
             JOIN pg_index i ON i.indexrelid = c.oid WHERE t.oid = to_regclass($1)`,
              [table.toLowerCase(), name.toLowerCase()],
            );
          const existing = (await inspect()).rows[0];
          if (existing && !existing.same_table)
            throw new Error(`pg-pool: concurrent index ${name} belongs to a different table`);
          if (existing?.indisvalid === false) await client.query(`DROP INDEX CONCURRENTLY ${existing.qualified_name}`);
          await client.query(statement);
          const built = (await inspect()).rows[0];
          if (!built?.indisvalid || !built.indisready || !built.same_table) {
            throw new Error(`pg-pool: concurrent index ${name} is not ready and valid`);
          }
        }
        await client.query(`INSERT INTO ${PG_MIGRATIONS_TABLE}(id, checksum) VALUES ($1, $2)`, [
          migration.id,
          migration.checksum,
        ]);
        continue;
      }
      await client.query("BEGIN");
      try {
        let adopted = false;
        if (migration.legacyId) {
          const legacyTable = await client.query<{ present: boolean }>(
            "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
          );
          if (legacyTable.rows[0]?.present) {
            const legacy = await client.query("SELECT id FROM schema_migrations WHERE id = $1", [migration.legacyId]);
            adopted = legacy.rows.length > 0;
          }
        }
        if (!adopted) for (const statement of migration.statements) await client.query(statement);
        await client.query(`INSERT INTO ${PG_MIGRATIONS_TABLE}(id, checksum) VALUES ($1, $2)`, [
          migration.id,
          migration.checksum,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await rollback(client, `pg-pool: rollback migration ${migration.id}`);
        throw error;
      }
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext('qm:schema-migrations'))")
      .catch(swallowAs("pg-pool: schema-migrations unlock", undefined));
  }
}

export function resolvePgCaTrust(opts: { cert?: string; certFile?: string }): { ssl?: { ca: string } } {
  if (opts.cert?.trim()) return { ssl: { ca: opts.cert } };
  if (opts.certFile?.trim()) {
    try {
      return { ssl: { ca: readFileSync(opts.certFile, "utf8") } };
    } catch (e) {
      throw new Error(`DATABASE_CA_CERT_FILE is set but unreadable (${opts.certFile}): ${errMessage(e)}`, {
        cause: e,
      });
    }
  }
  return {};
}

let installedCaTrust: { ssl?: { ca: string } } = {};

export function configurePgCaTrust(opts: { cert?: string; certFile?: string }): void {
  installedCaTrust = resolvePgCaTrust(opts);
}

export function pgConnectionOptions(connectionString: string, ca = installedCaTrust.ssl?.ca): PgConnection {
  return driverConnectionOptions(connectionString, ca);
}

const registeredMigrations = new Map<string, Map<string, PgMigration>>();

function registerPgMigration(connectionString: string, migration: PgMigration): void {
  let database = registeredMigrations.get(connectionString);
  if (!database) {
    database = new Map();
    registeredMigrations.set(connectionString, database);
  }
  const existing = database.get(migration.id);
  if (existing && existing.checksum !== migration.checksum) {
    throw new Error(`pg-pool: migration ${migration.id} was registered twice with different checksums`);
  }
  database.set(migration.id, migration);
}

export function registeredPgMigrations(connectionString: string): readonly PgMigration[] {
  return [...(registeredMigrations.get(connectionString)?.values() ?? [])].sort((a, b) => a.id.localeCompare(b.id));
}

async function applyPgMaintenance(pool: Sql, maintenance: readonly PgMigration[]): Promise<void> {
  if (!maintenance.length) return;
  await withPgConnection(pool, async (client) => {
    try {
      await lockSchema(client, "qm:schema-maintenance");
      for (const operation of maintenance) {
        await client.query("BEGIN");
        try {
          for (const statement of operation.statements) await client.query(statement);
          await client.query("COMMIT");
        } catch (error) {
          await rollback(client, `pg-pool: rollback maintenance ${operation.id}`);
          throw error;
        }
      }
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtext('qm:schema-maintenance'))")
        .catch(swallowAs("pg-pool: schema-maintenance unlock", undefined));
    }
  });
}

export async function migrateRegisteredPgSchemas(connectionString?: string): Promise<void> {
  const databases = connectionString
    ? [[connectionString, registeredMigrations.get(connectionString)] as const]
    : [...registeredMigrations.entries()];
  for (const [databaseUrl, registered] of databases) {
    if (!registered?.size) continue;
    await migrationQueue(databaseUrl, async () => {
      const pool = openPgSql(databaseUrl, { max: 1, ca: installedCaTrust.ssl?.ca });
      try {
        await applyPgMigrations(
          pool,
          [...registered.values()].sort((a, b) => a.id.localeCompare(b.id)),
        );
      } finally {
        await usePg(pool, () => pool.end({ timeout: 5 }));
      }
    });
  }
}

export function createPgPool(
  connectionString: string,
  definitions: readonly PgMigrationDefinition[] = [],
  maintenanceDefinitions: readonly PgMigrationDefinition[] = [],
): PgPool {
  const migrations = definitions.map(definePgMigration);
  for (const migration of migrations) registerPgMigration(connectionString, migration);
  const maintenance = maintenanceDefinitions.map(definePgMigration);
  let readyP: Promise<void> | null = null;
  let sessionPoolP: Promise<Sql> | null = null;
  let queryPoolP: Promise<Sql> | null = null;
  let closed = false;
  const queryUrl = pooledDatabaseUrl(connectionString);
  async function withMigrationPool<T>(fn: (pool: Sql) => Promise<T>): Promise<T> {
    return migrationQueue(connectionString, async () => {
      const instance = await retainPool(connectionString, "migration");
      try {
        return await fn(instance);
      } finally {
        await releasePool(connectionString, instance, "migration");
      }
    });
  }
  async function ready(): Promise<void> {
    if (closed) throw new Error("Postgres store is closed");
    await (readyP ??= withMigrationPool(async (instance) => {
      await applyPgMigrations(instance, migrations);
      await applyPgMaintenance(instance, maintenance);
    }).catch((error) => {
      readyP = null;
      throw error;
    }));
    if (closed) throw new Error("Postgres store is closed");
  }
  async function pool(): Promise<Sql> {
    await ready();
    if (closed) throw new Error("Postgres store is closed");
    return (queryPoolP ??= retainPool(queryUrl, "query"));
  }
  async function sessionPool(): Promise<Sql> {
    await ready();
    if (closed) throw new Error("Postgres store is closed");
    return (sessionPoolP ??= retainPool(connectionString, "session"));
  }
  async function dedicated(options: { pinned?: boolean; onclose?: () => void } = {}): Promise<Sql> {
    await ready();
    if (closed) throw new Error("Postgres store is closed");
    return openPgSql(connectionString, { max: 1, ca: installedCaTrust.ssl?.ca, ...options });
  }
  async function query(
    text: string,
    params: unknown[] = [],
    options: PgQueryOptions = {},
  ): Promise<{ rows: Rows; rowCount: number }> {
    const p = await pool();
    return usePg(p, () => runQuery(p, text, params, options));
  }
  async function q(text: string, params: unknown[] = [], options?: PgQueryOptions): Promise<Rows> {
    return (await query(text, params, options)).rows;
  }
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await readyP?.catch(() => {});
    await Promise.all([
      queryPoolP?.then((instance) => releasePool(queryUrl, instance, "query")),
      sessionPoolP?.then((instance) => releasePool(connectionString, instance, "session")),
    ]);
  }
  async function migrate(definition: PgMigrationDefinition): Promise<void> {
    const migration = definePgMigration(definition);
    registerPgMigration(connectionString, migration);
    if (closed) throw new Error("Postgres store is closed");
    await ready();
    await withMigrationPool((instance) => applyPgMigrations(instance, [migration]));
  }
  function registerMigration(definition: PgMigrationDefinition): void {
    registerPgMigration(connectionString, definePgMigration(definition));
  }
  return { pool, sessionPool, dedicated, q, query, registerMigration, migrate, close };
}
