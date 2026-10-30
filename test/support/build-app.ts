import type { Config } from "../../src/config.ts";
import type { Agent, CompactInput, DetectInput, ScreenSecurityInput } from "../../src/agent/agent.ts";
import { buildApp as buildProductionApp, type BuiltApp } from "../../src/wiring.ts";
import { createMockAgent } from "./mock-agent.ts";

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
  const { shouldRespond, compactHistory, screenSecurity } = agent;
  return {
    ...agent,
    runTurn: (input) => agent.runTurn(tap(input)),
    ...(shouldRespond ? { shouldRespond: (input: DetectInput) => shouldRespond(tap(input)) } : {}),
    ...(compactHistory ? { compactHistory: (input: CompactInput) => compactHistory(tap(input)) } : {}),
    ...(screenSecurity ? { screenSecurity: (input: ScreenSecurityInput) => screenSecurity(tap(input)) } : {}),
  };
}

export function buildApp(
  config: Config,
  overrides: Parameters<typeof buildProductionApp>[1] = {},
): BuiltApp & { modelCalls: ModelCall[] } {
  const modelCalls: ModelCall[] = [];
  const built = buildProductionApp(
    { anthropicApiKey: "test-anthropic-key", ...config },
    { agent: recordingModelCalls(createMockAgent(), modelCalls), ...overrides },
  );
  return Object.assign(built, { modelCalls });
}
