import type { StoresModule } from "./stores.ts";
import type { HarnessModule } from "./harness.ts";
import type { RunsModule } from "./runs.ts";
import type { OutboundModule } from "./outbound.ts";
import type { CronsModule } from "./crons.ts";
import type { CredentialsModule } from "./credentials.ts";
import type { DeploymentLayerModule } from "./deployment-layer.ts";
import type { OrchestratorModule } from "./orchestrator.ts";
import type { FilesModule } from "./files.ts";
import type { DeployModule } from "./deploy.ts";
import type { SandboxModule } from "./sandbox.ts";
import { tenantConfig } from "../tenants/tenant-config.ts";
import { tenantSecretKey } from "../credentials/tenant-secret-key.ts";
import type { Head } from "./late.ts";
import { createAmbientCursors } from "../api/ambient-cursors.ts";
import { createContextRequests } from "../api/context-requests.ts";
import { createApp } from "../api/app.ts";
import { createPostgresResourceSearch } from "../search/resource-search.ts";
import { deriveConnectorKey } from "../connectors/connector-client-store.ts";
import { isTerminal } from "../runs/run-store.ts";
import { swallowAs } from "../util/errors.ts";
import { turnSource, type TurnRequest, type TurnResult } from "../types.ts";
import type { KeychainAsk, KeychainGrant } from "../credentials/keychain.ts";
import {
  fireAskResolution,
  type DropResolution,
  fireDropResolution,
  createAskExpirySweep,
} from "../triggers/keychain-ask.ts";
import type { InboxServiceDeps } from "../api/routes/cron-items.ts";
import { createInboxChat } from "../inbox/item-chat.ts";

type ApiAppInputs = Pick<Head, "late" | "config" | "admittedWork" | "gates" | "overrides" | "connectorSecretKey"> & {
  stores: StoresModule;
  harness: HarnessModule;
  runs: RunsModule;
  outbound: OutboundModule;
  crons: CronsModule;
  credentials: CredentialsModule;
  deploymentLayer: DeploymentLayerModule;
  orchestrator: OrchestratorModule;
  files: FilesModule;
  deploy: DeployModule;
  sandbox: SandboxModule;
};

export function buildApiApp(deps: ApiAppInputs) {
  const { late, config } = deps;
  const { every, identity, directory, currentScopeMembers, sessions, advisoryLock } = deps.stores;
  const { runSignals } = deps.harness;
  const { runs } = deps.runs;
  const { outbound, idempotency } = deps.outbound;
  const { crons, inboxItems, recordInboxEvent } = deps.crons;
  const { keychain } = deps.credentials;
  const { auditLog } = deps.deploymentLayer;

  const current = () => tenantConfig(deps.config);
  const viewerTokenKey = tenantSecretKey(() =>
    deriveConnectorKey(current().connectorSecretKey!, "context-viewer-tokens"),
  );
  const app = createApp({
    ...appDepsHead(deps),
    ...appDepsTail(deps),
    get externalSlackPolicies() {
      return current().externalSlackPolicies;
    },
    get publicWebUrl() {
      return current().publicWebUrl;
    },
    get emailAuthMembers() {
      return current().emailAuthPrincipals?.map((principalId) => ({
        principalId,
        displayName: principalId,
        type: "internal" as const,
      }));
    },
    get deployAppsDomain() {
      return current().awsDeploy.appsDomain;
    },
    contextViewerTokenKey: viewerTokenKey,
  });
  late.app = app;
  every("deploy-maintenance", 5 * 60_000, () => app.maintainDeployments());
  every("orphaned-signals", config.reaperIntervalMs, async () => {
    for (const runId of await runSignals.pendingRunIds()) {
      const run = await runs.get(runId);
      if (!run || isTerminal(run.status))
        await app.replayOrphanedRunSignals(runId).catch(swallowAs("sessions: recover signal", undefined));
    }
  });
  const resolveRecipient = (query: string) => app.resolveRecipient(query);
  const runTriggered = async (req: TurnRequest): Promise<TurnResult> => {
    const recorded = await runs.latestForThread(req.conversation.threadRef);
    const source =
      !turnSource(req) && (await sessions.getByThread(req.conversation.threadRef))?.surface === "slack" && recorded
        ? turnSource(recorded.request)
        : undefined;
    return app.turn(source ? { ...req, source } : req);
  };
  const triggerDeps = {
    outbound,
    idempotency,
    identity,
    run: runTriggered,
    directory,
    resolveRecipient,
    currentScopeMembers,
  };
  const askResolution = (ask: KeychainAsk, grant?: KeychainGrant) =>
    fireAskResolution(
      {
        ...triggerDeps,
        getCron: (id) => crons.get(id),
        getAsk: (id) => keychain.getAsk(id),
        getGrant: (id) => keychain.getGrant(id),
      },
      ask,
      grant,
    );
  const dropResolution = (drop: DropResolution) => fireDropResolution(triggerDeps, drop);
  const inbox: InboxServiceDeps = {
    lock: advisoryLock,
    items: inboxItems,
    record: recordInboxEvent,
    chat: createInboxChat({
      items: inboxItems,
      trigger: triggerDeps,
    }),
  };
  const sweepAsks = createAskExpirySweep({ keychain, fire: askResolution, auditLog });
  return { app, askResolution, triggerDeps, sweepAsks, inbox, dropResolution };
}

