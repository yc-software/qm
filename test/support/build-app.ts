import { after, afterEach, beforeEach } from "node:test";
import type { Config } from "../../src/config.ts";
import type { Agent, ScreenSecurityInput } from "../../src/agent/agent.ts";
import { buildApp as buildProductionApp, type Core } from "../../src/wiring.ts";
import { createMockAgent } from "./mock-agent.ts";

const built: Core[] = [];
const runningTests = new Map<object, Core[]>();
const isTopLevel = (t: { name: string; fullName: string }) => t.fullName === t.name;
beforeEach((t) => {
  if (isTopLevel(t)) runningTests.set(t, []);
});
afterEach(async (t) => {
  const apps = runningTests.get(t);
  runningTests.delete(t);
  await Promise.all((apps ?? []).map((app) => app.runtime.stop()));
});
after(() => Promise.all(built.splice(0).map((app) => app.runtime.stop())));

const none = async () => undefined;
const empty = async () => [];

const absentServices = {
  identity: {
    refresh: none,
    classify: (id: string) => ({ id, type: "internal" }),
    isInternal: (p: { type: string }) => p.type === "internal",
    deactivationSource: () => undefined,
  },
  auditLog: { record: () => {} },
  credentialUsage: { record: () => {} },
  featureFlags: { enabled: async () => false },
  mcpServers: { list: empty },
  mcpToolService: { appConnections: empty },
  loopIngress: { list: empty },
  slackInstallation: { get: none },
  slackAccounts: { get: none },
  connectorTokens: { connectorDerivedAuth: none },
} as unknown as Partial<Core>;

export function testCore(core = {} as Core): Core {
  return {
    ...absentServices,
    ...core,
    signingSecret: undefined,
    capabilitySecret: undefined,
    portalIdentitySecret: undefined,
    requireSignedPortalIdentity: undefined,
    spendExportToken: undefined,
    deploymentControlSecret: undefined,
    deploymentLiveSmoke: undefined,
    portalUrl: undefined,
    publicUrl: undefined,
    apiBaseUrl: undefined,
    brandingDefault: undefined,
    companySubscriptionAuth: undefined,
    emailAuthPrincipals: undefined,
    emailAuthDomain: undefined,
    slackAllowFrom: undefined,
    deployGateSecret: undefined,
    deployAppsSessionSecret: undefined,
    deployAppsLoginUrl: undefined,
    deployAppsLoginPath: undefined,
  };
}

export function stopAtEnd(app: Core): Core {
  const [owner, ...others] = runningTests.values();
  (owner && !others.length ? owner : built).push(app);
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
): Core & { modelCalls: ModelCall[] } {
  const modelCalls: ModelCall[] = [];
  let testStartedWorkers = false;
  let waiting = 0;
  const app = stopAtEnd(
    buildProductionApp(
      { anthropicApiKey: "test-anthropic-key", ...config },
      {
        agent: recordingModelCalls(createMockAgent(), modelCalls),
        canClaimRuns: () => testStartedWorkers || waiting > 0,
        ...overrides,
      },
    ),
  );
  const { runtime } = app;
  const { start, stop } = runtime;
  let stopped = false;
  runtime.start = (services) => {
    testStartedWorkers = true;
    if (!stopped) start(services);
  };
  runtime.stop = () => {
    stopped = true;
    return stop();
  };
  const turn = app.app.turn.bind(app.app);
  app.app.turn = async (req, replay) => {
    if (req.async) return turn(req, replay);
    waiting++;
    if (!stopped) start();
    try {
      return await turn(req, replay);
    } finally {
      waiting--;
    }
  };
  return Object.assign(app, { modelCalls });
}
