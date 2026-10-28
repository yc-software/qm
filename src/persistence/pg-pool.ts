import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ClientConfig, Pool, PoolClient } from "pg";
import { parseIntoClientConfig } from "pg-connection-string";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { errMessage, swallow, swallowAs } from "../util/errors.ts";
import { SCHEMA_BASELINE, schemaBaselineChain, type ChainMigration } from "./schema-baseline.ts";
import { pgMigrationOrder, pgMigrationsFrom } from "./contract-migrations.ts";
import { applyTenancy, TENANT_BYPASS_OPTION } from "./tenancy.ts";
import { runPgQuery } from "./pg-query.ts";

export type { Pool, PoolClient };

export type Rows = Record<string, unknown>[];

interface PgPoolingConfig {
  databaseUrl?: string;
  poolUrl?: string;
  caCert?: string;
  queryMax?: number;
  sessionMax?: number;
  /** Row-level tenancy (QM_MULTITENANT): tenant_id-led keys, RLS, per-connection tenant setting. */
  tenancy?: boolean;
  tenantSecretsKey?: Buffer;
}

let poolingConfig: PgPoolingConfig = {};

// The tenant whose rows a checked-out connection may see. tenant.ts installs a reader for the
// AsyncLocalStorage tenant; undefined means the database's own singleton tenant (single-tenant mode).
let tenantSource: () => string | undefined = () => undefined;
let everyTenantSource: () => boolean = () => false;

export function configurePgTenantSource(source: () => string | undefined, everyTenant: () => boolean): void {
  tenantSource = source;
  everyTenantSource = everyTenant;
}

export function pgTenantId(): string | undefined {
  return tenantSource();
}

/** Advisory-lock keys are database-wide; prefix them so tenants sharing a database never contend. */
export function tenantLockKey(key: string): string {
  const id = tenancyEnabled ? tenantSource() : undefined;
  return id ? `tenant:${id}:${key}` : key;
}

const TENANT_GUC = Symbol("qm.tenant_id");

type TenantTracked = PoolClient & { [TENANT_GUC]?: string };

