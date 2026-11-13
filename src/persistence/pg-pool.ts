import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import type { ClientConfig, Pool, PoolClient, QueryResult } from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import { boundTenant, explicitTenantId, pinTenant, type Tenant } from "../tenants/context.ts";
import { createKeyedQueue, sleep, withAbort } from "../util/async.ts";
import { errMessage, swallow, swallowAs } from "../util/errors.ts";
import { untraced } from "../../plugins/chassis/src/error-reporting.ts";

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
  poolingConfig = { ...config };
}

const migrationQueue = createKeyedQueue();
const connectionTimeoutMs = 10_000;

const sharedPools = new Map<string, { pool: Pool; users: number }>();

async function retainPool(connectionString: string, kind: "query" | "session" | "migration"): Promise<Pool> {
  const pg = (await import("pg")).default;
  const key = `${kind}:${connectionString}`;
  const existing = sharedPools.get(key);
  if (existing) {
    existing.users++;
    return existing.pool;
  }
  const max = { query: poolingConfig.queryMax ?? 20, session: poolingConfig.sessionMax ?? 64, migration: 1 }[kind];
  const connection = pgConnectionOptions(
    connectionString,
    kind === "query" && connectionString === poolingConfig.poolUrl ? poolingConfig.caCert : undefined,
  );
  const pool = guardedPool(
    new pg.Pool({
      ...connection,
      max,
      connectionTimeoutMillis: connectionTimeoutMs,
      allowExitOnIdle: true,
      pipeline: true,
    }),
  );
  sharedPools.set(key, { pool, users: 1 });
  return pool;
}

function guardedPool(pool: Pool): Pool {
  pool.on("error", () => {});
  pool.on("connect", (client) => client.on("error", (error) => console.error("[pg] client error:", errMessage(error))));
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
  autocommit?: true;
  prepare?: readonly string[];
  upgradeFrom?: string;
}

export interface PgMigration extends PgMigrationDefinition {
  checksum: string;
}

export interface PgQueryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TenantDb {
  q(text: string, params?: unknown[], options?: PgQueryOptions): Promise<Rows>;
  query(text: string, params?: unknown[], options?: PgQueryOptions): Promise<{ rows: Rows; rowCount: number }>;
  transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
}

export interface PgPool {
  pool(): Promise<Pool>;
  sessionPool(): Promise<Pool>;
  q(text: string, params?: unknown[], options?: PgQueryOptions): Promise<Rows>;
  query(text: string, params?: unknown[], options?: PgQueryOptions): Promise<{ rows: Rows; rowCount: number }>;
  forTenant(tenant: Tenant): TenantDb;
  registerMigration(migration: PgMigrationDefinition): void;
  migrate(migration: PgMigrationDefinition | readonly PgMigrationDefinition[]): Promise<void>;
  close(): Promise<void>;
}

type PgSetting = readonly [name: string, value: string];

function tenantSettings(tenant: string | undefined): PgSetting[] {
  return tenant === undefined ? [] : [["qm.tenant_id", tenant]];
}

function querySettings(tenant: string | undefined, timeoutMs: number | undefined): PgSetting[] {
  if (timeoutMs === undefined) return tenantSettings(tenant);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("Query timeout must be a positive finite number");
  return [...tenantSettings(tenant), ["statement_timeout", String(Math.round(timeoutMs))]];
}

