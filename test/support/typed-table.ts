import pg from "pg";
import { applyPgMigrations, definePgMigration, migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { TENANCY_BASE } from "../../src/tenants/migrations.ts";
import { createAppLogin, type AppLogin } from "./app-login.ts";
import { testBareDatabaseUrl } from "./test-database.ts";
import { testTenants } from "./test-tenants.ts";

export const skipWithoutPg = process.env.DATABASE_URL
  ? false
  : "set DATABASE_URL (a Postgres) to run typed-table tests";

type Closable = { close?: () => Promise<void> };

export interface TypedTableDb<S> {
  store: S;
  admin: pg.Pool;
  url: string;
  tenant: string;
  otherTenant: string;
}

export function ownerUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.delete("options");
  return url.toString();
}

export async function withTypedTableDb<S extends Closable>(
  make: (url: string) => S,
  fn: (db: TypedTableDb<S>) => Promise<void>,
  seed?: (admin: pg.Pool) => Promise<void>,
): Promise<void> {
  const [tenant, otherTenant] = testTenants();
  const url = testBareDatabaseUrl();
  const admin = new pg.Pool({ connectionString: url });
  let store: S | undefined;
  let login: AppLogin | undefined;
  try {
    await seed?.(admin);
    await applyPgMigrations(admin, [definePgMigration(TENANCY_BASE)]);
    await admin.query(`INSERT INTO tenants(id) VALUES ($1)`, [tenant]);
    const owner = make(url);
    await migrateRegisteredPgSchemas(url);
    await owner.close?.();
    await admin.query(`INSERT INTO tenants(id) VALUES ($1)`, [otherTenant]);
    login = await createAppLogin(url);
    store = make(login.url);
    await fn({ store, admin, url: login.url, tenant, otherTenant });
  } finally {
    await store?.close?.();
    await login?.drop();
    await admin.end();
  }
}

export async function seedKeyValueTable(admin: pg.Pool, table: string, rows: Record<string, unknown>): Promise<void> {
  await admin.query(`CREATE TABLE ${table}(id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
  await admin.query(`CREATE TABLE IF NOT EXISTS durable_map_versions(tbl TEXT PRIMARY KEY, v BIGINT NOT NULL)`);
  await admin.query(`INSERT INTO durable_map_versions(tbl, v) VALUES ($1, 1)`, [table]);
  for (const [id, json] of Object.entries(rows)) {
    await admin.query(`INSERT INTO ${table}(id, json) VALUES ($1, $2)`, [id, JSON.stringify(json)]);
  }
}