// Every checkout (including the implicit one inside Pool.query) sets qm.tenant_id on the session when it
// differs from what the connection last carried. Session-level, so it requires direct or session-pooled
// connections; multitenant deployments must not route through a transaction-mode pooler.
function tenantScopedPool(pool: Pool): Pool {
  const connect = pool.connect.bind(pool) as () => Promise<PoolClient>;
  const scoped = (
    callback?: (err: Error | undefined, client?: PoolClient, done?: (release?: unknown) => void) => void,
  ) => {
    const every = tenancyEnabled && everyTenantSource();
    const id = tenancyEnabled && !every ? (tenantSource() ?? "") : "";
    const want = every ? "*" : id;
    const ready = connect().then(async (raw) => {
      const client = raw as TenantTracked;
      if ((client[TENANT_GUC] ?? "") !== want) {
        try {
          await client.query(
            "SELECT set_config('qm.tenant_id', $1, false), set_config('qm.tenant_bypass', $2, false)",
            [id, every ? "on" : ""],
          );
        } catch (error) {
          client.release(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
        client[TENANT_GUC] = want;
      }
      return client as PoolClient;
    });
    if (!callback) return ready;
    ready.then(
      (client) => callback(undefined, client, (release?: unknown) => client.release(release as Error | undefined)),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    );
    return undefined;
  };
  (pool as unknown as { connect: typeof scoped }).connect = scoped;
  return pool;
}

export function configurePgPooling(config: PgPoolingConfig): void {
  if (config.poolUrl && !config.databaseUrl) throw new Error("DATABASE_POOL_URL requires DATABASE_URL");
  for (const [name, value] of [
    ["DATABASE_POOL_MAX", config.queryMax],
    ["DATABASE_DIRECT_POOL_MAX", config.sessionMax],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  poolingConfig = { ...config };
  if (config.tenancy !== undefined) configurePgTenancy(config.tenancy, config.tenantSecretsKey);
}

// Off by default: a single-tenant database keeps its original keys and needs no tenant setting.
let tenancyEnabled = false;
let tenantSecretsKey: Buffer | undefined;

export function pgTenancyEnabled(): boolean {
  return tenancyEnabled;
}

export function configurePgTenancy(enabled: boolean, secretsKey?: Buffer): void {
  tenancyEnabled = enabled;
  tenantSecretsKey = secretsKey;
}

/** Conflict-target / key column list, led by tenant_id when row-level tenancy is on. */
export function tenantCols(cols: string): string {
  return tenancyEnabled ? `tenant_id, ${cols}` : cols;
}

const migrationQueue = createKeyedQueue();

const sharedPools = new Map<string, { pool: Pool; users: number }>();

const tenantized = new Set<string>();

// Migration ids this process has seen applied, per database, so a store's first use skips the ledger when nothing new
// was registered since.
const settledMigrations = new Map<string, Set<string>>();

function markSettled(connectionString: string, migrations: readonly PgMigration[]): void {
  let settled = settledMigrations.get(connectionString);
  if (!settled) settledMigrations.set(connectionString, (settled = new Set()));
  for (const migration of migrations) settled.add(migration.id);
}

// qm_tenantize() is idempotent, so a store reruns it only when migrations changed the schema or this process has
// not run it on the database yet.
async function applyTenancyIfEnabled(pool: Pool, connectionString: string, changed: boolean): Promise<void> {
  if (!tenancyEnabled || (!changed && tenantized.has(connectionString))) return;
  await applyTenancy(pool, tenantSecretsKey);
  tenantized.add(connectionString);
}

const DEFAULT_QUERY_POOL_MAX = 10;
const DEFAULT_SESSION_POOL_MAX = 32;

export function pgPoolMax(kind: "query" | "session"): number {
  return kind === "query"
    ? (poolingConfig.queryMax ?? DEFAULT_QUERY_POOL_MAX)
    : (poolingConfig.sessionMax ?? DEFAULT_SESSION_POOL_MAX);
}

async function retainPool(connectionString: string, kind: "query" | "session" | "migration"): Promise<Pool> {
  const pg = (await import("pg")).default;
  const key = `${kind}:${connectionString}`;
  const existing = sharedPools.get(key);
  if (existing) {
    existing.users++;
    return existing.pool;
  }
  const setting = kind === "query" ? "DATABASE_POOL_MAX" : "DATABASE_DIRECT_POOL_MAX";
  const max = kind === "migration" ? 1 : pgPoolMax(kind);
  if (!Number.isInteger(max) || max < 1) throw new Error(`${setting} must be a positive integer`);
  const connection = pgConnectionOptions(
    connectionString,
    kind === "query" && connectionString === poolingConfig.poolUrl ? poolingConfig.caCert : undefined,
  );
  const poolOptions = { ...connection, max, connectionTimeoutMillis: 10_000, allowExitOnIdle: true };
  const pool =
    kind === "migration"
      ? guardedPool(new pg.Pool({ ...poolOptions, options: TENANT_BYPASS_OPTION }))
      : tenantScopedPool(guardedPool(new pg.Pool(poolOptions)));
  sharedPools.set(key, { pool, users: 1 });
  return pool;
}

function guardedPool(pool: Pool): Pool {
  pool.on("error", (error) => console.error("[pg] idle client error:", errMessage(error)));
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
  /**
   * Checksums of earlier released definitions of this id. A database that recorded one of them counts the migration as
   * applied; a follow-up migration brings it to this definition's end state.
   */
  acceptedChecksums?: readonly string[];
  script?: boolean;
  before?: readonly PgMigrationDefinition[];
  contract?: PgMigrationDefinition;
}

export interface PgMigration extends PgMigrationDefinition {
  checksum: string;
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

async function rollbackOrReport(client: PoolClient, context: string): Promise<Error | undefined> {
  try {
    await client.query("ROLLBACK");
    return undefined;
  } catch (error) {
    swallow(context, error);
    return error instanceof Error ? error : new Error(String(error));
  }
}

export async function withPgTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let rollbackError: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
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

export function definePgMigration(
  id: string,
  statements: readonly string[],
  expectedChecksum?: string,
  acceptedChecksums?: readonly string[],
  script?: boolean,
): PgMigration {
  if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(id) || id.includes("..")) {
    throw new Error(`pg-pool: invalid migration id ${JSON.stringify(id)}`);
  }
  const normalized = statements.map((statement) => statement.trim()).filter((statement) => statement.length > 0);
  if (!script) for (const statement of normalized) assertOneStatement(statement);
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
    ...(acceptedChecksums?.length ? { acceptedChecksums } : {}),
    ...(script ? { script } : {}),
  };
}

export function pgMigrationFrom(definition: PgMigrationDefinition): PgMigration {
  return definePgMigration(
    definition.id,
    definition.statements,
    definition.expectedChecksum,
    definition.acceptedChecksums,
    definition.script,
  );
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

type BaselinePlan = "recorded" | "apply" | "adopt" | "upgrade";

async function planSchemaBaseline(client: PoolClient, ledger: ReadonlyMap<string, string>): Promise<BaselinePlan> {
  const { id, checksum } = SCHEMA_BASELINE;
  const recorded = ledger.get(id);
  if (recorded !== undefined) {
    if (recorded !== checksum) {
      throw new Error(`pg-pool: schema baseline ${id} checksum mismatch (database=${recorded}, source=${checksum})`);
    }
    return "recorded";
  }
  if (ledger.size === 0) {
    const existing = await client.query<{ present: boolean }>(
      "SELECT COALESCE(to_regclass('sessions'), to_regclass('durable_map_versions'), to_regclass('schema_migrations')) IS NOT NULL AS present",
    );
    if (!existing.rows[0]?.present) return "apply";
  }
  return schemaBaselineChain().migrations.every((migration) => ledger.has(migration.id)) ? "adopt" : "upgrade";
}

async function applyInTransaction(
  client: PoolClient,
  label: string,
  statements: readonly string[],
  record: PgMigration | undefined,
  failure: { discard?: Error },
): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const statement of statements) await client.query(statement);
    if (record) {
      await client.query(`INSERT INTO ${PG_MIGRATIONS_TABLE}(id, checksum) VALUES ($1, $2)`, [
        record.id,
        record.checksum,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    failure.discard = await rollbackOrReport(client, `pg-pool: rollback ${label}`);
    throw error;
  }
}

async function appliedUnderPreLedgerId(client: PoolClient, preLedgerId: string): Promise<boolean> {
  const legacy = await client.query<{ present: boolean }>(
    "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
  );
  if (!legacy.rows[0]?.present) return false;
  return Boolean((await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [preLedgerId])).rowCount);
}

async function runUntimed(client: PoolClient, statements: readonly string[]): Promise<void> {
  await client.query("SET statement_timeout = 0");
  try {
    for (const statement of statements) await client.query(statement);
  } finally {
    await client.query("RESET statement_timeout").catch(swallowAs("pg-pool: reset statement timeout", undefined));
  }
}

async function upgradeToSchemaBaseline(
  client: PoolClient,
  pending: readonly ChainMigration[],
  failure: { discard?: Error },
): Promise<void> {
  const { before, after } = schemaBaselineChain();
  for (const step of before)
    await applyInTransaction(client, `maintenance ${step.id}`, step.statements, undefined, failure);
  for (const migration of pending) {
    if (migration.prepare) await runUntimed(client, migration.prepare);
    if (migration.statements.some((statement) => concurrentIndexName(statement))) {
      await createConcurrentIndexes(client, migration);
      await applyInTransaction(client, `migration ${migration.id}`, [], migration, failure);
      continue;
    }
    const adopted =
      migration.preLedgerId !== undefined && (await appliedUnderPreLedgerId(client, migration.preLedgerId));
    await applyInTransaction(
      client,
      `migration ${migration.id}`,
      adopted ? [] : migration.statements,
      migration,
      failure,
    );
  }
  for (const step of after)
    await applyInTransaction(client, `maintenance ${step.id}`, step.statements, undefined, failure);
}

async function createConcurrentIndexes(client: PoolClient, migration: PgMigration): Promise<void> {
  for (const statement of migration.statements) {
    const name = concurrentIndexName(statement)!;
    const table = /\sON\s+(?:ONLY\s+)?([a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?)\s*(?:USING\s+[a-z_]+\s*)?\(/i.exec(
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
}

async function applySchemaBaseline(client: PoolClient, plan: BaselinePlan): Promise<void> {
  const { id, checksum, sql } = SCHEMA_BASELINE;
  await client.query("BEGIN");
  try {
    if (plan === "apply") {
      await client.query("SET LOCAL check_function_bodies = false");
      await client.query(sql);
    }
    await client.query(`INSERT INTO ${PG_MIGRATIONS_TABLE}(id, checksum) VALUES ($1, $2)`, [id, checksum]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(swallowAs(`pg-pool: rollback schema baseline ${id}`, undefined));
    throw error;
  }
}

function preflightPgMigrations<M extends PgMigration>(
  ledger: ReadonlyMap<string, string>,
  migrations: readonly M[],
): { pending: M[]; acceptedPrior: string[] } {
  const seen = new Map<string, string>();
  const problems: string[] = [];
  const pending: M[] = [];
  const acceptedPrior: string[] = [];
  for (const migration of migrations) {
    const twin = seen.get(migration.id);
    if (twin !== undefined) {
      if (twin !== migration.checksum) problems.push(`${migration.id} is defined twice with different checksums`);
      continue;
    }
    seen.set(migration.id, migration.checksum);
    const recorded = ledger.get(migration.id);
    if (recorded === undefined) {
      if (
        migration.statements.some((statement) => concurrentIndexName(statement)) &&
        !migration.statements.every((statement) => concurrentIndexName(statement))
      ) {
        problems.push(`concurrent index migration ${migration.id} must contain only concurrent indexes`);
      }
      pending.push(migration);
    } else if (recorded !== migration.checksum) {
      if (migration.acceptedChecksums?.includes(recorded)) acceptedPrior.push(migration.id);
      else
        problems.push(
          `migration ${migration.id} checksum mismatch (database=${recorded}, source=${migration.checksum})`,
        );
    }
  }
  if (problems.length) {
    throw new Error(`pg-pool: refusing to migrate; nothing was applied: ${problems.join("; ")}`);
  }
  return { pending, acceptedPrior };
}

const BASELINE_PLAN_LOG = {
  recorded: "already recorded",
  apply: "applying to an empty database",
  adopt: "adopting over the folded migrations",
  upgrade: "upgrading through the pre-baseline migrations",
} as const;

/** Applies the baseline and any pending migrations; returns how many it applied. */
export async function applyPgMigrations(pool: Pool, migrations: readonly PgMigration[]): Promise<number> {
  const client = await pool.connect();
  const failure: { discard?: Error } = {};
  try {
    await lockSchema(client, "qm:schema-migrations");
    const hasLedger = (
      await client.query<{ present: boolean }>("SELECT to_regclass($1) IS NOT NULL AS present", [PG_MIGRATIONS_TABLE])
    ).rows[0]?.present;
    const ledger = new Map(
      hasLedger
        ? (
            await client.query<{ id: string; checksum: string }>(`SELECT id, checksum FROM ${PG_MIGRATIONS_TABLE}`)
          ).rows.map((row) => [row.id, row.checksum] as const)
        : [],
    );
    const baseline = await planSchemaBaseline(client, ledger);
    const chainPending =
      baseline === "adopt" || baseline === "upgrade"
        ? preflightPgMigrations(ledger, schemaBaselineChain().migrations).pending
        : [];
    const { pending, acceptedPrior } = preflightPgMigrations(ledger, migrations);
    console.log(
      `[pg] migration preflight ok: ${pending.length} pending (${ledger.size} recorded); baseline ${BASELINE_PLAN_LOG[baseline]}` +
        (chainPending.length ? ` (${chainPending.length} to run)` : "") +
        (acceptedPrior.length ? `; accepted an earlier checksum for ${acceptedPrior.join(", ")}` : ""),
    );
    if (baseline === "recorded" && pending.length === 0) return 0;
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${PG_MIGRATIONS_TABLE}(
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    );
    let applied = 0;
    if (baseline !== "recorded") {
      if (baseline === "upgrade") await upgradeToSchemaBaseline(client, chainPending, failure);
      await applySchemaBaseline(client, baseline);
      applied += chainPending.length + 1;
    }
    let remaining = pending;
    while (remaining.length) {
      const migration = remaining[0]!;
      remaining = remaining.slice(1);
      if (migration.statements.some((statement) => concurrentIndexName(statement))) {
        await client.query("SELECT pg_advisory_unlock(hashtext('qm:schema-migrations'))");
        const indexLock = `qm:schema-migrations:${migration.id}`;
        await lockSchema(client, indexLock);
        try {
          const done = await client.query(`SELECT 1 FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`, [migration.id]);
          if (!done.rowCount) {
            await createConcurrentIndexes(client, migration);
            await client.query(`INSERT INTO ${PG_MIGRATIONS_TABLE}(id, checksum) VALUES ($1, $2)`, [
              migration.id,
              migration.checksum,
            ]);
            applied++;
          }
        } finally {
          await client
            .query("SELECT pg_advisory_unlock(hashtext($1))", [indexLock])
            .catch(swallowAs("pg-pool: concurrent index unlock", undefined));
        }
        await lockSchema(client, "qm:schema-migrations");
        const ledgerNow = new Map(
          (
            await client.query<{ id: string; checksum: string }>(`SELECT id, checksum FROM ${PG_MIGRATIONS_TABLE}`)
          ).rows.map((row) => [row.id, row.checksum] as const),
        );
        remaining = preflightPgMigrations(ledgerNow, remaining).pending;
        continue;
      }
      await applyInTransaction(client, `migration ${migration.id}`, migration.statements, migration, failure);
      applied++;
    }
    return applied;
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext('qm:schema-migrations'))")
      .catch(swallowAs("pg-pool: schema-migrations unlock", undefined));
    client.release(failure.discard);
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
  return [...(registeredMigrations.get(connectionString)?.values() ?? [])].sort((a, b) => pgMigrationOrder(a.id, b.id));
}

export async function migrateRegisteredPgSchemas(connectionString?: string): Promise<void> {
  const databases = connectionString
    ? [[connectionString, registeredMigrations.get(connectionString)] as const]
    : [...registeredMigrations.entries()];
  for (const [databaseUrl, registered] of databases) {
    if (!registered?.size) continue;
    await migrationQueue(databaseUrl, async () => {
      const pg = (await import("pg")).default;
      const pool = guardedPool(new pg.Pool({ ...pgConnectionOptions(databaseUrl), options: TENANT_BYPASS_OPTION }));
      try {
        const migrations = registeredPgMigrations(databaseUrl);
        await applyPgMigrations(pool, migrations);
        markSettled(databaseUrl, migrations);
        await applyTenancyIfEnabled(pool, databaseUrl, true);
      } finally {
        await pool.end();
      }
    });
  }
}

/**
 * A store passes its migrations (an empty list when the baseline holds its whole schema): before first use the pool
 * applies the baseline and every migration registered for the database, in one global order. A pool created without
 * them only queries (under row-level tenancy it migrates too).
 */
export function createPgPool(connectionString: string): PgPool;
export function createPgPool(connectionString: string, migrationId: string, statements: readonly string[]): PgPool;
export function createPgPool(connectionString: string, definitions: readonly PgMigrationDefinition[]): PgPool;
export function createPgPool(
  connectionString: string,
  idOrDefinitions?: string | readonly PgMigrationDefinition[],
  statements: readonly string[] = [],
): PgPool {
  const migrates = idOrDefinitions !== undefined;
  const definitions =
    typeof idOrDefinitions === "string" ? [{ id: idOrDefinitions, statements }] : (idOrDefinitions ?? []);
  const migrations = definitions.flatMap(pgMigrationsFrom);
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
  // With row-level tenancy every pool migrates first: qm_tenantize() must run on the finished schema.
  async function settle(): Promise<void> {
    if (!migrates && !tenancyEnabled) return;
    await withMigrationPool(async (instance) => {
      // Read the registry here, after construction finished registering, not when the first query was issued.
      const migrations = registeredPgMigrations(connectionString);
      const settled = settledMigrations.get(connectionString);
      const current = settled && migrations.every((migration) => settled.has(migration.id));
      if (current && (!tenancyEnabled || tenantized.has(connectionString))) return;
      const applied = await applyPgMigrations(instance, migrations);
      markSettled(connectionString, migrations);
      await applyTenancyIfEnabled(instance, connectionString, applied > 0);
    });
  }
  async function ready(): Promise<void> {
    if (closed) throw new Error("Postgres store is closed");
    await (readyP ??= settle().catch((error) => {
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
    return runPgQuery(await pool(), text, params, options);
  }
  async function q(text: string, params: unknown[] = [], options?: PgQueryOptions): Promise<Rows> {
    return (await query(text, params, options)).rows;
  }
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await readyP?.catch(() => {}); // ready() callers saw the failure
    await Promise.all([
      queryPoolP?.then((instance) => releasePool(queryUrl, instance, "query")),
      sessionPoolP?.then((instance) => releasePool(connectionString, instance, "session")),
    ]);
  }
  async function migrate(definition: PgMigrationDefinition): Promise<void> {
    const migrations = pgMigrationsFrom(definition);
    for (const migration of migrations) registerPgMigration(connectionString, migration);
    if (closed) throw new Error("Postgres store is closed");
    await ready();
    await withMigrationPool(async (instance) => {
      const applied = await applyPgMigrations(instance, migrations);
      markSettled(connectionString, migrations);
      await applyTenancyIfEnabled(instance, connectionString, applied > 0);
    });
  }
  function registerMigration(definition: PgMigrationDefinition): void {
    for (const migration of pgMigrationsFrom(definition)) registerPgMigration(connectionString, migration);
  }
  return { pool, sessionPool, q, query, registerMigration, migrate, close };
}
