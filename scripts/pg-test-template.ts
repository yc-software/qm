import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import pg from "pg";

const PREFIX = "qmt_template_";
const KEEP = 8;
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const LOCKFILE = "package-lock.json";

interface Note {
  files: string[];
  digest: string;
}

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

function digest(files: readonly string[], vector: boolean): string {
  const hash = createHash("sha256").update(String(vector));
  for (const file of files) hash.update(`\0${file}\0`).update(readFileSync(ROOT + file));
  return hash.digest("hex");
}

function isNote(value: unknown): value is Note {
  return (
    typeof value === "object" &&
    value !== null &&
    "files" in value &&
    Array.isArray(value.files) &&
    "digest" in value &&
    typeof value.digest === "string"
  );
}

async function cached(admin: pg.Client, vector: boolean): Promise<string | undefined> {
  const { rows } = await admin.query<{ datname: string; note: string | null }>(
    "SELECT datname, shobj_description(oid, 'pg_database') AS note FROM pg_database WHERE starts_with(datname, $1) ORDER BY oid DESC",
    [PREFIX],
  );
  for (const { datname, note } of rows) {
    const parsed: unknown = JSON.parse(String(note));
    if (!isNote(parsed) || !parsed.files.every((file) => existsSync(ROOT + file))) continue;
    if (digest(parsed.files, vector) === parsed.digest) return datname;
  }
  return undefined;
}

function recordImports(): Set<string> {
  const seen = new Set<string>([fileURLToPath(import.meta.url)]);
  registerHooks({
    resolve(specifier, context, next) {
      const resolved = next(specifier, context);
      if (resolved.url.startsWith("file:")) seen.add(fileURLToPath(resolved.url));
      return resolved;
    },
  });
  return seen;
}

async function migrate(databaseUrl: string, vector: boolean): Promise<string> {
  const { buildApp } = await import("../src/wiring.ts");
  const pgPool = await import("../src/persistence/pg-pool.ts");
  const { TENANCY } = await import("../src/tenants/migrations.ts");
  const { createPostgresAppPageViewLog } = await import("../src/deploy/page-views.ts");
  const { createPostgresFileUploadStore } = await import("../src/files/file-upload-store.ts");
  const { createPostgresVectorStore } = await import("../src/memory/postgres-vector-store.ts");
  const { createPostgresBudgetTracker } = await import("../src/ratelimit/postgres-budget.ts");
  const { createPostgresProcessRegistry } = await import("../src/processes/process-registry.ts");
  const { testConfig } = await import("../test/support/test-config.ts");
  const { ownerUrl, seedTestTenant, TEST_TENANT } = await import("../test/support/test-tenant.ts");
  await seedTestTenant(databaseUrl);
  const { runtime } = buildApp({ anthropicApiKey: "test-anthropic-key", ...testConfig({ databaseUrl }) });
  createPostgresAppPageViewLog(databaseUrl);
  createPostgresFileUploadStore(databaseUrl);
  createPostgresBudgetTracker(databaseUrl);
  createPostgresProcessRegistry(databaseUrl);
  if (vector) createPostgresVectorStore(databaseUrl);
  const key = createHash("sha256");
  for (const { id, checksum } of [
    ...TENANCY.map(pgPool.definePgMigration),
    ...pgPool.registeredPgMigrations(databaseUrl),
  ])
    key.update(`${id}\0${checksum}\0`);
  for (const file of [
    "scripts/pg-test-template.ts",
    "test/support/test-tenant.ts",
    "src/persistence/app-role-grants.ts",
  ])
    key.update(readFileSync(ROOT + file));
  const name = `${PREFIX}${key.digest("hex").slice(0, 32)}`;
  const admin = new pg.Client({ connectionString: ownerUrl(databaseUrl).toString() });
  await admin.connect();
  try {
    if ((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rows.length === 0) {
      await pgPool.migrateRegisteredPgSchemas(databaseUrl);
      await admin.query("DELETE FROM tenants WHERE id <> $1", [TEST_TENANT]);
    }
  } finally {
    await admin.end();
    await runtime.stop();
  }
  return name;
}

async function publish(admin: pg.Client, build: string, name: string): Promise<void> {
  await admin.query(`ALTER DATABASE ${quoted(build)} WITH ALLOW_CONNECTIONS false`);
  await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [build]);
  try {
    await admin.query(`ALTER DATABASE ${quoted(build)} RENAME TO ${quoted(name)}`);
  } catch (error) {
    if (!(error instanceof pg.DatabaseError && error.code === "42P04")) throw error;
  }
  const { rows } = await admin.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE starts_with(datname, $1) ORDER BY oid DESC OFFSET $2",
    [PREFIX, KEEP],
  );
  for (const { datname } of rows) {
    await admin.query(`DROP DATABASE IF EXISTS ${quoted(datname)}`).catch((error: unknown) => {
      if (!(error instanceof pg.DatabaseError && error.code === "55006")) throw error;
    });
  }
}

async function template(base: string, build: string): Promise<string> {
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  try {
    const vector = (await admin.query("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'")).rows.length > 0;
    const hit = await cached(admin, vector);
    if (hit) return hit;
    const seen = recordImports();
    await admin.query(`CREATE DATABASE ${quoted(build)}`);
    const name = await migrate(databaseUrl(base, build), vector);
    if ((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rows.length === 0)
      await publish(admin, build, name);
    const files = [
      ...[...seen].map((file) => relative(ROOT, file)).filter((file) => !file.startsWith("node_modules/")),
      LOCKFILE,
    ].sort();
    const note = JSON.stringify({ files, digest: digest(files, vector) } satisfies Note);
    await admin.query(`COMMENT ON DATABASE ${quoted(name)} IS ${pg.escapeLiteral(note)}`);
    return name;
  } finally {
    await admin.end();
  }
}

if (import.meta.main) {
  const [base, build] = process.argv.slice(2);
  if (!base || !build) throw new Error("Usage: test-template.ts <server url> <scratch database name>");
  process.stdout.write(`${await template(base, build)}\n`);
  process.exit(0);
}
