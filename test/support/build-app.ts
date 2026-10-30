import { after } from "node:test";
import type { Config } from "../../src/config.ts";
import type { Agent, ScreenSecurityInput } from "../../src/agent/agent.ts";
import { setProviderBaseUrls } from "../../src/model/provider-endpoints.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { withTenant } from "../../src/tenants/context.ts";
import {
  createTenantSettingsStore,
  TenantSettingsNotLoadedError,
  type TenantSettingsStore,
  type TenantSettingValues,
} from "../../src/tenants/settings.ts";
import { buildApp as buildProductionApp, type BuiltApp } from "./compose.ts";
import { createMockAgent } from "./mock-agent.ts";
import { TEST_TENANT } from "./tenant.ts";
import { seedSettingsTenants, settingsDatabase } from "./tenant-settings.ts";
import { TEST_ADMIN_GRANTS } from "./test-database.ts";

export const TEST_TENANT_SETTINGS: TenantSettingValues = {
  SECURITY_SCREEN: "enforce",
  SANDBOX_BACKEND: "sprites",
  SPRITES_TOKEN: "test-token",
  ADMIN_GRANTS: TEST_ADMIN_GRANTS,
};

export function testTenantSettings(values: TenantSettingValues = {}, databaseUrl?: string): TenantSettingsStore {
  const target = databaseUrl ? { url: databaseUrl, ready: seedSettingsTenants(databaseUrl) } : settingsDatabase();
  const store = createTenantSettingsStore({
    db: createPgPool(target.url),
    keyMaterial: "test-connector-key-distinct-from-ingress-auth",
    onLoad: (tenant, settings) => setProviderBaseUrls(tenant, settings.providerBaseUrls),
  });
  let seededOk = false;
  let stopped = false;
  const seeded = target.ready
    .then(() => withTenant(TEST_TENANT, () => store.update({ ...TEST_TENANT_SETTINGS, ...values })))
    .then(() => {
      seededOk = true;
    });
  return {
    ...store,
    get: async () => {
      await seeded;
      return store.get();
    },
    peek: () => {
      if (!seededOk) throw new TenantSettingsNotLoadedError();
      return store.peek();
    },
    refreshAll: async () => {
      await seeded;
      return store.refreshAll();
    },
    start: () => {
      void seeded.then(
        () => stopped || store.start(),
        () => undefined,
      );
    },
    stop: () => {
      stopped = true;
      return store.stop();
    },
    tenantForSlug: async (slug) => {
      await seeded;
      return store.tenantForSlug(slug);
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
      tenantSettings: overrides.tenantSettings ?? testTenantSettings(),
    }),
  );
  return Object.assign(app, { modelCalls });
}

export async function buildLoadedApp(
  config: Config,
  overrides: Parameters<typeof buildProductionApp>[1] = {},
): Promise<BuiltApp & { modelCalls: ModelCall[] }> {
  const app = buildApp(config, overrides);
  await app.identity.ready();
  return app;
}
