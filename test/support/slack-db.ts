import { randomUUID } from "node:crypto";
import pg from "pg";
import { configurePgPooling, migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { createSlackTables, type SlackTables } from "../../src/slack/slack-tables.ts";

export const skipWithoutPg = process.env.DATABASE_URL
  ? false
  : "set DATABASE_URL (a Postgres) to run Slack table tests";

export interface SlackDb {
  store: SlackTables;
  owner: SlackTables;
  admin: pg.Pool;
  tenant: string;
  otherTenant: string;
}

export async function withSlackDb(
  fn: (db: SlackDb) => Promise<void>,
  seed?: (admin: pg.Pool) => Promise<void>,
): Promise<void> {
  const id = randomUUID().replaceAll("-", "");
  const schema = `slack_${id}`;
  const role = `app_${id}`;
  const ownerUrl = new URL(process.env.DATABASE_URL!);
  ownerUrl.searchParams.set("options", `-c search_path=${schema}`);
  const appUrl = new URL(ownerUrl);
  appUrl.username = role;
  appUrl.password = "app";
  const admin = new pg.Pool({ connectionString: ownerUrl.toString() });
  await admin.query(`CREATE SCHEMA ${schema}`);
  configurePgPooling({ databaseUrl: appUrl.toString(), ownerUrl: ownerUrl.toString() });
  const owner = createSlackTables(ownerUrl.toString());
  let store: SlackTables | undefined;
  try {
    await seed?.(admin);
    await migrateRegisteredPgSchemas(ownerUrl.toString());
    const tenant = randomUUID();
    const otherTenant = randomUUID();
    if (!(await admin.query(`SELECT 1 FROM tenants`)).rowCount)
      await admin.query(`INSERT INTO tenants(id, slug, name) VALUES ($1, 'main', 'Main')`, [tenant]);
    const first = String((await admin.query(`SELECT id::text AS id FROM tenants`)).rows[0].id);
    await admin.query(`INSERT INTO tenants(id, slug, name) VALUES ($1, 'other', 'Other')`, [otherTenant]);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS IN ROLE qm_app`);
    await admin.query(`GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${role}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO qm_app`);
    store = createSlackTables(appUrl.toString());
    await fn({ store, owner, admin, tenant: first, otherTenant });
  } finally {
    await store?.pool.close();
    await owner.pool.close();
    configurePgPooling({});
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  }
}
