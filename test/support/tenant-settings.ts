import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { withTenant } from "../../src/tenants/context.ts";
import {
  createTenantSettingsStore,
  type TenantSettingsStore,
  type TenantSettingsStoreOptions,
  type TenantSettingValues,
} from "../../src/tenants/settings.ts";
import { seedTenant } from "./tenant-seed.ts";
import { testMigratedDatabaseUrl } from "./test-database.ts";

export const TEST_SETTINGS_KEY = "test-connector-key-distinct-from-ingress-auth";
export const THIRD_TENANT = "00000000-0000-4000-8000-000000000003";
export const FOURTH_TENANT = "00000000-0000-4000-8000-000000000004";
export const FIFTH_TENANT = "00000000-0000-4000-8000-000000000005";

export async function seedSettingsTenants(url: string): Promise<void> {
  for (const tenant of [THIRD_TENANT, FOURTH_TENANT, FIFTH_TENANT]) await seedTenant(url, tenant);
}

export async function testSettingsStore(
  initial: Readonly<Record<string, TenantSettingValues>> = {},
  opts: Partial<TenantSettingsStoreOptions> = {},
): Promise<TenantSettingsStore> {
  const url = testMigratedDatabaseUrl();
  await seedSettingsTenants(url);
  const seed = createTenantSettingsStore({ db: createPgPool(url), keyMaterial: TEST_SETTINGS_KEY });
  for (const [tenant, values] of Object.entries(initial)) await withTenant(tenant, () => seed.update(values));
  return createTenantSettingsStore({ db: createPgPool(url), keyMaterial: TEST_SETTINGS_KEY, ...opts });
}
