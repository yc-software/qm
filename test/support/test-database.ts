import { randomBytes } from "node:crypto";
import pg from "pg";
import { boundTenant } from "../../src/tenants/context.ts";
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from "node:worker_threads";
import { createPostgresAdminGrantStore } from "../../src/admin/postgres-admin-grant-store.ts";
import { createAdminGrantStore, type AdminGrant, type AdminGrantStore } from "../../src/admin/admin-grant-store.ts";
import { createPostgresAdvisoryLock, type AdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { createPostgresMapFactory, type DurableMap } from "../../src/persistence/durable-map.ts";
import { createPgPool, type PgPool } from "../../src/persistence/pg-pool.ts";
import { APP_ROLE, boundUrl, ownerUrl } from "./test-tenant.ts";
import { configStoreMaps, createConfigStore } from "../../src/resolution/config-store.ts";
import { orgId } from "../../src/config.ts";
import { scopeId } from "../../src/types.ts";
import { createPostgresUserStore } from "../../src/identity/user-store.ts";

function baseDatabaseUrl(): URL {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("Set DATABASE_URL to a Postgres server the tests may create databases on");
  return ownerUrl(base);
}

let databaseWorker: { worker: Worker; signal: Int32Array; port: MessagePort } | undefined;

function askDatabaseWorker(request: { template?: string; bare?: boolean; database?: string; sql?: string }): string {
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
  const deadline = Date.now() + 120_000;
  while (Atomics.load(signal, 0) === 0) {
    if (Atomics.wait(signal, 0, 0, Math.max(0, deadline - Date.now())) === "timed-out")
      throw new Error("Timed out creating a test database");
  }
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
  return boundUrl(databaseUrl(askDatabaseWorker({})));
}

export function testBareDatabaseUrl(): string {
  return databaseUrl(askDatabaseWorker({ bare: true }));
}

export function testMigratedDatabaseUrl(): string {
  const template = process.env.QM_TEST_TEMPLATE_DATABASE;
  if (!template) throw new Error("QM_TEST_TEMPLATE_DATABASE is unset: run tests through scripts/run-pg-tests.mjs");
  return boundUrl(databaseUrl(askDatabaseWorker({ template })), APP_ROLE);
}

let shared: { name: string; url: string; maps: ReturnType<typeof createPostgresMapFactory> } | undefined;

function sharedDatabase(): NonNullable<typeof shared> {
  if (!shared) {
    const name = askDatabaseWorker({});
    const url = boundUrl(databaseUrl(name));
    shared = { name, url, maps: createPostgresMapFactory(url) };
  }
  return shared;
}

const mapTable = (table: string): string => `
  CREATE TABLE ${table} (LIKE ack_emoji INCLUDING ALL);
  ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON ${table} USING (tenant_id = qm_bound_tenant()) WITH CHECK (tenant_id = qm_bound_tenant());
  CREATE FUNCTION claim_${table}() RETURNS TABLE(tenant_id uuid, id text) LANGUAGE sql SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$ SELECT tenant_id, id FROM ${table} WHERE tenant_id IN (SELECT qm_serving_tenants()) ORDER BY tenant_id, id $$;
  CREATE FUNCTION claim_${table}_tenants() RETURNS TABLE(tenant_id uuid, id text) LANGUAGE sql SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$ SELECT DISTINCT tenant_id, '${table}'::text FROM ${table} WHERE tenant_id IN (SELECT qm_serving_tenants()) $$;`;

export function testMap<T>(indexedFields?: readonly Extract<keyof T, string>[]): DurableMap<T> {
  const { name, maps } = sharedDatabase();
  const table = `t_${randomBytes(8).toString("hex")}`;
  askDatabaseWorker({ database: name, sql: mapTable(table) });
  return maps.map<T>(table, indexedFields);
}

export async function readyTestMap<T>(): Promise<DurableMap<T>> {
  const map = testMap<T>();
  await map.get("");
  return map;
}

export function testPgPool(): PgPool {
  return createPgPool(sharedDatabase().url);
}

export function testAdvisoryLock(): AdvisoryLock {
  return createPostgresAdvisoryLock(createPgPool(testDatabaseUrl()));
}

export function testCountedAdvisoryLock(): { lock: AdvisoryLock; held: () => number; close: () => Promise<void> } {
  const sessions = new pg.Pool({ connectionString: testDatabaseUrl(), max: 32 });
  const pool = createPgPool(testDatabaseUrl());
  let held = 0;
  sessions.on("acquire", () => held++);
  sessions.on("release", () => held--);
  return {
    lock: createPostgresAdvisoryLock({ ...pool, sessionPool: async () => sessions }),
    held: () => held,
    close: async () => {
      await sessions.end();
      await pool.close();
    },
  };
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
  return createAdminGrantStore(createPostgresAdminGrantStore(testDatabaseUrl()), {
    seed,
    seedsTenant: (t) => t.id === boundTenant(),
  });
}

export function testDeployBackings(
  backings: Partial<Parameters<typeof import("../../src/deploy/deploy-store.ts").createDeployStore>[0]> = {},
) {
  const databaseUrl = testDatabaseUrl();
  const maps = createPostgresMapFactory(databaseUrl);
  return {
    databaseUrl,
    deployments: maps.map<import("../../src/deploy/deploy-store.ts").PublishedApp>("deployments"),
    drafts: maps.map<import("../../src/deploy/deploy-store.ts").AppDraft>("deployment_drafts"),
    pg: maps.pool,
    ...backings,
  };
}

export const testUsers = () => createPostgresUserStore(sharedDatabase().url);

export const testUserStore = () => createPostgresUserStore(testMigratedDatabaseUrl());
