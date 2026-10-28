import { type TeamStore } from "./teams/teams.ts";
import { type DecisionStore } from "./decisions/store.ts";
import { type KeychainApprovals } from "./credentials/keychain-approval.ts";
import { flushErrorReporting } from "../plugins/chassis/src/error-reporting.ts";
import { createAdmittedWork } from "./util/admitted-work.ts";
import { runSessionSmoke } from "./deployment/postdeploy-smoke.ts";
import { type BackgroundOwnershipControl } from "./runs/background-ownership.ts";
import { createSuggestedActivityService } from "./suggestions/activities.ts";
import { type BrokerSessionStore } from "./auth/broker-sessions.ts";
import { type DirectFileUploads } from "./files/direct-file-upload.ts";
import { type SandboxResources } from "./sandbox/sandbox-resources.ts";
import { type AwsRoleBroker } from "./auth/aws-role-broker.ts";
import type { SessionShareStore } from "./sessions/session-share.ts";
import { companySubscriptionAuth, configuredModel, providerKeysPresent, type Config } from "./config.ts";
import type { ServerDeps } from "./api/deps.ts";
import type { ManagedSlack } from "./surfaces/slack-managed.ts";
import { tenantConfig } from "./tenants/tenant-config.ts";
import { isHomeTenant } from "./tenants/directory.ts";
import { tenant } from "./tenant.ts";
import { type IdentityService } from "./identity/identity-service.ts";
import { type PrincipalLinkService } from "./identity/principal-links.ts";
import type { ComposioReturns, SlackAccounts } from "./connectors/composio-links.ts";
import { resendMailer } from "../plugins/chassis/src/resend.ts";
import { type ScopedConfigStore } from "./resolution/config-store.ts";
import { type AclStore } from "./acl/acl-store.ts";
import { type SkillStore } from "./skills/skill-store.ts";
import { type SkillBundleStore } from "./skills/skill-bundle-store.ts";
import { type SkillPackFetcher } from "./skills/pack-fetcher.ts";
import type { UiStateStore } from "./surfaces/ui-state.ts";
import { slackUserClientFactory } from "./inbox/sources/slack.ts";
import { type AdvisoryLock } from "./persistence/advisory-lock.ts";
import type { AuditLog } from "./audit/audit-log.ts";
import { type AppPageViewLog } from "./deploy/page-views.ts";
import type { RateLimiter } from "./ratelimit/rate-limiter.ts";
import { type BudgetTracker } from "./ratelimit/budget.ts";
import type { SecurityScreenProbe } from "./security/security-screener.ts";
import { type CronStore } from "./cron/cron-store.ts";
import { type LedgerEventBus } from "./inbox/events.ts";
import { createInboxSourceRefresh } from "./inbox/source-refresh.ts";
import type { InboxServiceDeps } from "./api/routes/cron-items.ts";
import { type Outbound } from "./surfaces/outbound.ts";
import type { DirectoryStore } from "./directory/directory-store.ts";
import { type EnvironmentStore } from "./environments/environment-store.ts";
import { type Scheduler } from "./cron/scheduler.ts";
import { type JobWorker } from "./jobs/job-worker.ts";
import { type WebhookReceiver } from "./webhooks/webhook-receiver.ts";
import { type WorkspaceStore } from "./workspace/workspace-store.ts";
import type { MemoryService } from "./memory/memory-service.ts";
import { type McpServerStore } from "./mcp/mcp-server-store.ts";
import { type McpToolService } from "./mcp/mcp-tool-service.ts";
import { type BlobTransferStore } from "./persistence/blob-transfer.ts";
import { type DurableByteStore } from "./files/durable-byte-store.ts";
import type { FileArtifactStore } from "./files/file-artifact-store.ts";
import { effectiveEgressEnforcement, type Sandbox } from "./sandbox/sandbox.ts";
import {
  type ConnectorTokenStore,
  type Keychain,
  type KeychainAsk,
  type KeychainGrant,
  type ServiceCredentialStore,
} from "./credentials/keychain.ts";
import { type DropResolution } from "./triggers/keychain-ask.ts";
import { type SecretDropStore } from "./credentials/secret-drop.ts";
import { type FeatureFlagStore } from "./feature-flags.ts";
import { type OAuthClientResolver } from "./connectors/oauth.ts";
import { type BrowserSessionStore } from "./connectors/browser-session-store.ts";
import type { CredentialUsageSink } from "./admin/credential-usage-sink.ts";
import type { EgressAuditSink } from "./admin/egress-audit-sink.ts";
import { type ConsentLinkStore } from "./connectors/consent-link.ts";
import { type OAuthFlowStore } from "./connectors/oauth-flow-store.ts";
import { type ModelGateway } from "./model/model-gateway.ts";
import { type ModelCredentialStore } from "./model/model-credential-store.ts";
import { type UserModelCredentialStore } from "./model/user-model-credential-store.ts";
import type { ModelGatewayTransportConfig } from "./model/provider-endpoints.ts";
import { type CustomProviderStore } from "./model/custom-provider-store.ts";
import { type SessionStore } from "./sessions/session-store.ts";
import { type ProviderKeys } from "./harness/pi-model-runtime.ts";
import type { Harness } from "./harness/harness.ts";
import { type SecurityScreener } from "./security/security-screener.ts";
import { type RunSignalStore } from "./runs/run-signal-store.ts";
import { type RunStore } from "./runs/run-store.ts";
import { type TurnLedger } from "./turns/turn-ledger.ts";
import { type ProcessRegistry } from "./processes/process-registry.ts";
import { type MonitorStore } from "./monitors/monitor-store.ts";
import { type SessionStateBus } from "./runs/session-state-bus.ts";
import { type App } from "./api/app.ts";
import { type SlackCoreClient } from "./api/slack-core-client.ts";
import { type SurfaceRegistry } from "./surfaces/registry.ts";
import { type SurfaceCache } from "./surface-cache/surface-cache.ts";
import { type ChannelPolicyStore } from "./surface-cache/channel-policy-store.ts";
import { type AmbientJudgmentStore } from "./surface-cache/ambient-judgment-store.ts";
import { type AckEmojiPickStore } from "./surface-cache/ack-emoji-pick-store.ts";
import { type AdminService } from "./admin/admin-service.ts";
import { type ProjectStore } from "./projects/project-store.ts";
import { type ErrorLog } from "./admin/error-log.ts";
import { type ReplayDedupe } from "./auth/replay-dedupe.ts";
import { type BrokeredLayerTool, type DeploymentLayerRuntime } from "./deployment/load-layer.ts";
import { type DeploymentLayerStore } from "./deployment/deployment-layer-store.ts";
import { errMessage } from "./util/errors.ts";
import { sleep } from "./util/async.ts";
import { type SlackInstallationStore } from "./surfaces/slack-installation.ts";