function appDepsHead(deps: ApiAppInputs) {
  const {
    teams,
    pgPool,
    identity,
    sessions,
    admin,
    skills,
    skillPacks,
    skillBundles,
    advisoryLock,
    configStore,
    directory,
    projects,
    environments,
  } = deps.stores;
  const { admittedWork, gates, late, overrides } = deps;
  const { orchestrator, skillFetcher } = deps.orchestrator;
  const { runs, maxAttempts, turnStream, runStreamEvents, runActivity } = deps.runs;
  const { runSignals, modelCredentials, refreshModels, customProviders, refreshCustomProviders } = deps.harness;
  const { modelGateway, userModelCredentials, mcpToolService } = deps.credentials;
  const { mcpServers, acl } = deps.files;
  const { auditLog } = deps.deploymentLayer;
  const { crons, webhooks } = deps.crons;
  const { outbound } = deps.outbound;
  return {
    teams,
    admittedWork,
    shutdown: () => gates.inlineShutdown.signal,
    resourceSearch: createPostgresResourceSearch(pgPool),
    identity,
    sessions,
    orchestrator,
    runs,
    startTurns: () => {
      if (!gates.inlineShutdown.signal.aborted) late.turnRunner.start();
    },
    maxAttempts,
    turnStream,
    runStreamEvents,
    runActivity,
    signals: runSignals,
    modelGateway,
    modelCredentials,
    userModelCredentials,
    refreshModels,
    customProviders,
    refreshCustomProviders,
    mcpServers,
    mcpToolService,
    ...(overrides.modelCredentialFetch ? { modelCredentialFetch: overrides.modelCredentialFetch } : {}),
    acl,
    admin,
    skills,
    skillPacks,
    skillFetcher,
    skillBundles,
    advisoryLock,
    auditLog,
    config: configStore,
    crons,
    webhooks,
    outbound,
    directory,
    projects,
    environments,
  } satisfies Partial<Parameters<typeof createApp>[0]>;
}

function appDepsTail(deps: ApiAppInputs) {
  const { config } = deps;
  const { deployService } = deps.deploy;
  const { deploymentLayer } = deps.deploymentLayer;
  const { processes, sessionStateBus, ledgerEventBus, contextRequestEvents } = deps.runs;
  const { monitors, approvals } = deps.crons;
  const { sandbox } = deps.sandbox;
  const { files } = deps.files;
  const { surfaceCache, channelPolicy, screenSecurity, ambientJudgments, ackEmojiPicks, providerKeys } =
    deps.orchestrator;
  const { harness, judgeModelId, fallback } = deps.harness;
  const { databaseUrl } = deps.stores;
  return {
    deploy: deployService,
    deploymentLayer,
    ...(processes ? { processes } : {}),
    monitors,
    sandbox,
    files,
    approvals,
    sessionStateBus,
    ledgerEventBus,
    contextRequests: createContextRequests(databaseUrl),
    contextRequestEvents,
    surfaceCache,
    channelPolicy,
    ...(harness.models.judge
      ? { ambientJudge: (s: string, pr: string, signal?: AbortSignal) => harness.models.judge!(s, pr, signal) }
      : {}),
    ...(screenSecurity ? { screenSecurity } : {}),
    ambientCursors: createAmbientCursors(databaseUrl),
    ambientJudgments,
    ackEmojiPicks,
    judgeModelId,
    runtimeFallback: fallback,
    providerKeys,
    runWaitMs: config.runWaitMs,
  } satisfies Partial<Parameters<typeof createApp>[0]>;
}

export type ApiAppModule = ReturnType<typeof buildApiApp>;
