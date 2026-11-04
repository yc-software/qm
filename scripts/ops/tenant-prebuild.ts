import pg from "pg";
import { parseArgs } from "node:util";
import { loadConfig, type Config } from "../../src/config.ts";
import { withRegisteredPgSchemas } from "../../src/migrate-main.ts";
import { buildConcurrentIndex, registeredPgMigrations, type PgMigration } from "../../src/persistence/pg-pool.ts";

const TENANT_INDEX =
  /^\s*CREATE\s+UNIQUE\s+INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+[a-z_][a-z0-9_]*\s+ON\s+([a-z_][a-z0-9_]*)\s*\(\s*tenant_id\s*,\s*([^)]+)\)(?:\s+WHERE\s+(.+))?$/is;
const TENANT_PRIMARY_KEY =
  /^\s*ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+DROP\s+CONSTRAINT\s+\S+\s*,\s*ADD\s+PRIMARY\s+KEY\s*\(\s*tenant_id\s*,\s*([^)]+)\)\s*$/is;

export interface LegacyKey {
  table: string;
  name: string;
  statement: string;
}

export function legacyKeys(migrations: readonly PgMigration[]): LegacyKey[] {
  const found = new Map<string, LegacyKey>();
  for (const statement of migrations.flatMap((migration) => migration.statements)) {
    const match = TENANT_INDEX.exec(statement) ?? TENANT_PRIMARY_KEY.exec(statement);
    if (!match) continue;
    const table = match[1]!.toLowerCase();
    const columns = match[2]!.trim();
    const where = match[3]?.trim();
    const name = `${table}_legacy_${columns.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_key`.slice(0, 63);
    found.set(name, {
      table,
      name,
      statement: `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${table}(${columns})${where ? ` WHERE ${where}` : ""}`,
    });
  }
  return [...found.values()];
}

const UNREACHABLE = "postgres://qm-tenant-prebuild.invalid/qm";

export function registeredTenantMigrations(config: Config): Promise<readonly PgMigration[]> {
  return withRegisteredPgSchemas(
    { ...config, databaseUrl: UNREACHABLE },
    async () => registeredPgMigrations(UNREACHABLE),
    { vector: true },
  );
}

const log = (event: Record<string, unknown>): void =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));

async function timed<T>(event: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await run();
  log({ ...event, ms: Math.round(performance.now() - started) });
  return result;
}

async function indexState(client: pg.ClientBase, name: string): Promise<"absent" | "valid" | "invalid"> {
  const { rows } = await client.query<{ valid: boolean }>(
    "SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass($1)",
    [name],
  );
  if (rows[0] === undefined) return "absent";
  return rows[0].valid ? "valid" : "invalid";
}

export async function prebuildLegacyKeys(
  client: pg.ClientBase,
  migrations: readonly PgMigration[],
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<void> {
  if (!dryRun) await client.query("SET statement_timeout = 0");
  for (const { table, name, statement } of legacyKeys(migrations)) {
    if (!(await client.query("SELECT to_regclass($1) IS NOT NULL AS exists", [table])).rows[0]?.exists) {
      log({ step: "index", table, name, skipped: "missing table" });
      continue;
    }
    if (dryRun) log({ step: "index", table, dryRun, existing: await indexState(client, name), statement });
    else await timed({ step: "index", table, statement }, () => buildConcurrentIndex(client, statement));
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
  const config = loadConfig();
  const databaseUrl = config.databaseUrl;
  if (!databaseUrl) throw new Error("set DATABASE_URL to the owner login of the database to prebuild");
  const migrations = await registeredTenantMigrations(config);
  const client = new pg.Client({ connectionString: databaseUrl, application_name: "qm-tenant-prebuild" });
  await client.connect();
  try {
    const dryRun = values["dry-run"];
    await timed({ step: "done", dryRun }, () => prebuildLegacyKeys(client, migrations, { dryRun }));
  } finally {
    await client.end();
  }
}

if (import.meta.main)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