import type { Gates, Late } from "./wiring/late.ts";

import { buildStores } from "./wiring/stores.ts";

import { buildDeploymentLayer } from "./wiring/deployment-layer.ts";

import { buildFiles } from "./wiring/files.ts";

import { buildSandbox } from "./wiring/sandbox.ts";

import { buildCredentials } from "./wiring/credentials.ts";

import { buildHarness } from "./wiring/harness.ts";

import { buildMemory } from "./wiring/memory.ts";

import { buildRuns } from "./wiring/runs.ts";

import { buildOutbound } from "./wiring/outbound.ts";

import { buildDeploy } from "./wiring/deploy.ts";

import { registerLegacyMigrations } from "./wiring/legacy-migrations.ts";

import { buildCrons } from "./wiring/crons.ts";

import { buildOrchestrator } from "./wiring/orchestrator.ts";

import { buildApiApp } from "./wiring/api-app.ts";

import { buildSlackCore } from "./wiring/slack-core.ts";

import { buildSessionReturns } from "./wiring/session-returns.ts";

import { buildScheduler } from "./wiring/scheduler.ts";

import { buildReceivers } from "./wiring/receivers.ts";

import { buildWorkers } from "./wiring/workers.ts";

import { buildBackground } from "./wiring/background.ts";

import { assembleBuiltApp } from "./wiring/built-app.ts";

