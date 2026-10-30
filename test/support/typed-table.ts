import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";

export const PG_URL = process.env.DATABASE_URL;
export const skipWithoutPg = PG_URL ? false : "set DATABASE_URL (a Postgres) to run typed-table tests";

type Closable = { close?: () => Promise<void> };

export interface TypedTableDb<S> {
  store: S;
  admin: pg.Pool;
  url: string;
  tenant: string;
  otherTenant: string;
}

export async function withTypedTableDb<S extends Closable>(
  make: (url: string) => S,
  fn: (db: TypedTableDb<S>) => Promise<void>,
  seed?: (admin: pg.Pool) => Promise<void>,
): Promise<void> {
  const id = randomUUID().replaceAll("-", "");
  const schema = `typed_${id}`;
  const role = `app_${id}`;
  const ownerUrl = new URL(PG_URL!);
  ownerUrl.searchParams.set("options", `-c search_path=${schema}`);
  const appUrl = new URL(ownerUrl);
  appUrl.username = role;
  appUrl.password = "app";
  const admin = new pg.Pool({ connectionString: ownerUrl.toString() });
  await admin.query(`CREATE SCHEMA ${schema}`);
  createPostgresSessionStore(ownerUrl.toString());
  const owner = make(ownerUrl.toString());
  let store: S | undefined;
  try {
    await seed?.(admin);
    await migrateRegisteredPgSchemas(ownerUrl.toString());
    await admin.query(
      `INSERT INTO tenants(id, slug, name) SELECT gen_random_uuid(), 'main', 'Main' WHERE NOT EXISTS (SELECT 1 FROM tenants)`,
    );
    await owner.close?.();
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS IN ROLE qm_app`);
    await admin.query(`GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO qm_app`);
    const tenant = String((await admin.query(`SELECT id::text AS id FROM tenants`)).rows[0].id);
    const otherTenant = randomUUID();
    await admin.query(`INSERT INTO tenants(id, slug, name) VALUES ($1, 'other', 'Other')`, [otherTenant]);
    store = make(appUrl.toString());
    await fn({ store, admin, url: appUrl.toString(), tenant, otherTenant });
  } finally {
    await store?.close?.();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
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
