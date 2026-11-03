import { after } from "node:test";
import type { Config } from "../../src/config.ts";
import type { Agent, ScreenSecurityInput } from "../../src/agent/agent.ts";
import { buildApp as buildProductionApp, type BuiltApp } from "../../src/wiring.ts";
import { createMockAgent } from "./mock-agent.ts";

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
    buildProductionApp(
      { anthropicApiKey: "test-anthropic-key", ...config },
      { agent: recordingModelCalls(createMockAgent(), modelCalls), ...overrides },
    ),
  );
  const { runtime } = app;
  const { start, startBackground } = runtime;
  let testStartedWorkers = false;
  let waiting = 0;
  runtime.setBackgroundAdmission(
    () => !config.backgroundDeploymentId && (testStartedWorkers || waiting > 0),
    () => false,
  );
  runtime.start = () => {
    testStartedWorkers = true;
    start();
  };
  runtime.startBackground = () => {
    testStartedWorkers = true;
    startBackground();
  };
  const turn = app.app.turn.bind(app.app);
  app.app.turn = async (req, replay) => {
    if (req.async) return turn(req, replay);
    waiting++;
    start();
    try {
      return await turn(req, replay);
    } finally {
      waiting--;
    }
  };
  return Object.assign(app, { modelCalls });
}