export interface Runtime {
  start(): void;
  startTurns(): void;
  startBackground(): void;
  stopBackgroundClaims(): Promise<void>;
  setBackgroundAdmission(canClaim: () => boolean, active: () => boolean): void;
  stopBackground(): Promise<void>;
  backgroundDrained(): Promise<void>;
  stop(): Promise<void>;
  releaseInFlightRuns(): Promise<void>;
}

export function stopWithBackstop(
  runtime: Pick<Runtime, "stop" | "releaseInFlightRuns">,
  shutdownDrainMs: number,
  label: string,
  beforeExit?: () => void,
): void {
  const hardExit = setTimeout(() => {
    console.error(`[${label}] drain overran; releasing in-flight leases before forced exit`);
    void Promise.race([runtime.releaseInFlightRuns(), sleep(3_000, { unref: true })]).finally(async () => {
      await flushErrorReporting();
      process.exit();
    });
  }, shutdownDrainMs + 5_000);
  hardExit.unref();
  void runtime.stop().then(
    async () => {
      await flushErrorReporting();
      clearTimeout(hardExit);
      beforeExit?.();
      process.exit();
    },
    (e: unknown) => {
      console.error(`[${label}] graceful stop failed: ${errMessage(e)}`);
      clearTimeout(hardExit);
      void Promise.race([runtime.releaseInFlightRuns(), sleep(3_000, { unref: true })]).finally(async () => {
        await flushErrorReporting();
        process.exit(1);
      });
    },
  );
}

export interface BuiltApp {
  checkReadiness: (signal: AbortSignal) => Promise<void>;
  start: () => Promise<void>;
  backgroundOwnership?: BackgroundOwnershipControl;
  suggestedActivities?: ReturnType<typeof createSuggestedActivityService>;
  app: App;
  screenSecurity?: SecurityScreenProbe;
  deploymentLayer: DeploymentLayerRuntime;
  brokeredTools: readonly BrokeredLayerTool[];
  deploymentLayerStore: DeploymentLayerStore;
  sessions: SessionStore;
  runs: RunStore;
  turnLedger: TurnLedger;
  signals: RunSignalStore;
  sessionStateBus: SessionStateBus;
  ledgerEventBus: LedgerEventBus;
  surfaceCache: SurfaceCache;
  runtime: Runtime;
  config: ScopedConfigStore;
  connectorTokens: ConnectorTokenStore;
  slackInstallation: SlackInstallationStore;
  resolveClient: OAuthClientResolver;
  consentLinks: ConsentLinkStore;
  oauthFlows: OAuthFlowStore;
  secretDrops: SecretDropStore;
  modelGatewayTransport?: ModelGatewayTransportConfig;
  resolveBrowserCompanyKeys: (includeSubscription?: boolean) => Promise<ProviderKeys>;
  modelGateway: ModelGateway;
  modelCredentials: ModelCredentialStore;
  userModelCredentials: UserModelCredentialStore;
  refreshModels: () => Promise<void>;
  customProviders: CustomProviderStore;
  mcpServers: McpServerStore;
  mcpToolService: McpToolService;
  acl: AclStore;
  skills: SkillStore;
  skillBundles: SkillBundleStore;
  skillFetcher: SkillPackFetcher;
  auditLog: AuditLog;
  scheduler: Scheduler;
  sweepAsks(now: number): Promise<void>;
  inbox: InboxServiceDeps;
  webhookReceiver: WebhookReceiver;
  jobs: JobWorker;
  admin: AdminService;
  rateLimiter: RateLimiter;
  budget?: BudgetTracker;
  errors: ErrorLog;
  crons: CronStore;
  credentialUsage: CredentialUsageSink;
  egressAudit: EgressAuditSink;
  identity: IdentityService;
  principalLinks: PrincipalLinkService;
  slackAccounts: SlackAccounts;
  composioReturns: ComposioReturns;
  keychain: Keychain;
  serviceCreds: ServiceCredentialStore;
  outbound: Outbound;
  keychainApprovals: KeychainApprovals;
  fireAskResolution: (ask: KeychainAsk, grant?: KeychainGrant) => Promise<unknown>;
  fireDropResolution: (drop: DropResolution) => Promise<unknown>;
  workspace: WorkspaceStore;
  memory: MemoryService;
  sandbox: Sandbox;
  advisoryLock: AdvisoryLock;
  sandboxResources: SandboxResources;
  blobTransfer: BlobTransferStore;
  files: FileArtifactStore;
  fileUploads?: DirectFileUploads;
  featureFlags: FeatureFlagStore;
  teams: TeamStore;
  decisions: DecisionStore;
  replayDedupe: ReplayDedupe;
  brokerSessions: BrokerSessionStore;
  directory: DirectoryStore;
  projects: ProjectStore;
  environments: EnvironmentStore;
  processes?: ProcessRegistry;
  appPageViews?: AppPageViewLog;
  monitors: MonitorStore;
  browserSessionStore: BrowserSessionStore;
  ambientJudgments: AmbientJudgmentStore;
  ackEmojiPicks: AckEmojiPickStore;
  channelPolicy: ChannelPolicyStore;
  uiState: UiStateStore;
  sessionShares: SessionShareStore;
  sessionShareBytes: DurableByteStore;
  slackCore: SlackCoreClient;
  chatSurfaces: SurfaceRegistry;
}

