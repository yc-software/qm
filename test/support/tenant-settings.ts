import { randomBytes } from "node:crypto";
import pg from "pg";
import { applyPgMigrations, definePgMigration } from "../../src/persistence/pg-pool.ts";
import { TENANCY_BASE, TENANT_SETTINGS_MIGRATION } from "../../src/tenants/migrations.ts";
import { withTenant } from "../../src/tenants/context.ts";
import {
  createTenantSettingsStore,
  type TenantSettingsStore,
  type TenantSettingsStoreOptions,
  type TenantSettingValues,
} from "../../src/tenants/settings.ts";
import { seedTestTenants } from "./tenant-seed.ts";
import { ownerUrlOf } from "./test-database.ts";

export const TEST_SETTINGS_KEY = "test-connector-key-distinct-from-ingress-auth";
export const THIRD_TENANT = "00000000-0000-4000-8000-000000000003";
export const FOURTH_TENANT = "00000000-0000-4000-8000-000000000004";
export const FIFTH_TENANT = "00000000-0000-4000-8000-000000000005";

export async function seedSettingsTenants(ownerUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  try {
    await pool.query("INSERT INTO tenants(id) SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING", [
      [THIRD_TENANT, FOURTH_TENANT, FIFTH_TENANT],
    ]);
  } finally {
    await pool.end();
  }
}

export async function migrateSettings(ownerUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  try {
    await applyPgMigrations(pool, [TENANCY_BASE, TENANT_SETTINGS_MIGRATION].map(definePgMigration));
  } finally {
    await pool.end();
  }
}

export function settingsDatabase(): { url: string; ready: Promise<void> } {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("Set DATABASE_URL to the Postgres database the test runner gave this file");
  const schema = `settings_${randomBytes(8).toString("hex")}`;
  const inSchema = (raw: string) => {
    const url = new URL(raw);
    url.searchParams.set("options", `-c search_path=${schema}`);
    return url.toString();
  };
  const ownerUrl = ownerUrlOf(base);
  const ready = (async () => {
    const owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    try {
      const app = decodeURIComponent(new URL(base).username);
      await owner.query(`CREATE SCHEMA ${schema}`);
      await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO "${app}"`);
      await owner.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${app}"`,
      );
      await owner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT EXECUTE ON FUNCTIONS TO "${app}"`);
    } finally {
      await owner.end();
    }
    await migrateSettings(inSchema(ownerUrl));
    await seedTestTenants(inSchema(ownerUrl));
    await seedSettingsTenants(inSchema(ownerUrl));
  })();
  return { url: inSchema(base), ready };
}

export async function testSettingsStore(
  initial: Readonly<Record<string, TenantSettingValues>> = {},
  opts: Partial<TenantSettingsStoreOptions> = {},
): Promise<TenantSettingsStore> {
  const { url, ready } = settingsDatabase();
  await ready;
  const seed = createTenantSettingsStore({ databaseUrl: url, keyMaterial: TEST_SETTINGS_KEY });
  for (const [tenant, values] of Object.entries(initial)) await withTenant(tenant, () => seed.update(values));
  return createTenantSettingsStore({ databaseUrl: url, keyMaterial: TEST_SETTINGS_KEY, ...opts });
}
