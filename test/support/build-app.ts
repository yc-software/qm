import { after } from "node:test";
import type { Config } from "../../src/config.ts";
import type { Agent, ScreenSecurityInput } from "../../src/agent/agent.ts";
import { setProviderBaseUrls } from "../../src/model/provider-endpoints.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { withTenant } from "../../src/tenants/context.ts";
import {
  createTenantSettingsStore,
  type TenantSettingsStore,
  type TenantSettingValues,
} from "../../src/tenants/settings.ts";
import { buildApp as buildProductionApp, type BuiltApp } from "../../src/wiring.ts";
import { createMockAgent } from "./mock-agent.ts";
import { TEST_TENANT } from "./tenant.ts";
import { seedSettingsTenants } from "./tenant-settings.ts";
import { TEST_ADMIN_GRANTS, testMigratedDatabaseUrl } from "./test-database.ts";

export const TEST_TENANT_SETTINGS: TenantSettingValues = {
  SECURITY_SCREEN: "enforce",
  SANDBOX_BACKEND: "sprites",
  SPRITES_TOKEN: "test-token",
  ADMIN_GRANTS: TEST_ADMIN_GRANTS,
};

export function testTenantSettings(
  values: TenantSettingValues = {},
  databaseUrl: string = testMigratedDatabaseUrl(),
): TenantSettingsStore {
  const store = createTenantSettingsStore({
    db: createPgPool(databaseUrl),
    keyMaterial: "test-connector-key-distinct-from-ingress-auth",
    onLoad: (tenant, settings) => setProviderBaseUrls(tenant, settings.providerBaseUrls),
  });
  const seeded = seedSettingsTenants(databaseUrl).then(() =>
    withTenant(TEST_TENANT, () => store.update({ ...TEST_TENANT_SETTINGS, ...values })),
  );
  return {
    ...store,
    get: async () => {
      await seeded;
      return store.get();
    },
    update: async (changes) => {
      await seeded;
      return store.update(changes);
    },
  };
}

const built: BuiltApp[] = [];
after(() => Promise.all(built.splice(0).map((app) => app.runtime.stop())));

export function stopAtEnd(app: BuiltApp): BuiltApp {
  built.push(app);
  return app;
}

interface ModelCall {
  model: string;
  inputTokens: number;
  entryCount: number;
}

function recordingModelCalls(agent: Agent, calls: ModelCall[]): Agent {
  const tap = <T extends { recordModelCall(rec: ModelCall): void }>(input: T): T => ({
    ...input,
    recordModelCall: (rec: ModelCall) => {
      calls.push(rec);
      input.recordModelCall(rec);
    },
  });
  const { screenSecurity } = agent;
  return {
    ...agent,
    runTurn: (input) => agent.runTurn(tap(input)),
    ...(screenSecurity ? { screenSecurity: (input: ScreenSecurityInput) => screenSecurity(tap(input)) } : {}),
  };
}

export function buildApp(
  config: Config,
  overrides: Parameters<typeof buildProductionApp>[1] = {},
): BuiltApp & { modelCalls: ModelCall[] } {
  const modelCalls: ModelCall[] = [];
  const app = stopAtEnd(
    buildProductionApp(config, {
      agent: recordingModelCalls(createMockAgent(), modelCalls),
      ...overrides,
      tenantSettings: overrides.tenantSettings ?? testTenantSettings({}, config.databaseUrl),
    }),
  );
  return Object.assign(app, { modelCalls });
}