export interface AppOverrides {
  securityScreener?: SecurityScreener;
  credentialBrokers?: Record<string, AwsRoleBroker>;
  modelCredentialFetch?: typeof fetch;
  harness?: Harness;
  env?: NodeJS.ProcessEnv;
}

function lifecycleState(config: Config) {
  const gates: Gates = {
    backgroundAdmission: () => !config.backgroundDeploymentId,
    backgroundActive: () => false,
    inlineShutdown: new AbortController(),
  };
  const admittedWork = createAdmittedWork({
    canStart: () => !config.backgroundDeploymentId || gates.backgroundAdmission(),
  });
  return { gates, admittedWork, late: {} as Late };
}

export function buildApp(config: Config, overrides: AppOverrides = {}): BuiltApp {
  const { gates, admittedWork, late } = lifecycleState(config);
  const databaseUrl = config.databaseUrl;
  if (!databaseUrl) throw new Error("DATABASE_URL is required: QM keeps all state in Postgres");
  const connectorSecretKey = config.connectorSecretKey;
  if (!connectorSecretKey) throw new Error("CONNECTOR_SECRET_KEY is required");
  const stores = buildStores({ databaseUrl, config, connectorSecretKey, admittedWork });
  const files = buildFiles({ config, stores });
  const deploymentLayer = buildDeploymentLayer({ config, stores });
  const sandbox = buildSandbox({ config, late, stores, files, deploymentLayer });
  const credentials = buildCredentials({ overrides, config, connectorSecretKey, stores, files, deploymentLayer });
  const harness = buildHarness({ config, overrides, connectorSecretKey, stores, credentials, deploymentLayer });
  const memory = buildMemory({ late, config, stores, harness, files });
  const runs = buildRuns({ config, late, stores, files, sandbox });
  const outbound = buildOutbound({ config, late, stores, runs });
  const deploy = buildDeploy({ config, stores, files, sandbox, outbound, runs, deploymentLayer, credentials });
  const crons = buildCrons({ late, config, overrides, runs, stores, outbound });
  registerLegacyMigrations({ stores });
  const orchestrator = buildOrchestrator({
    late,
    config,
    overrides,
    stores,
    outbound,
    deploymentLayer,
    runs,
    harness,
    files,
    credentials,
    sandbox,
    memory,
    deploy,
    crons,
  });
  const apiApp = buildApiApp({
    late,
    config,
    admittedWork,
    gates,
    overrides,
    connectorSecretKey,
    stores,
    harness,
    runs,
    outbound,
    crons,
    credentials,
    deploymentLayer,
    orchestrator,
    files,
    deploy,
    sandbox,
  });
  const slackCore = buildSlackCore({
    config,
    crons,
    credentials,
    apiApp,
    stores,
    deploymentLayer,
    outbound,
    memory,
    orchestrator,
    runs,
    harness,
    files,
  });
  buildSessionReturns({ runs, apiApp, stores, orchestrator, outbound, harness, credentials });
  const scheduler = buildScheduler({
    late,
    admittedWork,
    config,
    overrides,
    memory,
    crons,
    stores,
    apiApp,
    orchestrator,
    harness,
  });
  const receivers = buildReceivers({ admittedWork, sandbox, runs, credentials, crons, apiApp, stores });
  const workers = buildWorkers({ config, gates, late, stores, runs, orchestrator, files, sandbox, receivers });
  const background = buildBackground({
    admittedWork,
    gates,
    config,
    workers,
    stores,
    memory,
    files,
    runs,
    harness,
    deploymentLayer,
  });
  return assembleBuiltApp({
    config,
    apiApp,
    stores,
    orchestrator,
    deploymentLayer,
    credentials,
    runs,
    harness,
    background,
    files,
    scheduler,
    receivers,
    crons,
    workers,
    memory,
    outbound,
    slackCore,
    sandbox,
  });
}

