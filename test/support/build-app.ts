import { after } from "node:test";
import type { Config } from "../../src/config.ts";
import { buildApp as buildProductionApp, type BuiltApp } from "../../src/wiring.ts";
import { createMockHarness } from "./mock-harness.ts";

const built: BuiltApp[] = [];
after(() => Promise.all(built.splice(0).map((app) => app.runtime.stop())));

export function stopAtEnd(app: BuiltApp): BuiltApp {
  built.push(app);
  return app;
}

export function buildApp(config: Config, overrides: Parameters<typeof buildProductionApp>[1] = {}): BuiltApp {
  const app = buildProductionApp(
    { anthropicApiKey: "test-anthropic-key", ...config },
    { harness: createMockHarness(), ...overrides },
  );
  void app.start().catch(() => {}); // start() reports its own failures
  void app.jobs.start().catch(() => {}); // on-demand cron fires and sweeps run as background jobs, as in production
  return stopAtEnd(app);
}
