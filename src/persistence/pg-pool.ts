import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { errMessage, swallowAs } from "../util/errors.ts";

export type { Pool, PoolClient };

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

const sharedPools = new Map<string, { pool: Pool; users: number }>();

async function retainPool(connectionString: string, kind: "query" | "session" | "migration"): Promise<Pool> {
  const pg = (await import("pg")).default;
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
  let url = connectionString;
  let ssl = pgCaOptions();
  if (kind === "query" && connectionString === poolingConfig.poolUrl && poolingConfig.caCert) {
    const parsed = new URL(connectionString);
    for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) parsed.searchParams.delete(key);
    url = parsed.toString();
    ssl = { ssl: { ca: poolingConfig.caCert } };
  }
  const pool = new pg.Pool({ connectionString: url, ...ssl, max, connectionTimeoutMillis: 10_000 });
  pool.on("error", (error) => console.error("[pg] idle client error:", errMessage(error)));
  sharedPools.set(key, { pool, users: 1 });
  return pool;
}

async function releasePool(
  connectionString: string,
  pool: Pool,
  kind: "query" | "session" | "migration",
): Promise<void> {
  const key = `${kind}:${connectionString}`;
  const entry = sharedPools.get(key);
  if (!entry || entry.pool !== pool) return;
  if (--entry.users === 0) {
    sharedPools.delete(key);
    await pool.end();
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

export interface PgMaintenanceDefinition extends PgMigrationDefinition {
  beforeMigrations?: boolean;
}

export interface PgQueryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PgPool {
  pool(): Promise<Pool>;
  sessionPool(): Promise<Pool>;
  q(text: string, params?: unknown[], options?: PgQueryOptions): Promise<Rows>;
  query(text: string, params?: unknown[], options?: PgQueryOptions): Promise<{ rows: Rows; rowCount: number }>;
  registerMigration(migration: PgMigrationDefinition): void;
  migrate(migration: PgMigrationDefinition): Promise<void>;
  close(): Promise<void>;
}

async function withStatementTimeout<T>(
  client: PoolClient,
  timeoutMs: number | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (timeoutMs === undefined) return run();
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("Query timeout must be a positive finite number");
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL statement_timeout = ${Math.round(timeoutMs)}`);
    const result = await run();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(swallowAs("pg-pool: rollback query timeout", undefined));
    throw error;
  }
}

export async function withPgTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
  return /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_$]*)\b/i.exec(stmt)?.[1];
}

export function pgMigrationChecksum(statements: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(statements.map((statement) => statement.trim())))
    .digest("hex");
}

export function definePgMigration(
  id: string,
  statements: readonly string[],
  expectedChecksum?: string,
  legacyId?: string,
): PgMigration {
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
  return { id, statements: normalized, checksum, ...(legacyId ? { legacyId } : {}) };
}

export async function applyPgMigrations(pool: Pool, migrations: readonly PgMigration[]): Promise<void> {
  if (!migrations.length) return;
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('qm:schema-migrations'))");
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
        await client.query("ROLLBACK").catch(swallowAs(`pg-pool: rollback migration ${migration.id}`, undefined));
        throw error;
      }
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext('qm:schema-migrations'))")
      .catch(swallowAs("pg-pool: schema-migrations unlock", undefined));
    client.release();
  }
}

/**
 * Extra root-CA trust for the Postgres connection, with full verification
 * semantics kept. Managed providers (Supabase's pooler, RDS, …) often pin a
 * private root the container's trust store doesn't carry; without a supported
 * way to add it, operators were left choosing between sslmode=no-verify and
 * forking the image. DATABASE_CA_CERT carries PEM content (a secret-store
 * value); DATABASE_CA_CERT_FILE points at a mounted file. Parsed once at the
 * process boundary (config.ts / a script's own env read), installed here, and
 * applied to every pg pool and client this process opens — database CA trust
 * is inherently process-global, like NODE_EXTRA_CA_CERTS.
 */
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

export function pgCaOptions(): { ssl?: { ca: string } } {
  return installedCaTrust;
}

const registeredMigrations = new Map<string, Map<string, PgMigration>>();
const registeredPreMigrationMaintenance = new Map<string, Map<string, PgMigration>>();

function registerPgMigration(connectionString: string, migration: PgMigration, registry = registeredMigrations): void {
  let database = registry.get(connectionString);
  if (!database) {
    database = new Map();
    registry.set(connectionString, database);
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

async function applyPgMaintenance(pool: Pool, maintenance: readonly PgMigration[]): Promise<void> {
  if (!maintenance.length) return;
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('qm:schema-maintenance'))");
    for (const operation of maintenance) {
      await client.query("BEGIN");
      try {
        for (const statement of operation.statements) await client.query(statement);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(swallowAs(`pg-pool: rollback maintenance ${operation.id}`, undefined));
        throw error;
      }
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext('qm:schema-maintenance'))")
      .catch(swallowAs("pg-pool: schema-maintenance unlock", undefined));
    client.release();
  }
}

export async function migrateRegisteredPgSchemas(connectionString?: string): Promise<void> {
  const databases = connectionString
    ? [[connectionString, registeredMigrations.get(connectionString)] as const]
    : [...registeredMigrations.entries()];
  for (const [databaseUrl, registered] of databases) {
    if (!registered?.size) continue;
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: databaseUrl, ...pgCaOptions() });
    pool.on("error", (error) => console.error("[pg] migration pool error:", errMessage(error)));
    try {
      await applyPgMaintenance(pool, [...(registeredPreMigrationMaintenance.get(databaseUrl)?.values() ?? [])]);
      await applyPgMigrations(
        pool,
        [...registered.values()].sort((a, b) => a.id.localeCompare(b.id)),
      );
    } finally {
      await pool.end();
    }
  }
}

export function createPgPool(connectionString: string): PgPool;
export function createPgPool(
  connectionString: string,
  migrationId: string,
  statements: readonly string[],
  maintenance?: readonly PgMaintenanceDefinition[],
): PgPool;
export function createPgPool(
  connectionString: string,
  definitions: readonly PgMigrationDefinition[],
  maintenance?: readonly PgMaintenanceDefinition[],
): PgPool;
export function createPgPool(
  connectionString: string,
  idOrDefinitions: string | readonly PgMigrationDefinition[] = [],
  statementsOrMaintenance: readonly string[] | readonly PgMaintenanceDefinition[] = [],
  maintenanceDefinitions: readonly PgMaintenanceDefinition[] = [],
): PgPool {
  const definitions =
    typeof idOrDefinitions === "string"
      ? [{ id: idOrDefinitions, statements: statementsOrMaintenance as readonly string[] }]
      : idOrDefinitions;
  const migrations = definitions.map((definition) =>
    definePgMigration(definition.id, definition.statements, definition.expectedChecksum, definition.legacyId),
  );
  for (const migration of migrations) registerPgMigration(connectionString, migration);
  const maintenanceSource =
    typeof idOrDefinitions === "string"
      ? maintenanceDefinitions
      : (statementsOrMaintenance as readonly PgMaintenanceDefinition[]);
  const preMigrationMaintenance = maintenanceSource
    .filter((definition) => definition.beforeMigrations)
    .map((definition) => definePgMigration(definition.id, definition.statements));
  for (const maintenance of preMigrationMaintenance) {
    registerPgMigration(connectionString, maintenance, registeredPreMigrationMaintenance);
  }
  const postMigrationMaintenance = maintenanceSource
    .filter((definition) => !definition.beforeMigrations)
    .map((definition) => definePgMigration(definition.id, definition.statements));
  let readyP: Promise<void> | null = null;
  let sessionPoolP: Promise<Pool> | null = null;
  let queryPoolP: Promise<Pool> | null = null;
  let closed = false;
  const queryUrl = pooledDatabaseUrl(connectionString);
  async function withMigrationPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
    const instance = await retainPool(connectionString, "migration");
    try {
      return await fn(instance);
    } finally {
      await releasePool(connectionString, instance, "migration");
    }
  }
  async function ready(): Promise<void> {
    if (closed) throw new Error("Postgres store is closed");
    await (readyP ??= withMigrationPool(async (instance) => {
      await applyPgMaintenance(instance, preMigrationMaintenance);
      await applyPgMigrations(instance, migrations);
      await applyPgMaintenance(instance, postMigrationMaintenance);
    }).catch((error) => {
      readyP = null;
      throw error;
    }));
    if (closed) throw new Error("Postgres store is closed");
  }
  async function pool(): Promise<Pool> {
    await ready();
    if (closed) throw new Error("Postgres store is closed");
    return (queryPoolP ??= retainPool(queryUrl, "query"));
  }
  async function sessionPool(): Promise<Pool> {
    await ready();
    if (closed) throw new Error("Postgres store is closed");
    return (sessionPoolP ??= retainPool(connectionString, "session"));
  }
  async function query(
    text: string,
    params: unknown[] = [],
    options: PgQueryOptions = {},
  ): Promise<{ rows: Rows; rowCount: number }> {
    const p = await pool();
    if (!options.signal && options.timeoutMs === undefined) {
      const res = await p.query(text, params);
      return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 };
    }
    if (!options.signal) {
      const client = await p.connect();
      let queryError: Error | undefined;
      try {
        return await withStatementTimeout(client, options.timeoutMs, async () => {
          const res = await client.query({ text, values: params });
          return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 };
        });
      } catch (error) {
        queryError = error instanceof Error ? error : new Error(String(error));
        throw error;
      } finally {
        client.release(queryError);
      }
    }
    if (options.signal.aborted) throw new DOMException("Postgres query cancelled", "AbortError");
    const connectPromise = p.connect();
    let connectAbort: (() => void) | undefined;
    const connectAbortPromise = new Promise<never>((_, reject) => {
      connectAbort = () => reject(new DOMException("Postgres query cancelled", "AbortError"));
      options.signal!.addEventListener("abort", connectAbort, { once: true });
    });
    let client: PoolClient;
    try {
      client = await Promise.race([connectPromise, connectAbortPromise]);
    } catch (error) {
      void connectPromise
        .then(
          (lateClient) => lateClient.release(error instanceof Error ? error : new Error(String(error))),
          () => undefined,
        )
        .catch(() => undefined);
      throw error;
    } finally {
      if (connectAbort) options.signal.removeEventListener("abort", connectAbort);
    }
    let queryError: Error | undefined;
    let released = false;
    const cancel = () => {
      if (released) return;
      released = true;
      client.release(new Error("Postgres query cancelled"));
    };
    options.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (released) throw new Error("Postgres query cancelled");
      return await withStatementTimeout(client, options.timeoutMs, async () => {
        const res = await client.query({ text, values: params });
        return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 };
      });
    } catch (error) {
      queryError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      if (!released) client.release(queryError);
    }
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
    const migration = definePgMigration(
      definition.id,
      definition.statements,
      definition.expectedChecksum,
      definition.legacyId,
    );
    registerPgMigration(connectionString, migration);
    if (closed) throw new Error("Postgres store is closed");
    await ready();
    await withMigrationPool((instance) => applyPgMigrations(instance, [migration]));
  }
  function registerMigration(definition: PgMigrationDefinition): void {
    registerPgMigration(
      connectionString,
      definePgMigration(definition.id, definition.statements, definition.expectedChecksum, definition.legacyId),
    );
  }
  return { pool, sessionPool, q, query, registerMigration, migrate, close };
}