export function serverDeps(
  config: Config,
  built: BuiltApp,
  slackEnvironmentState: "absent" | "configured" | "partial" = "absent",
  slackEnvBotToken?: string,
  managedSlack?: () => ManagedSlack | undefined,
): Omit<ServerDeps, "control"> {
  const deploymentModel = configuredModel(config);
  const subscriptionAuth = companySubscriptionAuth(config);
  const perRequest = tenantServerDeps(config, built, { slackEnvironmentState, slackEnvBotToken, managedSlack });
  return Object.defineProperties(
    {
      modelGatewayTransport: built.modelGatewayTransport,
      resolveBrowserCompanyKeys: built.resolveBrowserCompanyKeys,
      production: config.production,
      checkReadiness: built.checkReadiness,
      ...(built.backgroundOwnership
        ? {
            backgroundOwnership: built.backgroundOwnership,
            deploymentControlSecret: config.deploymentControlSecret,
            deploymentLiveSmoke: () => runSessionSmoke(config, `http://127.0.0.1:${config.port}`),
          }
        : {}),
      ...(config.spendExportToken ? { spendExportToken: config.spendExportToken } : {}),
      capabilityTokenCompression: config.capabilityTokenCompression,
      ...(config.requireSignedPortalIdentity ? { requireSignedPortalIdentity: true } : {}),
      replayDedupe: built.replayDedupe,
      brokerSessions: built.brokerSessions,
      config: built.config,
      ...(built.screenSecurity ? { screenSecurity: built.screenSecurity } : {}),
      ...(deploymentModel ? { baseModelDefault: deploymentModel } : {}),
      providerKeys: providerKeysPresent(config),
      modelCredentials: built.modelCredentials,
      userModelCredentials: built.userModelCredentials,
      refreshModels: built.refreshModels,
      customProviders: built.customProviders,
      mcpServers: built.mcpServers,
      mcpToolService: built.mcpToolService,
      ...(subscriptionAuth ? { companySubscriptionAuth: subscriptionAuth } : {}),
      connectorTokens: built.connectorTokens,
      slackInstallation: built.slackInstallation,
      slackEvents: built.slackCore.slack.events,
      chatSurfaces: built.chatSurfaces,
      resolveClient: built.resolveClient,
      consentLinks: built.consentLinks,
      oauthFlows: built.oauthFlows,
      secretDrops: built.secretDrops,
      fireDropResolution: built.fireDropResolution,
      admin: built.admin,
      ...(config.resendApiKey && config.emailFrom
        ? { inviteMailer: resendMailer(config.resendApiKey, config.emailFrom) }
        : {}),
      rateLimiter: built.rateLimiter,
      ...(built.budget ? { budget: built.budget } : {}),
      acl: built.acl,
      credentialUsage: built.credentialUsage,
      featureFlags: built.featureFlags,
      decisions: built.decisions,
      teams: built.teams,
      egressAudit: built.egressAudit,
      sessions: built.sessions,
      auditLog: built.auditLog,
      errors: built.errors,
      crons: built.crons,
      inbox: built.inbox,
      deploymentLayer: built.deploymentLayerStore,
      ...(config.awsDeploy.gateSecret ? { deployGateSecret: config.awsDeploy.gateSecret } : {}),
      ...(built.appPageViews ? { appPageViews: built.appPageViews } : {}),
      scheduler: built.scheduler,
      webhookReceiver: built.webhookReceiver,
      identity: built.identity,
      principalLinks: built.principalLinks,
      slackAccounts: built.slackAccounts,
      composioReturns: built.composioReturns,
      keychain: built.keychain,
      serviceCreds: built.serviceCreds,
      outbound: built.outbound,
      keychainApprovals: built.keychainApprovals,
      runs: built.runs,
      signals: built.signals,
      sessionStateBus: built.sessionStateBus,
      workspace: built.workspace,
      files: built.files,
      ...(built.fileUploads ? { fileUploads: built.fileUploads } : {}),
      memory: built.memory,
      blobTransfer: built.blobTransfer,
      sandboxBackend: built.sandbox.profile.backend,
      egressDeclaredEnforcement: built.sandbox.profile.egressEnforcement ?? "none",
      sandbox: built.sandbox,
      advisoryLock: built.advisoryLock,
      ...(built.processes ? { processes: built.processes } : {}),
      browserSessionStore: built.browserSessionStore,
      directory: built.directory,
      ambientJudgments: built.ambientJudgments,
      ackEmojiPicks: built.ackEmojiPicks,
      channelPolicy: built.channelPolicy,
      ...(built.suggestedActivities ? { suggestedActivities: built.suggestedActivities } : {}),
      uiState: built.uiState,
      inboxSourceTokens: built.keychain,
      inboxSourceRefresh: createInboxSourceRefresh({
        featureFlags: built.featureFlags,
        items: built.inbox.items,
        errors: built.errors,
        record: built.inbox.record,
        tokens: built.keychain,
        directory: built.directory,
        ...(config.slack?.apiUrl ? { slackApiUrl: config.slack.apiUrl } : {}),
      }),
      inboxSlackClient: slackUserClientFactory(config.slack?.apiUrl),
      sessionShares: built.sessionShares,
      sessionShareBytes: built.sessionShareBytes,
      environments: built.environments,
      sandboxResources: built.sandboxResources,
    } satisfies Omit<ServerDeps, "control" | keyof typeof perRequest>,
    Object.getOwnPropertyDescriptors(perRequest),
  ) as Omit<ServerDeps, "control">;
}

