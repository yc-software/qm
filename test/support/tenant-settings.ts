import { randomBytes } from "node:crypto";
import pg from "pg";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { TENANCY_BASE, TENANT_SETTINGS_MIGRATION } from "../../src/tenants/migrations.ts";
import { withTenant } from "../../src/tenants/context.ts";
import {
  createTenantSettingsStore,
  type TenantSettingsStore,
  type TenantSettingsStoreOptions,
  type TenantSettingValues,
} from "../../src/tenants/settings.ts";
import { seedTenant, seedTestTenants } from "./tenant-seed.ts";

export const TEST_SETTINGS_KEY = "test-connector-key-distinct-from-ingress-auth";
export const THIRD_TENANT = "00000000-0000-4000-8000-000000000003";
export const FOURTH_TENANT = "00000000-0000-4000-8000-000000000004";
export const FIFTH_TENANT = "00000000-0000-4000-8000-000000000005";

export async function seedSettingsTenants(url: string): Promise<void> {
  for (const tenant of [THIRD_TENANT, FOURTH_TENANT, FIFTH_TENANT]) await seedTenant(url, tenant);
}

export async function migrateSettings(url: string): Promise<void> {
  const owner = createPgPool(url, [TENANCY_BASE, TENANT_SETTINGS_MIGRATION]);
  try {
    await owner.q("SELECT 1");
  } finally {
    await owner.close();
  }
}

export function settingsDatabase(): { url: string; ready: Promise<void> } {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("Set DATABASE_URL to the Postgres database the test runner gave this file");
  const schema = `settings_${randomBytes(8).toString("hex")}`;
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const ready = (async () => {
    const owner = new pg.Client({ connectionString: base });
    await owner.connect();
    try {
      await owner.query(`CREATE SCHEMA ${schema}`);
    } finally {
      await owner.end();
    }
    await migrateSettings(url.toString());
    await seedTestTenants(url.toString());
    await seedSettingsTenants(url.toString());
  })();
  return { url: url.toString(), ready };
}

export async function testSettingsStore(
  initial: Readonly<Record<string, TenantSettingValues>> = {},
  opts: Partial<TenantSettingsStoreOptions> = {},
): Promise<TenantSettingsStore> {
  const { url, ready } = settingsDatabase();
  await ready;
  const seed = createTenantSettingsStore({ db: createPgPool(url), keyMaterial: TEST_SETTINGS_KEY });
  for (const [tenant, values] of Object.entries(initial)) await withTenant(tenant, () => seed.update(values));
  return createTenantSettingsStore({ db: createPgPool(url), keyMaterial: TEST_SETTINGS_KEY, ...opts });
}
