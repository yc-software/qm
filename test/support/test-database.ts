import { randomBytes } from "node:crypto";
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from "node:worker_threads";
import { createPostgresAdminGrantStore } from "../../src/admin/postgres-admin-grant-store.ts";
import { createAdminGrantStore, type AdminGrant, type AdminGrantStore } from "../../src/admin/admin-grant-store.ts";
import { createPostgresAdvisoryLock, type AdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { createPostgresMapFactory, type DurableMap } from "../../src/persistence/durable-map.ts";
import { createPgPool, registerOwnerLogin, type PgPool } from "../../src/persistence/pg-pool.ts";
import { pgRows, type RowTable } from "../../src/persistence/keyed-rows.ts";
import { createPostgresDeploymentRows } from "../../src/deploy/deploy-store.ts";
import { createSandboxResourceStores } from "../../src/sandbox/sandbox-resource-store.ts";
import { createConfigStore } from "../../src/resolution/config-store.ts";
import type { ConfigTables } from "../../src/resolution/config-tables.ts";
import { createPostgresConfigTables } from "../../src/resolution/config-tables-pg.ts";
import { tenantRootScope } from "../../src/tenants/context.ts";

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
  return ownedTestDatabase(url.toString());
}

export function ownedTestDatabase(url: string): string {
  registerOwnerLogin(url, url);
  return url;
}

export function testDatabaseUrl(): string {
  return databaseUrl(createDatabaseSync({}));
}

export function testMigratedDatabaseUrl(): string {
  const template = process.env.QM_TEST_TEMPLATE_DATABASE;
  if (!template) throw new Error("QM_TEST_TEMPLATE_DATABASE is unset: run tests through scripts/run-pg-tests.mjs");
  return databaseUrl(createDatabaseSync({ template }));
}

let shared: { url: string; maps: ReturnType<typeof createPostgresMapFactory> } | undefined;

function sharedDatabase(): NonNullable<typeof shared> {
  if (!shared) {
    const url = testDatabaseUrl();
    shared = { url, maps: createPostgresMapFactory(url) };
  }
  return shared;
}

export function testMap<T>(indexedFields?: readonly Extract<keyof T, string>[]): DurableMap<T> {
  return sharedDatabase().maps.map<T>(`t_${randomBytes(8).toString("hex")}`, indexedFields);
}

export function testPgPool(): PgPool {
  return createPgPool(sharedDatabase().url);
}

export function testAdvisoryLock(): AdvisoryLock {
  return createPostgresAdvisoryLock(createPgPool(testDatabaseUrl()));
}

export function testConfigTables(): ConfigTables {
  return { ...createPostgresConfigTables(testMigratedDatabaseUrl()), fresh: true };
}

export function testConfigStore(opts: Partial<Parameters<typeof createConfigStore>[0]> = {}) {
  return createConfigStore({ tables: testConfigTables(), ...opts });
}

export const TEST_ADMIN_GRANTS = "admin-alice:org_admin,admin-bob:org_admin";

export function testAdminGrantStore(
  seed: AdminGrant[] = ["admin-alice", "admin-bob"].map((principalId) => ({
    principalId,
    scopeId: tenantRootScope(),
    role: "org_admin" as const,
  })),
): AdminGrantStore {
  return createAdminGrantStore(createPostgresAdminGrantStore(testDatabaseUrl()), { seed: () => seed });
}

export function testRows<T, K extends string>(spec: RowTable<T, K>) {
  return pgRows(testDatabaseUrl(), spec);
}

export function testSandboxResourceStores() {
  return createSandboxResourceStores(testDatabaseUrl());
}

export function testDeploymentRows() {
  return createPostgresDeploymentRows(testDatabaseUrl());
}

export function testDeployBackings(
  backings: Partial<Parameters<typeof import("../../src/deploy/deploy-store.ts").createDeployStore>[0]> = {},
) {
  return { deployments: testDeploymentRows(), ...backings };
}
