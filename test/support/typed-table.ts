import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { createPostgresSessionStore } from "../../src/sessions/postgres-session-store.ts";

export const PG_URL = process.env.DATABASE_URL;
export const skipWithoutPg = PG_URL ? false : "set DATABASE_URL (a Postgres) to run typed-table tests";

export interface TypedTableDb<S> {
  store: S;
  admin: pg.Pool;
  url: string;
  tenant: string;
  otherTenant: string;
}

export async function withTypedTableDb<S extends { close?: () => Promise<void> }>(
  make: (url: string) => S,
  fn: (db: TypedTableDb<S>) => Promise<void>,
  seed?: (admin: pg.Pool) => Promise<void>,
): Promise<void> {
  const schema = `typed_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(PG_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const admin = new pg.Pool({ connectionString: url.toString() });
  await admin.query(`CREATE SCHEMA ${schema}`);
  createPostgresSessionStore(url.toString());
  const store = make(url.toString());
  try {
    await seed?.(admin);
    await migrateRegisteredPgSchemas(url.toString());
    const tenant = String((await admin.query(`SELECT id::text AS id FROM tenants`)).rows[0].id);
    const otherTenant = randomUUID();
    await admin.query(`INSERT INTO tenants(id, slug, name) VALUES ($1, 'other', 'Other')`, [otherTenant]);
    await fn({ store, admin, url: url.toString(), tenant, otherTenant });
  } finally {
    await store.close?.();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
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