function settingsQuery(settings: readonly PgSetting[]): { text: string; values: string[] } {
  const assignments = settings.map((_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, true)`);
  return { text: `SELECT ${assignments.join(", ")}`, values: settings.flat() };
}

async function pipelinedTransaction(
  client: PoolClient,
  settings: readonly PgSetting[],
  text: string,
  values: unknown[],
  signal: AbortSignal | undefined,
): Promise<QueryResult> {
  const settled = await withAbort(() => {
    const statements = [
      untraced(() => client.query("BEGIN")),
      ...(settings.length ? [untraced(() => client.query(settingsQuery(settings)))] : []),
      client.query({ text, values }),
    ];
    return Promise.allSettled(signal ? statements : [...statements, untraced(() => client.query("COMMIT"))]);
  }, signal);
  if (signal) {
    signal.throwIfAborted();
    settled.push(...(await Promise.allSettled([untraced(() => client.query("COMMIT"))])));
  }
  const failed = settled.find((outcome) => outcome.status === "rejected");
  if (failed) throw failed.reason;
  const status = client.getTransactionStatus();
  if (status !== "I") throw new Error(`pg-pool: pipelined query left its connection in transaction status ${status}`);
  return (settled[settings.length ? 2 : 1] as PromiseFulfilledResult<QueryResult>).value;
}

type CancelConnection = EventEmitter & {
  stream: Socket;
  connect(...target: [string] | [number, string]): void;
  cancel(processID: number, secretKey: number): void;
};

function cancelThenClose(pg: typeof import("pg").default, client: PoolClient): void {
  const { processID, secretKey, connection } = client as PoolClient & { processID: number; secretKey: number };
  const stream = connection.stream as Socket;
  const cancel = new pg.Connection() as unknown as CancelConnection;
  cancel.on("connect", () => cancel.cancel(processID, secretKey));
  cancel.on("error", (error) => swallow("pg-pool: cancel request", error));
  cancel.once("end", () => stream.destroy());
  cancel.stream.setTimeout(connectionTimeoutMs, () =>
    cancel.stream.destroy(new Error(`cancel request got no reply within ${connectionTimeoutMs}ms`)),
  );
  if (client.host.startsWith("/")) cancel.connect(`${client.host}/.s.PGSQL.${client.port}`);
  else cancel.connect(client.port, stream.remoteAddress ?? client.host);
}

async function rollbackOrReport(client: PoolClient, context: string): Promise<Error | undefined> {
  try {
    await client.query("ROLLBACK");
    return undefined;
  } catch (error) {
    swallow(context, error);
    return error instanceof Error ? error : new Error(String(error));
  }
}

export function withPgTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const tenant = boundTenant();
  return pinTenant(tenant, () => runPgTransaction(pool, tenant, fn));
}

async function runPgTransaction<T>(
  pool: Pool,
  tenant: string | undefined,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let rollbackError: Error | undefined;
  try {
    const settings = tenantSettings(tenant);
    await untraced(() => client.query("BEGIN"));
    if (settings.length) await untraced(() => client.query(settingsQuery(settings)));
    const result = await fn(client);
    await untraced(() => client.query("COMMIT"));
    return result;
  } catch (error) {
    rollbackError = await rollbackOrReport(client, "pg-pool: rollback transaction");
    throw error;
  } finally {
    client.release(rollbackError);
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
  return /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_$]*)\s+ON\s/i.exec(
    stmt,
  )?.[1];
}

export function pgMigrationChecksum(statements: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(statements.map((statement) => statement.trim())))
    .digest("hex");
}

export function definePgMigration({
  id,
  statements,
  expectedChecksum,
  legacyId,
  autocommit,
  prepare = [],
  upgradeFrom,
}: PgMigrationDefinition): PgMigration {
  if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(id) || id.includes("..")) {
    throw new Error(`pg-pool: invalid migration id ${JSON.stringify(id)}`);
  }
  if (autocommit && legacyId) throw new Error(`pg-pool: autocommit migration ${id} cannot adopt a legacy id`);
  const normalized = statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
  for (const statement of normalized) assertOneStatement(statement);
  const checksum = pgMigrationChecksum(normalized);
  if (expectedChecksum !== undefined && checksum !== expectedChecksum) {
    throw new Error(
      `pg-pool: migration ${id} source checksum mismatch (expected=${expectedChecksum}, actual=${checksum})`,
    );
  }
  const preparation = prepare.map((statement) => statement.trim()).filter(Boolean);
  for (const statement of preparation) assertOneStatement(statement);
  return {
    id,
    ...(preparation.length ? { prepare: preparation } : {}),
    ...(upgradeFrom ? { upgradeFrom } : {}),
    statements: normalized,
    checksum,
    ...(legacyId ? { legacyId } : {}),
    ...(autocommit ? { autocommit } : {}),
  };
}

const SCHEMA_LOCK_POLL_MS = 50;

async function lockSchema(client: PoolClient, name: string): Promise<void> {
  for (;;) {
    const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [
      name,
    ]);
    if (result.rows[0]?.locked) return;
    await sleep(SCHEMA_LOCK_POLL_MS);
  }
}

function describePgError(error: unknown): string {
  const fields = error as { code?: unknown; detail?: unknown; hint?: unknown; routine?: unknown };
  return [
    errMessage(error),
    ...(["code", "detail", "hint", "routine"] as const)
      .filter((key) => typeof fields[key] === "string" && fields[key])
      .map((key) => `${key}: ${String(fields[key])}`),
  ].join("; ");
}

function unmigrated(migration: PgMigration): Error {
  const message = `misconfiguration: migration ${migration.id} has not been applied and this database login lacks migration authority; run migrations as the schema owner or the migration ledger owner with CREATE on the schema before starting`;
  console.error(`[pg-pool] ${message}`);
  return new Error(message);
}

export async function applyPgMigrations(pool: Pool, migrations: readonly PgMigration[]): Promise<void> {
  if (!migrations.length) return;
  const client = await pool.connect();
  let discard: Error | undefined;
  try {
    await lockSchema(client, "qm:schema-migrations");
    let owns: boolean | undefined;
    const mayMigrate = async (migration: PgMigration): Promise<void> => {
      owns ??=
        (
          await client.query<{ owns: boolean }>(
            `SELECT pg_has_role(current_user, n.nspowner, 'USAGE') OR (
               has_schema_privilege(current_user, n.oid, 'CREATE') AND (
                 ledger.oid IS NULL OR pg_has_role(current_user, ledger.relowner, 'USAGE')
               )
             ) AS owns
             FROM pg_namespace n
             LEFT JOIN pg_class ledger ON ledger.oid = to_regclass($1)
             WHERE n.nspname = current_schema()`,
            [PG_MIGRATIONS_TABLE],
          )
        ).rows[0]?.owns === true;
      if (!owns) throw unmigrated(migration);
    };
    const ledger = await client.query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [
      PG_MIGRATIONS_TABLE,
    ]);
    if (!ledger.rows[0]?.present) {
      await mayMigrate(migrations[0]!);
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${PG_MIGRATIONS_TABLE}(
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      );
    }
    const known = new Map(
      (
        await client.query<{ id: string; checksum: string }>(`SELECT id, checksum FROM ${PG_MIGRATIONS_TABLE}`)
      ).rows.map((row) => [row.id, row.checksum]),
    );
    const recorded = async (id: string): Promise<string | undefined> => {
      if (!known.has(id)) {
        const row = await client.query<{ checksum: string }>(
          `SELECT checksum FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`,
          [id],
        );
        if (row.rows[0]) known.set(id, row.rows[0].checksum);
      }
      return known.get(id);
    };
    for (const migration of migrations) {
      if (migration.upgradeFrom && (await recorded(migration.upgradeFrom)) === undefined) continue;
      const applied = await recorded(migration.id);
      if (applied !== undefined) {
        if (applied !== migration.checksum) {
          throw new Error(
            `pg-pool: migration ${migration.id} checksum mismatch (database=${applied}, source=${migration.checksum})`,
          );
        }
        continue;
      }
      await mayMigrate(migration);
      if (migration.prepare) {
        await client.query("SET statement_timeout = 0");
        try {
          for (const statement of migration.prepare) await client.query(statement);
        } catch (error) {
          await client
            .query("RESET statement_timeout")
            .catch(swallowAs(`pg-pool: reset statement timeout after preparing ${migration.id}`, undefined));
          throw error;
        }
        await client.query("RESET statement_timeout");
      }
      if (migration.autocommit) {
        for (const statement of migration.statements) await client.query(statement);
        await client.query(`INSERT INTO ${PG_MIGRATIONS_TABLE}(id, checksum) VALUES ($1, $2)`, [
          migration.id,
          migration.checksum,
        ]);
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
        console.error(`[pg-pool] migration ${migration.id} failed: ${describePgError(error)}`);
        discard = await rollbackOrReport(client, `pg-pool: rollback migration ${migration.id}`);
        throw error;
      }
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext('qm:schema-migrations'))")
      .catch(swallowAs("pg-pool: schema-migrations unlock", undefined));
    client.release(discard);
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

export function pgConnectionOptions(connectionString: string, ca = installedCaTrust.ssl?.ca): ClientConfig {
  if (!ca) return { connectionString };
  const url = new URL(connectionString);
  url.searchParams.delete("ssl");
  url.searchParams.delete("sslrootcert");
  url.searchParams.set("sslmode", "verify-full");
  const config = parseIntoClientConfig(url.toString());
  return { ...config, ssl: { ...(typeof config.ssl === "object" ? config.ssl : {}), ca } };
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

export async function migrateRegisteredPgSchemas(connectionString?: string): Promise<void> {
  const databases = connectionString
    ? [[connectionString, registeredMigrations.get(connectionString)] as const]
    : [...registeredMigrations.entries()];
  for (const [databaseUrl, registered] of databases) {
    if (!registered?.size) continue;
    await migrationQueue(databaseUrl, async () => {
      const pool = await retainPool(databaseUrl, "migration");
      try {
        await applyPgMigrations(
          pool,
          [...registered.values()].sort((a, b) => a.id.localeCompare(b.id)),
        );
      } finally {
        await releasePool(databaseUrl, pool, "migration");
      }
    });
  }
}

export function createPgPool(connectionString: string, definitions: readonly PgMigrationDefinition[] = []): PgPool {
  const migrations = definitions.map(definePgMigration);
  for (const migration of migrations) registerPgMigration(connectionString, migration);
  let readyP: Promise<void> | null = null;
  let sessionPoolP: Promise<Pool> | null = null;
  let queryPoolP: Promise<Pool> | null = null;
  let closed = false;
  const queryUrl = pooledDatabaseUrl(connectionString);
  async function withMigrationPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
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
  async function run(
    tenant: string | undefined,
    text: string,
    params: unknown[],
    { signal, timeoutMs }: PgQueryOptions,
  ): Promise<{ rows: Rows; rowCount: number }> {
    const settings = querySettings(tenant, timeoutMs);
    const p = await pool();
    if (!signal && !settings.length) {
      const res = await p.query(text, params);
      return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 };
    }
    signal?.throwIfAborted();
    const connecting = p.connect();
    let client: PoolClient;
    try {
      client = await withAbort(() => connecting, signal);
    } catch (error) {
      void connecting.then(
        (late) => late.release(true),
        () => undefined,
      );
      throw error;
    }
    let discard: Error | undefined;
    try {
      const res = await pipelinedTransaction(client, settings, text, params, signal);
      return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 };
    } catch (error) {
      const aborted = signal?.aborted === true && error === signal.reason;
      const pg = (await import("pg")).default;
      if (aborted) cancelThenClose(pg, client);
      if (aborted || !(error instanceof pg.DatabaseError) || error.code === "57014")
        discard = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      client.release(discard);
    }
  }
  function query(text: string, params: unknown[] = [], options: PgQueryOptions = {}) {
    return run(boundTenant(), text, params, options);
  }
  async function q(text: string, params: unknown[] = [], options?: PgQueryOptions): Promise<Rows> {
    return (await query(text, params, options)).rows;
  }
  function forTenant(tenant: Tenant): TenantDb {
    const scoped = async (text: string, params: unknown[] = [], options: PgQueryOptions = {}) =>
      run(explicitTenantId(tenant), text, params, options);
    return {
      query: scoped,
      q: async (text, params, options) => (await scoped(text, params, options)).rows,
      async transaction(fn) {
        const id = explicitTenantId(tenant);
        const p = await pool();
        return pinTenant(id, () => runPgTransaction(p, id, fn));
      },
    };
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
  async function migrate(definition: PgMigrationDefinition | readonly PgMigrationDefinition[]): Promise<void> {
    const batch = (Array.isArray(definition) ? definition : [definition]).map(definePgMigration);
    for (const migration of batch) registerPgMigration(connectionString, migration);
    if (closed) throw new Error("Postgres store is closed");
    await ready();
    await withMigrationPool((instance) => applyPgMigrations(instance, batch));
  }
  function registerMigration(definition: PgMigrationDefinition): void {
    registerPgMigration(connectionString, definePgMigration(definition));
  }
  return { pool, sessionPool, q, query, forTenant, registerMigration, migrate, close };
}
