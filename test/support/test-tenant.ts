import pg from "pg";
import { applyPgMigrations, definePgMigration } from "../../src/persistence/pg-pool.ts";
import { TENANCY } from "../../src/tenants/migrations.ts";

export const TEST_TENANT = "00000000-0000-4000-8000-000000000001";
export const APP_ROLE = "qm_app";

export function ownerUrl(databaseUrl: string): URL {
  const url = new URL(databaseUrl);
  url.searchParams.delete("options");
  return url;
}

export function boundUrl(databaseUrl: string, role?: string): string {
  const url = ownerUrl(databaseUrl);
  url.searchParams.set("options", `${role ? `-c role=${role} ` : ""}-c qm.tenant_id=${TEST_TENANT}`);
  return url.toString();
}

async function createAppRole(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl(databaseUrl).toString() });
  await client.connect();
  try {
    await client.query(`DO $role$ BEGIN
      CREATE ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
    END $role$`);
  } finally {
    await client.end();
  }
}

export async function seedTestTenant(databaseUrl: string): Promise<void> {
  await createAppRole(databaseUrl);
  const pool = new pg.Pool({ connectionString: ownerUrl(databaseUrl).toString(), max: 1 });
  try {
    await applyPgMigrations(pool, TENANCY.map(definePgMigration));
    await pool.query("INSERT INTO tenants(id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [TEST_TENANT]);
    await pool.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${APP_ROLE}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
    await pool.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
    await pool.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON tenants FROM ${APP_ROLE}`);
    await pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO ${APP_ROLE}`,
    );
    await pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${APP_ROLE}`,
    );
  } finally {
    await pool.end();
  }
}

export function appUrl(databaseUrl: string): string {
  const url = ownerUrl(databaseUrl);
  url.searchParams.set("options", `-c role=${APP_ROLE}`);
  return url.toString();
}
