import pg from "pg";
import { applyPgMigrations, definePgMigration } from "../../src/persistence/pg-pool.ts";
import { TENANCY } from "../../src/tenants/migrations.ts";
import { grantAppRole } from "../../src/persistence/app-role-grants.ts";

export { TEST_TENANT } from "./test-tenant-id.ts";
import { TEST_TENANT } from "./test-tenant-id.ts";
export const APP_ROLE = "qm_app";

const BINDING = /\s*-c (role|qm\.tenant_id)=\S+/g;

function otherOptions(url: URL): string {
  return (url.searchParams.get("options") ?? "").replace(BINDING, "").trim();
}

export function ownerUrl(databaseUrl: string): URL {
  const url = new URL(databaseUrl);
  const options = otherOptions(url);
  if (options) url.searchParams.set("options", options);
  else url.searchParams.delete("options");
  return url;
}

export function boundUrl(databaseUrl: string, role?: string): string {
  const url = ownerUrl(databaseUrl);
  const options = [otherOptions(url), role ? `-c role=${role}` : "", `-c qm.tenant_id=${TEST_TENANT}`];
  url.searchParams.set("options", options.filter(Boolean).join(" "));
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
    await grantAppRole(async (text, params) => (await pool.query(text, params)).rows, APP_ROLE, "public");
  } finally {
    await pool.end();
  }
}

export function appUrl(databaseUrl: string): string {
  const url = ownerUrl(databaseUrl);
  url.searchParams.set("options", [otherOptions(url), `-c role=${APP_ROLE}`].filter(Boolean).join(" "));
  return url.toString();
}
