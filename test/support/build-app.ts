import type { Config } from "../../src/config.ts";
import { enterTenant } from "../../src/tenants/context.ts";
import {
  createTenantSettingsStore,
  type TenantSettingsStore,
  type TenantSettingValues,
} from "../../src/tenants/settings.ts";
import { setProviderBaseUrls } from "../../src/model/provider-endpoints.ts";
import { buildApp as buildProductionApp, type BuiltApp } from "../../src/wiring.ts";
import { createMockHarness } from "./mock-harness.ts";
import { bindTestTenant, TEST_TENANT } from "./tenant.ts";

bindTestTenant();

export { TEST_TENANT };

export const TEST_TENANT_SETTINGS: TenantSettingValues = {
  SECURITY_SCREEN: "enforce",
  SANDBOX_BACKEND: "sprites",
  SPRITES_TOKEN: "test-token",
};

export function testTenantSettings(values: TenantSettingValues = {}, harness = "pi"): TenantSettingsStore {
  return createTenantSettingsStore({
    harness,
    initial: { [TEST_TENANT]: { ...TEST_TENANT_SETTINGS, ...values } },
    onLoad: (tenant, settings) => setProviderBaseUrls(tenant, settings.providerBaseUrls),
  });
}

export function buildApp(config: Config, overrides: Parameters<typeof buildProductionApp>[1] = {}): BuiltApp {
  enterTenant(TEST_TENANT);
  return buildProductionApp(config, {
    tenantSettings: testTenantSettings({}, config.harness),
    ...overrides,
    harnesses: { pi: createMockHarness(), ...overrides.harnesses },
  });
}
