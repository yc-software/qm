import type { Config } from "../../src/config.ts";
import { buildCore, type CoreOverrides } from "../../src/wiring.ts";
import { buildHarness, type HarnessOverrides } from "../../src/harness/build.ts";
import { buildEdge, serverDeps as edgeServerDeps } from "../../src/edge/build.ts";

export function buildApp(config: Config, overrides: CoreOverrides & HarnessOverrides = {}) {
  const core = buildCore(config, overrides);
  const harness = buildHarness(config, core, overrides);
  const edge = buildEdge(config, core);
  return {
    ...core,
    slackCore: edge.slackCore,
    ...(edge.keychainApprovals ? { keychainApprovals: edge.keychainApprovals } : {}),
    scheduler: harness.scheduler,
    orchestrator: harness.orchestrator,
    skillSyncEngine: harness.skillSyncEngine,
    ...(harness.monitorPoller ? { monitorPoller: harness.monitorPoller } : {}),
    runtime: harness.runtime,
  };
}

export type BuiltApp = ReturnType<typeof buildApp>;

export function serverDeps(
  config: Config,
  built: BuiltApp,
  slackEnvironmentState: "absent" | "configured" | "partial" = "absent",
  slackEnvBotToken?: string,
) {
  return { ...edgeServerDeps(config, built, built, slackEnvironmentState, slackEnvBotToken) };
}
