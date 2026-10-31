import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { withTenant } from "../../src/tenants/context.ts";
import {
  createTenantSettingsStore,
  type TenantSettingsStore,
  type TenantSettingsStoreOptions,
  type TenantSettingValues,
} from "../../src/tenants/settings.ts";
import { testMigratedDatabaseUrl } from "./test-database.ts";

export const TEST_SETTINGS_KEY = "test-connector-key-distinct-from-ingress-auth";

export async function testSettingsStore(
  initial: Readonly<Record<string, TenantSettingValues>> = {},
  opts: Partial<TenantSettingsStoreOptions> = {},
): Promise<TenantSettingsStore> {
  const url = testMigratedDatabaseUrl();
  const seed = createTenantSettingsStore({ db: createPgPool(url), keyMaterial: TEST_SETTINGS_KEY });
  for (const [tenant, values] of Object.entries(initial)) await withTenant(tenant, () => seed.update(values));
  return createTenantSettingsStore({ db: createPgPool(url), keyMaterial: TEST_SETTINGS_KEY, ...opts });
}
