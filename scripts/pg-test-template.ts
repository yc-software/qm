import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const PREFIX = "qmt_template_";
const UNUSED_MS = 24 * 60 * 60 * 1000;
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const LOCKFILE = "package-lock.json";

interface Note {
  files: string[];
  digest: string;
  usedAt: number;
}

interface Template {
  name: string;
  note: Note;
}

export function databaseUrl(base: string, name: string): string {
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
    typeof value.digest === "string" &&
    "usedAt" in value &&
    typeof value.usedAt === "number"
  );
}

function parsed(note: string | null): Note | undefined {
  try {
    const value: unknown = JSON.parse(String(note));
    return isNote(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function templates(admin: pg.Client): Promise<Template[]> {
  const { rows } = await admin.query<{ datname: string; note: string | null }>(
    "SELECT datname, shobj_description(oid, 'pg_database') AS note FROM pg_database WHERE starts_with(datname, $1)",
    [PREFIX],
  );
  return rows.flatMap(({ datname, note }) => {
    const found = parsed(note);
    return found ? [{ name: datname, note: found }] : [];
  });
}

async function annotate(admin: pg.Client, name: string, note: Note): Promise<void> {
  await admin.query(`COMMENT ON DATABASE ${pg.escapeIdentifier(name)} IS ${pg.escapeLiteral(JSON.stringify(note))}`);
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

async function migrate(databaseUrl: string, vector: boolean): Promise<void> {
  const { buildApp } = await import("../src/wiring.ts");
  const { migrateRegisteredPgSchemas } = await import("../src/persistence/pg-pool.ts");
  const { createPostgresAppPageViewLog } = await import("../src/deploy/page-views.ts");
  const { createPostgresFileUploadStore } = await import("../src/files/file-upload-store.ts");
  const { createPostgresVectorStore } = await import("../src/memory/postgres-vector-store.ts");
  const { createPostgresBudgetTracker } = await import("../src/ratelimit/postgres-budget.ts");
  const { createPostgresProcessRegistry } = await import("../src/processes/process-registry.ts");
  const { testConfig } = await import("../test/support/test-config.ts");
  const { ownerUrl, seedTestTenant, TEST_TENANT } = await import("../test/support/test-tenant.ts");
  await seedTestTenant(databaseUrl);
  const { runtime } = buildApp({ anthropicApiKey: "test-anthropic-key", ...testConfig({ databaseUrl }) });
  try {
    createPostgresAppPageViewLog(databaseUrl);
    createPostgresFileUploadStore(databaseUrl);
    createPostgresBudgetTracker(databaseUrl);
    createPostgresProcessRegistry(databaseUrl);
    if (vector) createPostgresVectorStore(databaseUrl);
    await migrateRegisteredPgSchemas(databaseUrl);
    const owner = new pg.Client({ connectionString: ownerUrl(databaseUrl).toString() });
    await owner.connect();
    await owner.query("DELETE FROM tenants WHERE id <> $1", [TEST_TENANT]);
    await owner.end();
  } finally {
    await runtime.stop();
  }
}

async function publish(admin: pg.Client, build: string, name: string): Promise<boolean> {
  await admin.query(`ALTER DATABASE ${pg.escapeIdentifier(build)} WITH ALLOW_CONNECTIONS false`);
  await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [build]);
  try {
    await admin.query(`ALTER DATABASE ${pg.escapeIdentifier(build)} RENAME TO ${pg.escapeIdentifier(name)}`);
    return true;
  } catch (error) {
    if (!(error instanceof pg.DatabaseError && error.code === "42P04")) throw error;
    return false;
  }
}

async function evictUnused(admin: pg.Client, now: number): Promise<void> {
  for (const { name, note } of await templates(admin)) {
    if (now - note.usedAt < UNUSED_MS) continue;
    await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)}`).catch((error: unknown) => {
      if (!(error instanceof pg.DatabaseError && error.code === "55006")) throw error;
    });
  }
}

async function template(base: string, build: string): Promise<string> {
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  try {
    const vector = (await admin.query("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'")).rows.length > 0;
    const now = Date.now();
    for (const { name, note } of await templates(admin)) {
      if (!note.files.every((file) => existsSync(ROOT + file)) || digest(note.files, vector) !== note.digest) continue;
      await annotate(admin, name, { ...note, usedAt: now });
      return name;
    }
    const seen = recordImports();
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(build)}`);
    await migrate(databaseUrl(base, build), vector);
    const files = [
      ...[...seen].map((file) => relative(ROOT, file)).filter((file) => !file.startsWith("node_modules/")),
      LOCKFILE,
    ].sort();
    const note = { files, digest: digest(files, vector), usedAt: now };
    const name = `${PREFIX}${note.digest.slice(0, 32)}`;
    await annotate(admin, build, note);
    if (!(await publish(admin, build, name))) await annotate(admin, name, note);
    await evictUnused(admin, now);
    return name;
  } finally {
    await admin.end();
  }
}

if (import.meta.main) {
  const [base, build] = process.argv.slice(2);
  if (!base || !build) throw new Error("Usage: pg-test-template.ts <server url> <scratch database name>");
  process.stdout.write(`${await template(base, build)}\n`);
  process.exit(0);
}
