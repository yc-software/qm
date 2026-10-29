import type { Config } from "../../src/config.ts";
import { buildApp as buildProductionApp, type BuiltApp } from "../../src/wiring.ts";
import { createMockHarness } from "./mock-harness.ts";

export function buildApp(config: Config, overrides: Parameters<typeof buildProductionApp>[1] = {}): BuiltApp {
  return buildProductionApp(
    { anthropicApiKey: "test-anthropic-key", ...config },
    { harness: createMockHarness(), ...overrides },
  );
}
