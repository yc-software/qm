import type { Config } from "../../src/config.ts";
import { buildApp as buildProductionApp, type BuiltApp } from "../../src/wiring.ts";
import { createMockHarness } from "./mock-harness.ts";
import { boundTenant } from "../../src/tenants/context.ts";

export function buildApp(config: Config, overrides: Parameters<typeof buildProductionApp>[1] = {}): BuiltApp {
  const built = buildProductionApp(
    { anthropicApiKey: "test-anthropic-key", ...config },
    { ...overrides, harnesses: { pi: createMockHarness(), ...overrides.harnesses } },
  );
  if (boundTenant()) void built.identity.hydrate().catch(() => {});
  return built;
}

export async function buildLoadedApp(
  config: Config,
  overrides: Parameters<typeof buildProductionApp>[1] = {},
): Promise<BuiltApp> {
  const built = buildApp(config, overrides);
  await built.identity.hydrate();
  return built;
}
