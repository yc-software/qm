import type { ApiAppModule } from "./api-app.ts";
import type { StoresModule } from "./stores.ts";
import type { OrchestratorModule } from "./orchestrator.ts";
import type { DeploymentLayerModule } from "./deployment-layer.ts";
import type { CredentialsModule } from "./credentials.ts";
import type { RunsModule } from "./runs.ts";
import type { HarnessModule } from "./harness.ts";
import type { BackgroundModule } from "./background.ts";
import type { FilesModule } from "./files.ts";
import type { SchedulerModule } from "./scheduler.ts";
import type { ReceiversModule } from "./receivers.ts";
import type { CronsModule } from "./crons.ts";
import type { WorkersModule } from "./workers.ts";
import type { MemoryModule } from "./memory.ts";
import type { OutboundModule } from "./outbound.ts";
import type { SlackCoreModule } from "./slack-core.ts";
import type { SandboxModule } from "./sandbox.ts";
import type { Head } from "./late.ts";
import { createSlackAccounts } from "../connectors/composio-links.ts";
import type { BuiltApp } from "../wiring.ts";
import { createSessionShareStore } from "../sessions/session-share.ts";

type BuiltAppInputs = Pick<Head, "config"> & {
  apiApp: ApiAppModule;
  stores: StoresModule;
  orchestrator: OrchestratorModule;
  deploymentLayer: DeploymentLayerModule;
  credentials: CredentialsModule;
  runs: RunsModule;
  harness: HarnessModule;
  background: BackgroundModule;
  files: FilesModule;
  scheduler: SchedulerModule;
  receivers: ReceiversModule;
  crons: CronsModule;
  workers: WorkersModule;
  memory: MemoryModule;
  outbound: OutboundModule;
  slackCore: SlackCoreModule;
  sandbox: SandboxModule;
};

export function assembleBuiltApp(deps: BuiltAppInputs): BuiltApp {
  return { ...builtAppHead(deps), ...builtAppTail(deps) };
}

function builtAppHead(deps: BuiltAppInputs) {
  const { app, sweepAsks, inbox } = deps.apiApp;
  const { pgPool, sessions, configStore, slackInstallation, skills, skillBundles, jobs } = deps.stores;
  const { surfaceCache, skillFetcher } = deps.orchestrator;
  const { deploymentLayer, deploymentLayerStore, brokeredTools, auditLog } = deps.deploymentLayer;
  const {
    startOnce,
    connectorTokens,
    resolveClient,
    consentLinks,
    oauthFlows,
    secretDrops,
    modelGateway,
    userModelCredentials,
    mcpToolService,
  } = deps.credentials;
  const { runs, turnLedger, sessionStateBus, ledgerEventBus } = deps.runs;
  const {
    runSignals,
    gatewayTransport,
    resolveBrowserCompanyKeys,
    modelCredentials,
    refreshModels,
    customProviders,
    refreshCustomProviders,
  } = deps.harness;
  const { runtime } = deps.background;
  const { budget, mcpServers, acl } = deps.files;
  const { scheduler } = deps.scheduler;
  const { webhookReceiver } = deps.receivers;
  return {
    app,
    checkReadiness: async (signal) => {
      await pgPool.q("SELECT 1", [], { signal });
    },
    deploymentLayer,
    deploymentLayerStore,
    brokeredTools,
    start: () => startOnce().ready,
    sessions,
    runs,
    turnLedger,
    signals: runSignals,
    sessionStateBus,
    ledgerEventBus,
    surfaceCache,
    runtime,
    config: configStore,
    connectorTokens,
    slackInstallation,
    resolveClient,
    consentLinks,
    oauthFlows,
    secretDrops,
    modelGatewayTransport: gatewayTransport,
    ...(budget ? { budget } : {}),
    resolveBrowserCompanyKeys,
    modelGateway,
    modelCredentials,
    userModelCredentials,
    refreshModels,
    customProviders,
    refreshCustomProviders,
    mcpServers,
    mcpToolService,
    acl,
    skills,
    skillBundles,
    skillFetcher,
    auditLog,
    scheduler,
    sweepAsks,
    inbox,
    webhookReceiver,
    jobs,
  } satisfies Partial<BuiltApp>;
}

function builtAppTail(deps: BuiltAppInputs) {
  const {
    admin,
    identity,
    principalLinks,
    advisoryLock,
    featureFlags,
    teams,
    decisions,
    directory,
    projects,
    environments,
    databaseUrl,
  } = deps.stores;
  const { rateLimiter, errors, workspace, blobTransfer, files, fileUploads, byteStore } = deps.files;
  const { crons, monitors } = deps.crons;
  const { credentialUsage, egressAudit, replayDedupe, brokerSessions, processes, appPageViews } = deps.runs;
  const { composioReturns, backgroundOwnership } = deps.workers;
  const { memory } = deps.memory;
  const { keychain, serviceCreds, browserSessionStore } = deps.credentials;
  const { outbound, chatSurfaces } = deps.outbound;
  const { keychainApprovals, slackCore } = deps.slackCore;
  const { askResolution, dropResolution } = deps.apiApp;
  const { sandbox, sandboxResources } = deps.sandbox;
  const { ambientJudgments, ackEmojiPicks, channelPolicy, uiState } = deps.orchestrator;
  const { config } = deps;
  const { suggestedActivities } = deps.scheduler;
  return {
    admin,
    rateLimiter,
    errors,
    crons,
    credentialUsage,
    egressAudit,
    identity,
    principalLinks,
    slackAccounts: createSlackAccounts(databaseUrl),
    composioReturns,
    workspace,
    memory,
    keychain,
    serviceCreds,
    outbound,
    keychainApprovals,
    fireAskResolution: askResolution,
    fireDropResolution: dropResolution,
    sandbox,
    sandboxResources,
    advisoryLock,
    blobTransfer,
    files,
    ...(fileUploads ? { fileUploads } : {}),
    featureFlags,
    teams,
    decisions,
    replayDedupe,
    brokerSessions,
    directory,
    projects,
    environments,
    ...(processes ? { processes } : {}),
    ...(appPageViews ? { appPageViews } : {}),
    monitors,
    browserSessionStore,
    ambientJudgments,
    ackEmojiPicks,
    channelPolicy,
    ...(config.suggestedActivitiesEnabled && (config.backgroundWorkEnabled || config.backgroundDeploymentId)
      ? { suggestedActivities }
      : {}),
    ...(backgroundOwnership ? { backgroundOwnership } : {}),
    uiState,
    sessionShares: createSessionShareStore(databaseUrl),
    sessionShareBytes: byteStore("session-shares/", "session-shares"),
    slackCore,
    chatSurfaces,
  } satisfies Partial<BuiltApp>;
}
