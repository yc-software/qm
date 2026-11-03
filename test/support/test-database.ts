import { randomBytes } from "node:crypto";
import { afterEach, beforeEach } from "node:test";
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from "node:worker_threads";
import { createPostgresAdminGrantStore } from "../../src/admin/postgres-admin-grant-store.ts";
import { createAdminGrantStore, type AdminGrant, type AdminGrantStore } from "../../src/admin/admin-grant-store.ts";
import { createPostgresAdvisoryLock, type AdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { createPostgresMapFactory, type DurableMap } from "../../src/persistence/durable-map.ts";
import pg from "pg";
import { applyPgMigrations, createPgPool, registeredPgMigrations, type PgPool } from "../../src/persistence/pg-pool.ts";
import { configStoreMaps, createConfigStore } from "../../src/resolution/config-store.ts";
import { orgId } from "../../src/config.ts";
import { scopeId } from "../../src/types.ts";
import { createIdentityService, type IdentityService } from "../../src/identity/identity-service.ts";
import { useOwnerDatabase } from "../../src/tenants/claim.ts";
import { inTestTenant } from "./test-tenants.ts";

function baseDatabaseUrl(variable: "DATABASE_URL" | "DATABASE_OWNER_URL" = "DATABASE_URL"): URL {
  const base = process.env[variable];
  if (!base) throw new Error(`${variable} is unset: run tests through scripts/run-pg-tests.mjs`);
  return new URL(base);
}

let databaseWorker: { worker: Worker; signal: Int32Array; port: MessagePort } | undefined;

function startDatabaseWorker(): NonNullable<typeof databaseWorker> {
  if (!databaseWorker) {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(new URL("./database-worker.ts", import.meta.url), {
      workerData: { base: baseDatabaseUrl("DATABASE_OWNER_URL").toString(), signal, port: port2 },
      transferList: [port2],
      execArgv: [],
    });
    worker.unref();
    databaseWorker = { worker, signal, port: port1 };
  }
  return databaseWorker;
}

let createdInTest: string[] | undefined;
beforeEach(() => {
  createdInTest = [];
});
afterEach(() => {
  if (createdInTest?.length) startDatabaseWorker().worker.postMessage({ release: createdInTest });
  createdInTest = undefined;
});

function createDatabaseSync(request: { template?: string }, scope: "test" | "file" = "test"): string {
  const { worker, signal, port } = startDatabaseWorker();
  Atomics.store(signal, 0, 0);
  worker.postMessage(request);
  const deadline = Date.now() + 120_000;
  while (Atomics.load(signal, 0) === 0) {
    if (Atomics.wait(signal, 0, 0, Math.max(0, deadline - Date.now())) === "timed-out")
      throw new Error("Timed out creating a test database");
  }
  const reply = receiveMessageOnPort(port)?.message as { ok: boolean; name?: string; message?: string } | undefined;
  if (!reply?.ok || !reply.name) throw new Error(`Could not create a test database: ${reply?.message ?? "no reply"}`);
  if (scope === "test") createdInTest?.push(reply.name);
  return reply.name;
}

function databaseUrl(name: string, variable: "DATABASE_URL" | "DATABASE_OWNER_URL" = "DATABASE_URL"): string {
  const url = baseDatabaseUrl(variable);
  url.pathname = `/${name}`;
  return url.toString();
}

export function ownerUrlOf(databaseUrl: string): string {
  const owner = baseDatabaseUrl("DATABASE_OWNER_URL");
  owner.pathname = new URL(databaseUrl).pathname;
  return owner.toString();
}

export async function migrateTestDatabase(databaseUrl = baseDatabaseUrl().toString()): Promise<void> {
  const owner = new pg.Pool({ connectionString: ownerUrlOf(databaseUrl), max: 1 });
  try {
    await applyPgMigrations(owner, registeredPgMigrations(databaseUrl));
  } finally {
    await owner.end();
  }
}

function ownedDatabaseUrl(name: string): string {
  const url = databaseUrl(name);
  useOwnerDatabase(ownerUrlOf(url));
  return url;
}

export function pointOwnerAtSchema(schema: string): void {
  const owner = new URL(process.env.DATABASE_OWNER_URL!);
  owner.searchParams.set("options", `-c search_path=${schema}`);
  useOwnerDatabase(owner.toString());
}

export function restoreFileOwner(): void {
  useOwnerDatabase(process.env.DATABASE_OWNER_URL);
}

export function testDatabaseUrl(): string {
  return ownedDatabaseUrl(createDatabaseSync({}));
}

export function testBareDatabaseUrl(): string {
  return databaseUrl(createDatabaseSync({ template: "" }), "DATABASE_OWNER_URL");
}

export function testMigratedDatabaseUrl(): string {
  const template = process.env.QM_TEST_TEMPLATE_DATABASE;
  if (!template) throw new Error("QM_TEST_TEMPLATE_DATABASE is unset: run tests through scripts/run-pg-tests.mjs");
  return ownedDatabaseUrl(createDatabaseSync({ template }));
}

let shared: { url: string; maps: ReturnType<typeof createPostgresMapFactory> } | undefined;

function sharedDatabase(): NonNullable<typeof shared> {
  if (!shared) {
    const url = databaseUrl(createDatabaseSync({}, "file"), "DATABASE_OWNER_URL");
    shared = { url, maps: createPostgresMapFactory(url) };
  }
  return shared;
}

export function testMap<T>(indexedFields?: readonly Extract<keyof T, string>[]): DurableMap<T> {
  const { url, maps } = sharedDatabase();
  const map = maps.map<T>(`t_${randomBytes(8).toString("hex")}`, indexedFields);
  const migrated = migrateTestDatabase(url);
  migrated.catch(() => {});
  return new Proxy(map, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await migrated;
        return Reflect.apply(value, target, args);
      };
    },
  });
}

export function testPgPool(): PgPool {
  return createPgPool(sharedDatabase().url);
}

export function testAdvisoryLock(): AdvisoryLock {
  return createPostgresAdvisoryLock(createPgPool(databaseUrl(createDatabaseSync({}))));
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
  return createAdminGrantStore(createPostgresAdminGrantStore(databaseUrl(createDatabaseSync({}))), { seed });
}

export function testDeployBackings(
  backings: Partial<Parameters<typeof import("../../src/deploy/deploy-store.ts").createDeployStore>[0]> = {},
) {
  const maps = createPostgresMapFactory(databaseUrl(createDatabaseSync({})));
  return {
    deployments: maps.map<import("../../src/deploy/deploy-store.ts").Deployment>("deployments"),
    pg: maps.pool,
    ...backings,
  };
}

export async function testIdentity(): Promise<IdentityService> {
  const identity = createIdentityService(testMap(), { externalMembers: testMap() });
  await inTestTenant(() => identity.ready());
  return identity;
}
