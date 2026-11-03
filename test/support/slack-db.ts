import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { createSlackTables, type SlackTables } from "../../src/slack/slack-tables.ts";
import { type AppLogin, createAppLogin } from "./app-login.ts";
import { testDatabaseUrl } from "./test-database.ts";

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
  const ownerUrl = new URL(process.env.DATABASE_URL!);
  ownerUrl.searchParams.set("options", `-c search_path=${schema}`);
  const admin = new pg.Pool({ connectionString: ownerUrl.toString() });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`GRANT CREATE ON SCHEMA ${schema} TO PUBLIC`);
  const owner = createSlackTables(ownerUrl.toString());
  let store: SlackTables | undefined;
  let login: AppLogin | undefined;
  try {
    await seed?.(admin);
    await migrateRegisteredPgSchemas(ownerUrl.toString());
    const tenant = randomUUID();
    const otherTenant = randomUUID();
    if (!(await admin.query(`SELECT 1 FROM tenants`)).rowCount)
      await admin.query(`INSERT INTO tenants(id, slug, name) VALUES ($1, 'main', 'Main')`, [tenant]);
    const first = String((await admin.query(`SELECT id::text AS id FROM tenants`)).rows[0].id);
    await admin.query(`INSERT INTO tenants(id, slug, name) VALUES ($1, 'other', 'Other')`, [otherTenant]);
    login = await createAppLogin(ownerUrl.toString());
    store = createSlackTables(login.url);
    await fn({ store, owner, admin, tenant: first, otherTenant });
  } finally {
    await store?.pool.close();
    await owner.pool.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await login?.drop();
    await admin.end();
  }
}

export function slackTestTables(): SlackTables {
  return createSlackTables(testDatabaseUrl());
}
