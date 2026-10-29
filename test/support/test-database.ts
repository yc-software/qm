import { randomBytes } from "node:crypto";
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from "node:worker_threads";
import { createPostgresAdminGrantStore } from "../../src/admin/postgres-admin-grant-store.ts";
import { createAdminGrantStore, type AdminGrant, type AdminGrantStore } from "../../src/admin/admin-grant-store.ts";
import { createPostgresAdvisoryLock, type AdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { createPostgresMapFactory, type DurableMap } from "../../src/persistence/durable-map.ts";
import { createPgPool, type PgPool } from "../../src/persistence/pg-pool.ts";
import { configStoreMaps, createConfigStore } from "../../src/resolution/config-store.ts";
import { orgId } from "../../src/config.ts";
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

export function testDatabaseUrl(): string {
  return databaseUrl(createDatabaseSync({}));
}

export function testMigratedDatabaseUrl(): string {
  return databaseUrl(createDatabaseSync({ template: process.env.QM_TEST_TEMPLATE_DATABASE ?? "" }));
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

export function testConfigStore(orgId: string, opts: Partial<Parameters<typeof createConfigStore>[1]> = {}) {
  return createConfigStore(orgId, { ...configStoreMaps(() => testMap<never>()), ...opts });
}

export const TEST_ADMIN_GRANTS = "admin-alice:org_admin,admin-bob:org_admin";

export function testAdminGrantStore(
  seed: AdminGrant[] = ["admin-alice", "admin-bob"].map((principalId) => ({
    principalId,
    scopeId: scopeId("org", orgId()),
    role: "org_admin" as const,
  })),
): AdminGrantStore {
  return createAdminGrantStore(createPostgresAdminGrantStore(testDatabaseUrl()), { seed });
}

export function testDeployBackings(
  backings: Partial<Parameters<typeof import("../../src/deploy/deploy-store.ts").createDeployStore>[0]> = {},
) {
  const maps = createPostgresMapFactory(testDatabaseUrl());
  return {
    deployments: maps.map<import("../../src/deploy/deploy-store.ts").Deployment>("deployments"),
    pg: maps.pool,
    ...backings,
  };
}