function tenantServerDeps(
  config: Config,
  built: BuiltApp,
  slack: {
    slackEnvironmentState: "absent" | "configured" | "partial";
    slackEnvBotToken?: string;
    managedSlack?: () => ManagedSlack | undefined;
  },
) {
  const current = () => tenantConfig(config);
  return {
    get slackEnvironmentState() {
      return isHomeTenant(tenant()) ? slack.slackEnvironmentState : "absent";
    },
    get slackEnvBotToken() {
      return isHomeTenant(tenant()) ? slack.slackEnvBotToken : undefined;
    },
    get externalSlackPolicies() {
      return current().externalSlackPolicies;
    },
    get managedSlack() {
      return slack.managedSlack?.();
    },
    get signingSecret() {
      return current().signingSecret;
    },
    get capabilitySecret() {
      return current().capabilitySecret;
    },
    get portalIdentitySecret() {
      return current().portalIdentitySecret;
    },
    get brandingDefault() {
      return current().brandingDefault;
    },
    get apiBaseUrl() {
      return current().apiBaseUrl;
    },
    get publicUrl() {
      return current().publicUrl;
    },
    get portalUrl() {
      return current().publicWebUrl;
    },
    get emailAuthPrincipals() {
      return current().emailAuthPrincipals;
    },
    get emailAuthDomain() {
      return current().emailAuthDomain;
    },
    get slackAllowFrom() {
      const slack = current().slack;
      return slack ? (slack.allowFrom ?? []) : undefined;
    },
    get deployAppsDomain() {
      return current().awsDeploy.appsDomain;
    },
    get deployAppsSessionSecret() {
      return current().deployAppsSessionSecret;
    },
    get deployAppsLoginUrl() {
      return current().deployAppsLoginUrl;
    },
    get deployAppsLoginPath() {
      return current().deployAppsLoginPath;
    },
    get egressEnforcement() {
      return effectiveEgressEnforcement(built.sandbox.profile, current());
    },
    get egressControlPlaneConfigured() {
      return Boolean(current().signingSecret && current().apiBaseUrl);
    },
  } satisfies Partial<ServerDeps>;
}
