import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from "node:worker_threads";
import { createPostgresAdminGrantStore } from "../../src/admin/postgres-admin-grant-store.ts";
import { createAdminGrantStore, type AdminGrant, type AdminGrantStore } from "../../src/admin/admin-grant-store.ts";
import { createPostgresAdvisoryLock, type AdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { createPgPool, type PgPool } from "../../src/persistence/pg-pool.ts";
import { createConfigStore } from "../../src/resolution/config-store.ts";
import { createSandboxBodies, type SandboxBodies } from "../../src/sandbox/sandbox-bodies.ts";
import type { MapConversion } from "../../src/persistence/typed-table.ts";
import { tenant } from "../../src/tenant.ts";
import { scopeId } from "../../src/types.ts";

function baseDatabaseUrl(): URL {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("Set DATABASE_URL to a Postgres server the tests may create databases on");
  return new URL(base);
}

let databaseWorker: { worker: Worker; signal: Int32Array; port: MessagePort } | undefined;

function createDatabaseSync(request: { template?: string }): string {
  if (!databaseWorker) {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(new URL("./database-worker.ts", import.meta.url), {
      workerData: { base: baseDatabaseUrl().toString(), signal, port: port2 },
      transferList: [port2],
      execArgv: [],
    });
    worker.unref();
    databaseWorker = { worker, signal, port: port1 };
  }
  const { worker, signal, port } = databaseWorker;
  Atomics.store(signal, 0, 0);
  worker.postMessage(request);
  if (Atomics.wait(signal, 0, 0, 120_000) === "timed-out") throw new Error("Timed out creating a test database");
  const reply = receiveMessageOnPort(port)?.message as { ok: boolean; name?: string; message?: string } | undefined;
  if (!reply?.ok || !reply.name) throw new Error(`Could not create a test database: ${reply?.message ?? "no reply"}`);
  return reply.name;
}

function databaseUrl(name: string): string {
  const url = baseDatabaseUrl();
  url.pathname = `/${name}`;
  return url.toString();
}

// Both clone the runner's migrated template when there is one: building the baseline schema per database costs more
// than copying it.
export function testDatabaseUrl(): string {
  return testMigratedDatabaseUrl();
}

export function testMigratedDatabaseUrl(): string {
  return databaseUrl(createDatabaseSync({ template: process.env.QM_TEST_TEMPLATE_DATABASE ?? "" }));
}

let shared: string | undefined;

export function testSandboxBodies<T extends object>(migration: MapConversion): SandboxBodies<T> {
  return createSandboxBodies<T>(testDatabaseUrl(), migration);
}

export function testQuery(url: string, text: string) {
  return createPgPool(url).q(text);
}

export function testPgPool(): PgPool {
  return createPgPool((shared ??= testDatabaseUrl()));
}

export function testAdvisoryLock(): AdvisoryLock {
  return createPostgresAdvisoryLock(createPgPool(testDatabaseUrl()));
}

export function testConfigStore(opts: Partial<Parameters<typeof createConfigStore>[0]> = {}) {
  return createConfigStore({
    databaseUrl: opts.databaseUrl ?? testDatabaseUrl(),
    connectorSecretKey: "test-connector-secret",
    ...opts,
  });
}

export async function failTableWrites(url: string, table: string): Promise<void> {
  const db = createPgPool(url);
  await db.q(`CREATE OR REPLACE FUNCTION qm_test_forced_failure() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN RAISE EXCEPTION 'forced durable write failure'; END $f$`);
  await db.q(`CREATE TRIGGER ${table}_forced_failure BEFORE INSERT OR UPDATE OR DELETE ON ${table}
    FOR EACH ROW EXECUTE FUNCTION qm_test_forced_failure()`);
}

export const TEST_ADMIN_GRANTS = "admin-alice:org_admin,admin-bob:org_admin";

export function testAdminGrantStore(
  seed: AdminGrant[] = ["admin-alice", "admin-bob"].map((principalId) => ({
    principalId,
    scopeId: scopeId("org", tenant().orgId),
    role: "org_admin" as const,
  })),
): AdminGrantStore {
  return createAdminGrantStore(createPostgresAdminGrantStore(testDatabaseUrl()), { seed: () => seed });
}

export function testDeployBackings(
  backings: Partial<Parameters<typeof import("../../src/deploy/deploy-store.ts").createDeployStore>[0]> = {},
) {
  return { databaseUrl: testDatabaseUrl(), ...backings };
}

/** Empties the given tables where they exist, so each test starts from the migrated schema with no rows. */
export async function truncateTables(url: string, tables: readonly string[]): Promise<void> {
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: url });
  try {
    const { rows } = await pool.query<{ name: string }>(
      "SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass(name) IS NOT NULL",
      [tables],
    );
    if (rows.length) await pool.query(`TRUNCATE ${rows.map((row) => row.name).join(", ")} CASCADE`);
  } finally {
    await pool.end();
  }
}
