import type { Config } from "../../src/config.ts";
import { buildApp as buildProductionApp, type BuiltApp } from "../../src/wiring.ts";
import { createMockHarness } from "./mock-harness.ts";
import { enterTenant } from "../../src/tenants/context.ts";
import { TEST_TENANT } from "./tenant.ts";

export function buildApp(config: Config, overrides: Parameters<typeof buildProductionApp>[1] = {}): BuiltApp {
  enterTenant(TEST_TENANT);
  return buildProductionApp(
    { anthropicApiKey: "test-anthropic-key", ...config },
    { ...overrides, harnesses: { pi: createMockHarness(), ...overrides.harnesses } },
  );
}
