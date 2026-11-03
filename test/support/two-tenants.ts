import { randomBytes } from "node:crypto";
import pg from "pg";
import { configurePgPooling, migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { useOwnerDatabase } from "../../src/tenants/owner-pool.ts";
import { testDatabaseUrl } from "./test-database.ts";

export const TENANT_A = "00000000-0000-4000-8000-0000000000a1";
export const TENANT_B = "00000000-0000-4000-8000-0000000000b2";

export interface TwoTenantDatabase {
  ownerUrl: string;
  appUrl: string;
  owner: pg.Pool;
  close(): Promise<void>;
}

const pooledUrl = process.env.DATABASE_POOL_URL;

export function twoTenantTestSkip(): string | false {
  return process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the two-tenant tests";
}

function withLogin(url: string, role: string): string {
  const next = new URL(url);
  next.username = role;
  next.password = role;
  return next.toString();
}

export async function twoTenantDatabase(registerStores: (ownerUrl: string) => unknown): Promise<TwoTenantDatabase> {
  const ownerUrl = pooledUrl ? process.env.DATABASE_URL! : testDatabaseUrl();
  registerStores(ownerUrl);
  await migrateRegisteredPgSchemas(ownerUrl);
  const owner = new pg.Pool({ connectionString: ownerUrl, max: 2 });
  const role = pooledUrl ? "qm_app" : `qmt_app_${randomBytes(6).toString("hex")}`;
  const database = new URL(ownerUrl).pathname.slice(1);
  await owner.query("INSERT INTO tenants(id) VALUES ($1), ($2) ON CONFLICT (id) DO NOTHING", [TENANT_A, TENANT_B]);
  await owner.query(
    `DO $role$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
         CREATE ROLE ${role} LOGIN PASSWORD '${role}' NOBYPASSRLS;
       END IF;
     END $role$`,
  );
  await owner.query(`GRANT CONNECT ON DATABASE "${database}" TO ${role}`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  const appUrl = withLogin(ownerUrl, role);
  if (pooledUrl)
    configurePgPooling({
      databaseUrl: appUrl,
      poolUrl: withLogin(pooledUrl, role),
      ...(process.env.DATABASE_POOL_CA_CERT ? { caCert: process.env.DATABASE_POOL_CA_CERT } : {}),
      queryMax: 4,
    });
  useOwnerDatabase(ownerUrl);
  return {
    ownerUrl,
    appUrl,
    owner,
    async close() {
      useOwnerDatabase(undefined);
      if (!pooledUrl) {
        await owner.query(`DROP OWNED BY ${role}`);
        await owner.query(`DROP ROLE ${role}`);
      }
      await owner.end();
    },
  };
}
