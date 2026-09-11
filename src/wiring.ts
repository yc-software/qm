import { createRuntimeService } from "./harness/runtime-control.ts";
import { createPostgresBrokerSessions, type BrokerSessionStore } from "./auth/broker-sessions.ts";
import { createDirectFileUploads, type DirectFileUploads } from "./files/direct-file-upload.ts";
import { createPostgresFileUploadStore } from "./files/file-upload-store.ts";
import {
  createSandboxResources,
  type SandboxResource,
  type SandboxDefault,
  type SandboxResources,
  type SandboxResourceRollout,
} from "./sandbox/sandbox-resources.ts";
import { createModelVerifier, type ModelVerifier } from "./model/model-verification.ts";
import type { probeModel } from "./harness/pi-harness.ts";
import { createAwsRoleBroker, type AwsRoleBroker } from "./auth/aws-role-broker.ts";
import type { SessionShare, SessionShareStore } from "./sessions/session-share.ts";
import { createModelOverlayStore, type ModelOverlayStore } from "./model/model-overlay-store.ts";
import { mkdirSync } from "node:fs";
import type { StagedEnvelope } from "./slack/envelope-staging.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  baseModelProviders,
  configuredModelForHarness,
  enabledSandboxBackends,
  harnessCarriedModelAuth,
  providerKeysPresent,
  type Config,
} from "./config.ts";
import type { ServerDeps } from "./api/deps.ts";
import {
  actorAssertionActive,
  createIdentityService,
  type DeactivationRecord,
  type IdentityService,
} from "./identity/identity-service.ts";
import type { ExternalMember } from "./identity/external-members.ts";
import { createResendMailer } from "./admin/invite-email.ts";
import {
  createMemoryConfigStore,
  type ScopedConfigStore,
  type PersistedSoul,
  type PersistedSoulRevision,
  type PersistedCommandPolicy,
  type PersistedSecurityPosture,
  type PersistedSharingPosture,
  type PersistedApprovalGrantModes,
  type PersistedEgressPolicy,
  type PersistedScopedFlag,
  type PersistedBaseModel,
  type PersistedApprovedHarnesses,
  type PersistedInternalMemberOverrides,
  type PersistedWebuiModels,
  type PersistedPeopleDirectoryUrl,
  type PersistedAckEmoji,
  type PersistedSlackEmojiCatalog,
  type PersistedBranding,
  type PersistedBrowseMaxSteps,
  type PersistedBrowseModel,
  type PersistedAutoFlaggerConfig,
  type PersistedTurnWallClock,
  type PersistedDeploymentIdentity,
} from "./resolution/config-store.ts";
import { createResolutionService } from "./resolution/resolution-service.ts";
import { createAclStore, type AclStore } from "./acl/acl-store.ts";
import { createPostgresGrantStore } from "./acl/postgres-grant-store.ts";
import { createSkillStore, type SkillStore, type Skill } from "./skills/skill-store.ts";
import { createSkillPackStore, type SkillPack } from "./skills/skill-pack-store.ts";
import { createSkillBundleStore, type SkillBundle, type SkillBundleStore } from "./skills/skill-bundle-store.ts";
import { createGitFetcher, resolvePackAuth, type SkillPackFetcher } from "./skills/pack-fetcher.ts";
import { installSeedSkills } from "./skills/seed.ts";
import { createMemoryMap, createPostgresMapFactory, type DurableMap } from "./persistence/durable-map.ts";
import type { PersistedUiState, UiStateStore } from "./surfaces/ui-state.ts";
import { slackUserClientFactory } from "./loops/sources/slack.ts";
import { configurePgCaTrust, configurePgPooling } from "./persistence/pg-pool.ts";
import { createPostgresLeaderLease, createNoopLeaderLease, type LeaderLease } from "./persistence/leader-lease.ts";
import {
  createMemoryAdvisoryLock,
  createPostgresAdvisoryLock,
  type AdvisoryLock,
} from "./persistence/advisory-lock.ts";
import type {
  CommandApprovalGrant,
  Cron,
  Loop,
  LoopItem,
  LoopOutput,
  Monitor,
  ShipGrant,
  PendingApprovalRecord,
  ScopeId,
  SurfaceContextRequest,
  Webhook,
} from "./types.ts";
import { personalScope, scopeId } from "./types.ts";
import { createAuditLog, type AuditLog } from "./audit/audit-log.ts";
import { createPostgresAuditLog } from "./admin/postgres-audit-log.ts";
import { createRateLimiter, type RateLimiter } from "./ratelimit/rate-limiter.ts";
import { createPostgresRateLimiter } from "./ratelimit/postgres-rate-limiter.ts";
import { createBudgetTracker, estimateCostUsd } from "./ratelimit/budget.ts";
import type { SecurityScreenProbe } from "./security/security-screener.ts";
import { createPostgresBudgetTracker } from "./ratelimit/postgres-budget.ts";
import { createCronStore, type CronStore } from "./cron/cron-store.ts";
import { createMemoryCronFireStore, createPostgresCronFireStore } from "./cron/fire-store.ts";
import { createLoopStore } from "./loops/loop-store.ts";
import { createLoopItemLedger } from "./loops/item-ledger.ts";
import {
  createMemoryLedgerEventBus,
  createPostgresLedgerEventBus,
  type LedgerEventBus,
} from "./loops/ledger-events.ts";
import { createInboxRealtime } from "./loops/inbox-realtime.ts";
import { createLoopOutputStore } from "./loops/output-store.ts";
import { createShipGrantStore } from "./loops/ship-grant-store.ts";
import { createLoopFireService, type LoopFireService } from "./loops/loop-fire.ts";
import type { LoopServiceDeps } from "./api/routes/loops.ts";
import { createDeliveryStore, type DeliveryStore } from "./delivery/delivery-store.ts";
import { createPostgresDeliveryStore } from "./delivery/postgres-delivery-store.ts";
import { wireRunResultDeliveries } from "./delivery/run-result-delivery.ts";
import { adminSessionUrl } from "./util/admin-links.ts";
import { withWebTranscriptDeliveries } from "./delivery/web-transcript-delivery.ts";
import { createDirectoryStore, type DirectoryStore } from "./directory/directory-store.ts";
import { createPostgresDirectoryStore } from "./directory/postgres-directory-store.ts";
import {
  createMemoryEnvironmentStore,
  createPostgresEnvironmentStore,
  type EnvironmentStore,
} from "./environments/environment-store.ts";
import { createIdempotencyStore, type IdempotencyRecord } from "./idempotency/idempotency-store.ts";
import { createScheduler, type Scheduler } from "./cron/scheduler.ts";
import { createPgBossCronQueue } from "./cron/job-queue.ts";
import { createWebhookStore } from "./webhooks/webhook-store.ts";
import { createWebhookReceiver, type WebhookReceiver } from "./webhooks/webhook-receiver.ts";
import { createDeployStore, deployTouchDebounceMs, type Deployment } from "./deploy/deploy-store.ts";
import { viewerIdentityKey } from "./deploy/access-token.ts";
import { deploymentCredentialSlugs } from "./deploy/deployment-credentials.ts";
import { createDockerDeployProvider } from "./deploy/docker-deploy-provider.ts";
import { createAwsDeployProvider, type StoredDeployBody } from "./deploy/aws-deploy-provider.ts";
import { createFlyDeployProvider } from "./deploy/fly-deploy-provider.ts";
import { createPorterDeployProvider, type StoredPorterDeployBody } from "./deploy/porter-deploy-provider.ts";
import type { DeployProvider } from "./deploy/deploy-provider.ts";
import { createDeployService } from "./deploy/deploy-service.ts";
import {
  createCanReadScope,
  createCanManageScope,
  createCanWriteScope,
  createCurrentScopeMembers,
  createIsCurrentSharedScopeMember,
  createManagesArtifactHome,
  type CanReadScope,
  type CanManageScope,
  type ManagesArtifactHome,
} from "./resolution/scope-membership.ts";
import type { DeployGitArchive } from "./deploy/deploy-git-store.ts";
import { createLocalWorkspaceStore, type WorkspaceStore } from "./workspace/workspace-store.ts";
import { createMemoryService, type MemoryService } from "./memory/memory-service.ts";
import { createConfiguredMemoryService } from "./memory/provider-factory.ts";
import { createPostgresMemoryService } from "./memory/postgres-memory-service.ts";
import { createMcpServerStore, type McpServer, type McpServerStore } from "./mcp/mcp-server-store.ts";
import { createMcpToolService, type McpToolService } from "./mcp/mcp-tool-service.ts";
import {
  createLocalBlobTransferStore,
  createS3BlobTransferStore,
  type BlobTransferStore,
} from "./persistence/blob-transfer.ts";
import {
  createLocalDurableByteStore,
  createS3DurableByteStore,
  type DurableByteStore,
} from "./files/durable-byte-store.ts";
import { createMemoryFileArtifactStore, type FileArtifactStore } from "./files/file-artifact-store.ts";
import { createPostgresFileArtifactStore } from "./files/postgres-file-artifact-store.ts";
import { createAwsSandbox, type StoredMicrovm } from "./sandbox/aws-sandbox.ts";
import { createKubernetesSandbox } from "./sandbox/kubernetes-sandbox.ts";
import { createLocalSandbox } from "./sandbox/local-sandbox.ts";
import { createSpritesSandbox } from "./sandbox/sprites-sandbox.ts";
import { createSmolmachinesSandbox } from "./sandbox/smolmachines-sandbox.ts";
import { createAgent37Sandbox } from "./sandbox/agent37-sandbox.ts";
import { createE2bSandbox, type StoredE2bSandbox } from "./sandbox/e2b-sandbox.ts";
import { createSdkE2bClient } from "./sandbox/e2b-client.ts";
import { createS3SnapshotStore } from "./sandbox/home-snapshot.ts";
import { createModalSandbox, type StoredModalSandbox } from "./sandbox/modal-sandbox.ts";
import { createSdkModalClient } from "./sandbox/modal-client.ts";
import { createPorterSandbox } from "./sandbox/porter-sandbox.ts";
import {
  createSandboxRouter,
  ROUTE_CACHE_TTL_MS,
  type SandboxBackendName,
  type SandboxRoute,
} from "./sandbox/sandbox-routing.ts";
import { createSandboxMigrationRunner, type SandboxMigrationRunner } from "./sandbox/sandbox-migration-runner.ts";
import { effectiveEgressEnforcement, type Sandbox } from "./sandbox/sandbox.ts";
import { withOperatorTokenFallback } from "./credentials/connector-token.ts";
import {
  createAwsSecretsManagerSource,
  createEnvSecretSource,
  createLayeredSecretSource,
} from "./credentials/secret-source.ts";
import {
  createKeychain,
  type ConnectorTokenStore,
  type OAuthToken,
  type Keychain,
  type KeychainAsk,
  type KeychainCredential,
  type KeychainGrant,
  type ServiceCredentialStore,
} from "./credentials/keychain.ts";
import {
  fireAskResolution,
  fireDropResolution,
  createAskExpirySweep,
  type DropResolution,
} from "./triggers/keychain-ask.ts";
import { createSecretDropStore, type SecretDropStore, type SecretDropRecord } from "./credentials/secret-drop.ts";
import { createLivenessCache, type LivenessCache, type ScopeLivenessRecord } from "./credentials/resident-auth.ts";
import { createConnectorStatusCache, type ConnectorStatusRecord } from "./credentials/connector-status.ts";
import {
  createDeviceFlowCutoverStore,
  type DeviceFlowCutoverPolicy,
  type DeviceFlowCutoverReset,
  type DeviceFlowCutoverStore,
} from "./credentials/device-flow-cutover.ts";
import { createFeatureFlagStore, type FeatureFlagRecord, type FeatureFlagStore } from "./feature-flags.ts";
import { makeRefresh, type OAuthClientResolver, type OAuthState } from "./connectors/oauth.ts";
import {
  createConnectorClientResolver,
  deriveConnectorKey,
  type SecretKey,
  type StoredConnectorClient,
} from "./connectors/connector-client-store.ts";
import {
  createBrowserSessionStore,
  type BrowserSessionStore,
  type StoredBrowserSession,
} from "./connectors/browser-session-store.ts";
import { createCredentialUsageSink, type CredentialUsageSink } from "./admin/credential-usage-sink.ts";
import { createPostgresCredentialUsageSink } from "./admin/postgres-credential-usage-sink.ts";
import { createEgressAuditSink, type EgressAuditSink } from "./admin/egress-audit-sink.ts";
import { createPostgresEgressAuditSink } from "./admin/postgres-egress-audit-sink.ts";
import { createConsentLinkStore, type ConsentLinkStore, type ConsentLinkRecord } from "./connectors/consent-link.ts";
import { createOAuthFlowStore, type OAuthFlowStore } from "./connectors/oauth-flow-store.ts";
import { createModelGateway, type ModelGateway } from "./model/model-gateway.ts";
import { createModelCredentialStore, type ModelCredentialStore } from "./model/model-credential-store.ts";
import { refreshChatGPTTokens, refreshClaudeTokens } from "./model/subscription-oauth.ts";
import { createUserModelCredentialStore, type UserModelCredentialStore } from "./model/user-model-credential-store.ts";
import { setProviderBaseUrls } from "./model/provider-endpoints.ts";
import { setCustomProviders } from "./model/custom-providers.ts";
import { createCustomProviderStore, type CustomProviderStore } from "./model/custom-provider-store.ts";
import { createMemorySessionStore } from "./sessions/memory-session-store.ts";
import { createPostgresSessionStore } from "./sessions/postgres-session-store.ts";
import type { SessionStore } from "./sessions/session-store.ts";
import { createMockHarness } from "./harness/mock-harness.ts";
import { createOpenCodeHarness, openCodeHarnessConfigOptions } from "./harness/opencode-harness.ts";
import { createCodexHarness, codexHarnessConfigOptions } from "./harness/codex-harness.ts";
import { keychainCodexAuthStore } from "./harness/codex-auth-store.ts";
import { keychainHarnessAuthEnv } from "./credentials/harness-auth-env.ts";
import { createClaudeHarness, claudeHarnessConfigOptions } from "./harness/claude-harness.ts";
import { createPiHarness, piHarnessConfigOptions } from "./harness/pi-harness.ts";
import { createHarnessRouter, resolveRuntimeChoiceDurable } from "./harness/harness-router.ts";
import { selectableModelCatalog } from "./model/model-catalog.ts";
import type { Harness } from "./harness/harness.ts";
import { createSecurityScreenProxy, type SecurityScreener } from "./security/security-screener.ts";
import { createMemoryTaskStore } from "./tasks/memory-task-store.ts";
import { createPostgresTaskStore } from "./tasks/postgres-task-store.ts";
import type { TaskStore } from "./tasks/task-store.ts";
import { createMemoryStrategy } from "./memory/strategy.ts";
import { createOrchestrator, egressClaimAllowingControlPlane, type OrchestratorDeps } from "./core/orchestrator.ts";
import {
  mintCapabilityToken,
  CAPABILITY_TTL_MS,
  CREDENTIAL_BROKER_AUD,
  DEPLOYMENT_CREDENTIAL_TTL_MS,
  EGRESS_PROXY_AUD,
} from "./auth/capability-token.ts";
import { createControlService } from "./api/control-service.ts";
import { createMemoryRunStore } from "./runs/memory-run-store.ts";
import { createPostgresRunStore } from "./runs/postgres-run-store.ts";
import { createMemoryRunSignalStore, type RunSignalStore } from "./runs/run-signal-store.ts";
import { createPostgresRunSignalStore } from "./runs/postgres-run-signal-store.ts";
import { isTerminal, type RunStore } from "./runs/run-store.ts";
import { createWorker, type Worker } from "./runs/worker.ts";
import {
  createNoopInstanceRegistry,
  createPostgresInstanceRegistry,
  type InstanceRegistry,
} from "./runs/instance-registry.ts";
import { createEcsTaskProtection, type TaskProtection } from "./runs/task-protection.ts";
import { createDrainController, type DrainController } from "./runs/drain.ts";
import { createReaper, REAPER_LEASE_KEY, type Reaper } from "./runs/reaper.ts";
import { createSweeper, type Sweeper } from "./util/sweeper.ts";
import {
  createMemoryProcessRegistry,
  createPostgresProcessRegistry,
  type ProcessRegistry,
} from "./processes/process-registry.ts";
import { createProcessReaper, createReaperKillHook, type ProcessReaper } from "./processes/process-reaper.ts";
import { createMonitorStore, type MonitorStore } from "./monitors/monitor-store.ts";
import { createMonitorPoller, type MonitorPoller } from "./monitors/monitor-poller.ts";
import { createSkillSyncEngine, type SkillSyncEngine } from "./skills/skill-sync-engine.ts";
import { supportsProcessSessions } from "./sandbox/sandbox.ts";
import { createTurnStream } from "./runs/turn-stream.ts";
import { createMemorySessionStateBus, type SessionStateBus } from "./runs/session-state-bus.ts";
import { createPostgresSessionStateBus } from "./runs/postgres-session-state-bus.ts";
import { createMemoryRunActivityStore, type RunActivityStore } from "./runs/run-activity-store.ts";
import { createPostgresRunActivityStore } from "./runs/postgres-run-activity-store.ts";
import { createApp, type App } from "./api/app.ts";
import { createSlackCoreClient, type SlackAgentRequestContext, type SlackCoreClient } from "./api/slack-core-client.ts";
import { createSurfaceContextPuller } from "./api/surface-context-puller.ts";
import { createEngagedRegistry } from "./wake/engaged-registry.ts";
import { createWakeSweep, type WakeSweep } from "./wake/sweep.ts";
import {
  createMemorySurfaceCache,
  createPostgresSurfaceCache,
  type SurfaceCache,
} from "./surface-cache/surface-cache.ts";
import {
  createMemoryChannelPolicyStore,
  createPostgresChannelPolicyStore,
  type ChannelPolicyStore,
} from "./surface-cache/channel-policy-store.ts";
import {
  createMemoryAmbientJudgmentStore,
  createPostgresAmbientJudgmentStore,
  type AmbientJudgmentStore,
} from "./surface-cache/ambient-judgment-store.ts";
import {
  createMemoryAckEmojiPickStore,
  createPostgresAckEmojiPickStore,
  type AckEmojiPickStore,
} from "./surface-cache/ack-emoji-pick-store.ts";
import {
  auxiliaryModelFor,
  auxiliaryModelForProvider,
  defaultModelForHarness,
  modelProviderAvailabilityFor,
  resolveModel,
  type HarnessId,
  modelSupportedByHarness,
} from "./model/pi-models.ts";
import { createAdminService, bootAdminGrantSeed, type AdminService } from "./admin/admin-service.ts";
import { createAdminGrantStore, createMapAdminGrantPersistence, type AdminGrant } from "./admin/admin-grant-store.ts";
import { createPostgresAdminGrantStore } from "./admin/postgres-admin-grant-store.ts";
import { createProjectStore, type Project, type ProjectStore } from "./projects/project-store.ts";
import { createErrorLog, type ErrorLog } from "./admin/error-log.ts";
import { createMemoryReplayDedupe, createPostgresReplayDedupe, type ReplayDedupe } from "./auth/replay-dedupe.ts";
import {
  emptyDeploymentLayer,
  loadDeploymentLayer,
  type LayerCredentialTool,
  type BrokeredLayerTool,
  type DeploymentLayerRuntime,
} from "./deployment/load-layer.ts";
import {
  createDeploymentLayerStore,
  LAYER_CREATED_BY,
  LAYER_REVIEWER,
  type DeploymentLayerStore,
  type StoredDeploymentLayer,
} from "./deployment/deployment-layer-store.ts";
import { createPostgresErrorLog } from "./admin/postgres-error-log.ts";
import { createMetricsSink, type MetricsSink } from "./admin/metrics-sink.ts";
import { createPostgresMetricsSink } from "./admin/postgres-metrics-sink.ts";
import { errMessage, swallowAs } from "./util/errors.ts";
import { sleep } from "./util/async.ts";
import { createSlackInstallationStore, type SlackInstallationStore } from "./surfaces/slack-installation.ts";

export interface Runtime {
  start(): void;
  stop(): Promise<void>;
  releaseInFlightRuns(): Promise<void>;
}

export function stopWithBackstop(
  runtime: Runtime,
  shutdownDrainMs: number,
  label: string,
  beforeExit?: () => void,
): void {
  const hardExit = setTimeout(() => {
    console.error(`[${label}] drain overran; releasing in-flight leases before forced exit`);
    void Promise.race([runtime.releaseInFlightRuns(), sleep(3_000, { unref: true })]).finally(() => process.exit(0));
  }, shutdownDrainMs + 5_000);
  hardExit.unref();
  void runtime.stop().then(
    () => {
      clearTimeout(hardExit);
      beforeExit?.();
      process.exit(0);
    },
    (e: unknown) => {
      console.error(`[${label}] graceful stop failed: ${errMessage(e)}`);
      clearTimeout(hardExit);
      void Promise.race([runtime.releaseInFlightRuns(), sleep(3_000, { unref: true })]).finally(() => process.exit(1));
    },
  );
}

export interface BuiltApp {
  app: App;
  screenSecurity?: SecurityScreenProbe;
  deploymentLayer: DeploymentLayerRuntime;
  credentialTools: readonly LayerCredentialTool[];
  brokeredTools: readonly BrokeredLayerTool[];
  deploymentLayerStore: DeploymentLayerStore;
  deploymentLayerReady: Promise<unknown>;
  deploymentLayerRefresh: Sweeper;
  sessions: SessionStore;
  runs: RunStore;
  signals: RunSignalStore;
  tasks: TaskStore;
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
  modelGateway: ModelGateway;
  modelCredentials: ModelCredentialStore;
  userModelCredentials: UserModelCredentialStore;
  modelRegistry: ModelOverlayStore;
  modelVerifier: ModelVerifier;
  refreshModels: () => Promise<void>;
  customProviders: CustomProviderStore;
  refreshCustomProviders: () => Promise<void>;
  mcpServers: McpServerStore;
  mcpToolService: McpToolService;
  acl: AclStore;
  skills: SkillStore;
  skillBundles: SkillBundleStore;
  skillFetcher: SkillPackFetcher;
  auditLog: AuditLog;
  scheduler: Scheduler;
  loops: LoopServiceDeps;
  webhookReceiver: WebhookReceiver;
  admin: AdminService;
  rateLimiter: RateLimiter;
  errors: ErrorLog;
  metrics: MetricsSink;
  crons: CronStore;
  credentialUsage: CredentialUsageSink;
  egressAudit: EgressAuditSink;
  identity: IdentityService;
  keychain?: Keychain;
  serviceCreds: ServiceCredentialStore;
  deliveries: DeliveryStore;
  fireAskResolution?: (ask: KeychainAsk, grant?: KeychainGrant) => Promise<unknown>;
  fireDropResolution?: (drop: DropResolution) => Promise<unknown>;
  workspace: WorkspaceStore;
  memory: MemoryService;
  sandbox: Sandbox;
  advisoryLock: AdvisoryLock;
  sandboxMigration: SandboxMigrationRunner;
  sandboxResources: SandboxResources;
  blobTransfer: BlobTransferStore;
  files: FileArtifactStore;
  fileUploads?: DirectFileUploads;
  livenessCache: LivenessCache;
  deviceFlowCutover: DeviceFlowCutoverStore;
  featureFlags: FeatureFlagStore;
  replayDedupe?: ReplayDedupe;
  brokerSessions?: BrokerSessionStore;
  directory: DirectoryStore;
  projects: ProjectStore;
  environments: EnvironmentStore;
  processes?: ProcessRegistry;
  monitors: MonitorStore;
  browserSessionStore?: BrowserSessionStore;
  monitorPoller?: MonitorPoller;
  ambientJudgments?: AmbientJudgmentStore;
  ackEmojiPicks?: AckEmojiPickStore;
  channelPolicy: ChannelPolicyStore;
  uiState: UiStateStore;
  sessionShares: SessionShareStore;
  sessionShareBytes: DurableByteStore;
  skillSyncEngine: SkillSyncEngine;
  slackCore: SlackCoreClient;
}

const MEMORY_CAPTURE_ENTRY_WINDOW = 2_000;

export function buildApp(
  config: Config,
  overrides: {
    securityScreener?: SecurityScreener;
    credentialBrokers?: Record<string, AwsRoleBroker>;
    modelCredentialFetch?: typeof fetch;
    modelVerificationProbe?: typeof probeModel;
  } = {},
): BuiltApp {
  if (config.databaseUrl && !config.connectorSecretKey) {
    throw new Error("CONNECTOR_SECRET_KEY is required with durable storage");
  }
  configurePgPooling({
    ...(config.databaseUrl ? { databaseUrl: config.databaseUrl } : {}),
    ...(config.databasePoolUrl ? { poolUrl: config.databasePoolUrl } : {}),
    ...(config.databasePoolCaCert ? { caCert: config.databasePoolCaCert } : {}),
    ...(config.databasePoolMax !== undefined ? { queryMax: config.databasePoolMax } : {}),
    ...(config.databaseDirectPoolMax !== undefined ? { sessionMax: config.databaseDirectPoolMax } : {}),
  });
  configurePgCaTrust({
    ...(config.databaseCaCert ? { cert: config.databaseCaCert } : {}),
    ...(config.databaseCaCertFile ? { certFile: config.databaseCaCertFile } : {}),
  });
  const reusedConnectorKey = [
    ["CORE_SIGNING_SECRET", config.signingSecret],
    ["CAPABILITY_SECRET", config.capabilitySecret],
    ["PORTAL_IDENTITY_SECRET", config.portalIdentitySecret],
  ].find(([, value]) => config.connectorSecretKey && config.connectorSecretKey === value)?.[0];
  if (reusedConnectorKey) {
    throw new Error(`CONNECTOR_SECRET_KEY must differ from ${reusedConnectorKey}`);
  }
  mkdirSync(config.dataDir, { recursive: true });

  const membership: {
    canReadScope?: CanReadScope;
    canManageScope?: CanManageScope;
    canUseSandboxScope?: CanManageScope;
    managesArtifactHome?: ManagesArtifactHome;
  } = {};
  const acl = createAclStore(config.databaseUrl ? createPostgresGrantStore(config.databaseUrl) : undefined, {
    manages: (principalId, scopeId, authoredBy) =>
      membership.managesArtifactHome!(scopeId, authoredBy ?? "", principalId),
  });
  const pgArtifactMap = config.databaseUrl ? createPostgresMapFactory(config.databaseUrl) : null;
  const artifactMap = <T>(table: string): DurableMap<T> =>
    pgArtifactMap ? pgArtifactMap.map<T>(table) : createMemoryMap<T>();
  setProviderBaseUrls(config.providerBaseUrls);
  const unknownGatewayModels = Object.keys(config.modelGateway?.models ?? {}).filter((id) => !resolveModel(id));
  if (unknownGatewayModels.length) {
    throw new Error(`MODEL_GATEWAY_MODELS contains unsupported models: ${unknownGatewayModels.join(", ")}`);
  }
  const gatewayModels = config.modelGateway?.models ?? {};
  const directProviderAvailability = providerKeysPresent(config);
  const directModelCredentials = createModelCredentialStore({
    backing: artifactMap("model_credentials"),
    keyMaterial: config.connectorSecretKey ?? randomBytes(32),
    fallback: {
      ...(config.anthropicApiKey ? { anthropic: config.anthropicApiKey } : {}),
      ...(config.openaiApiKey ? { openai: config.openaiApiKey } : {}),
      ...(config.openrouterApiKey ? { openrouter: config.openrouterApiKey } : {}),
    },
  });
  const modelCredentials: ModelCredentialStore = {
    ...directModelCredentials,
    async availability() {
      const direct = await directModelCredentials.availability();
      return {
        ...direct,
        modelIds: new Set(Object.keys(gatewayModels)),
      };
    },
  };
  const identity = createIdentityService(artifactMap<DeactivationRecord>("deactivated_principals"), {
    isOverridden: (id) => configStore.getInternalMemberOverrides().includes(id.trim().toLowerCase()),
    directorySyncProtected: config.emailAuthPrincipals,
    externalMembers: artifactMap<ExternalMember>("external_members"),
  });
  void identity.hydrate();
  const leaderLease: LeaderLease = pgArtifactMap
    ? createPostgresLeaderLease(pgArtifactMap.pool)
    : createNoopLeaderLease();
  const advisoryLock: AdvisoryLock = pgArtifactMap
    ? createPostgresAdvisoryLock(pgArtifactMap.pool)
    : createMemoryAdvisoryLock();
  const configStore = createMemoryConfigStore(config.orgId, {
    connectorClients: artifactMap<StoredConnectorClient>("connector_clients"),
    souls: artifactMap<PersistedSoul>("soul_configs"),
    soulHistory: artifactMap<PersistedSoulRevision>("soul_history"),
    commandPolicies: artifactMap<PersistedCommandPolicy>("command_policies"),
    securityPostures: artifactMap<PersistedSecurityPosture>("security_postures"),
    sharingPostures: artifactMap<PersistedSharingPosture>("sharing_postures"),
    approvalGrantModes: artifactMap<PersistedApprovalGrantModes>("approval_grant_modes"),
    egressPolicies: artifactMap<PersistedEgressPolicy>("egress_policies"),
    unfulfilledInsights: artifactMap<PersistedScopedFlag>("unfulfilled_insights_flag"),
    externalSlackParticipants: artifactMap<PersistedScopedFlag>("external_slack_participants_flag"),
    channelHeaderPin: artifactMap<PersistedScopedFlag>("channel_header_pin_flag"),
    baseModels: artifactMap<PersistedBaseModel>("base_model_configs"),
    approvedHarnesses: artifactMap<PersistedApprovedHarnesses>("approved_harness_configs"),
    internalMemberOverrides: artifactMap<PersistedInternalMemberOverrides>("internal_member_overrides"),
    orgAmbient: artifactMap<PersistedScopedFlag>("org_ambient_flag"),
    interactiveFastMode: artifactMap<PersistedScopedFlag>("interactive_fast_mode_flag"),
    individualModelAuth: artifactMap<PersistedScopedFlag>("individual_model_auth_flag"),
    webuiModels: artifactMap<PersistedWebuiModels>("webui_model_configs"),
    peopleDirectoryUrls: artifactMap<PersistedPeopleDirectoryUrl>("people_directory_urls"),
    ackEmoji: artifactMap<PersistedAckEmoji>("ack_emoji"),
    slackEmojiCatalog: artifactMap<PersistedSlackEmojiCatalog>("slack_emoji_catalog"),
    branding: artifactMap<PersistedBranding>("branding_configs"),
    browseMaxSteps: artifactMap<PersistedBrowseMaxSteps>("browse_max_steps_configs"),
    browseModels: artifactMap<PersistedBrowseModel>("browse_model_configs"),
    autoFlaggerConfigs: artifactMap<PersistedAutoFlaggerConfig>("auto_flagger_configs"),
    turnWallClocks: artifactMap<PersistedTurnWallClock>("turn_wall_clock_configs"),
    deploymentIdentity: artifactMap<PersistedDeploymentIdentity>("deployment_identity"),
    defaultSecurityPosture: config.securityPosture,
    defaultSharingPosture: config.sharingPosture,
    ...(config.connectorSecretKey ? { connectorSecretKey: config.connectorSecretKey } : {}),
  });
  void configStore.hydrate?.();
  const skills: SkillStore = createSkillStore({
    backing: artifactMap<Skill>("skills"),
    ...(config.skillSigningSecret ? { signingSecret: config.skillSigningSecret } : {}),
  });
  const skillPacks = createSkillPackStore({ backing: artifactMap<SkillPack>("skill_packs") });
  const skillBundles = createSkillBundleStore({ backing: artifactMap<SkillBundle>("skill_bundles") });
  const livenessCache = createLivenessCache(artifactMap<ScopeLivenessRecord>("credential_liveness"));
  const deviceFlowCutover = createDeviceFlowCutoverStore(artifactMap<DeviceFlowCutoverPolicy>("device_flow_cutover"), {
    resets: artifactMap<DeviceFlowCutoverReset>("device_flow_cutover_resets"),
  });
  const featureFlags = createFeatureFlagStore(artifactMap<FeatureFlagRecord>("feature_flags"));
  const connectorStatusCache = createConnectorStatusCache(artifactMap<ConnectorStatusRecord>("connector_status"));
  const slackInstallation = createSlackInstallationStore(
    config.orgId,
    artifactMap("slack_installation"),
    config.connectorSecretKey ?? randomBytes(32),
  );
  const deploymentLayer = config.deploymentLayerDir
    ? loadDeploymentLayer(config.deploymentLayerDir)
    : emptyDeploymentLayer();
  const layerSkillsDir = config.deploymentLayerDir ? resolve(deploymentLayer.dir, "skills") : undefined;
  const credentialTools = deploymentLayer.credentialTools;
  const brokeredTools = deploymentLayer.brokeredTools;
  const orgScope = scopeId("org", config.orgId);
  const auditLog = config.databaseUrl ? createPostgresAuditLog(config.databaseUrl) : createAuditLog();
  const deploymentLayerStore = createDeploymentLayerStore({
    backing: artifactMap<StoredDeploymentLayer>("deployment_layer"),
    runtime: deploymentLayer,
    skills,
    skillBundles,
    scopeId: orgScope,
    durable: pgArtifactMap !== null,
    advisoryLock,
    auditPersisted: (record) =>
      auditLog.recordOnce!(`deployment-layer:${orgScope}:${record.version}`, {
        at: record.updatedAt,
        principalId: record.updatedBy,
        action: "deployment_layer.updated",
        resource: record.contentHash,
        scopeLabel: orgScope,
      }),
    ...(config.seedSkills && layerSkillsDir
      ? {
          seedFallback: () =>
            installSeedSkills(skills, {
              dir: layerSkillsDir,
              scopeId: orgScope,
              createdBy: LAYER_CREATED_BY,
              reviewer: LAYER_REVIEWER,
            }),
        }
      : {}),
  });
  const deploymentLayerReady = deploymentLayerStore.hydrate();
  const deploymentLayerRefresh = createSweeper(() => deploymentLayerStore.hydrate(), 30_000, {
    label: "deployment layer refresh",
  });
  let skillsReady: Promise<void>;
  if (config.seedSkills) {
    const installCatalogs = async (): Promise<void> => {
      await installSeedSkills(skills, { dir: config.skillsSeedDir, scopeId: orgScope });
      for (const dir of config.pluginSkillDirs) {
        if (layerSkillsDir && resolve(dir) === layerSkillsDir) continue;
        await installSeedSkills(skills, {
          dir,
          scopeId: orgScope,
          createdBy: "system:plugin-skills",
          reviewer: "system:plugin-skills-reviewer",
        });
      }
    };
    skillsReady = Promise.all([
      installCatalogs().catch((e) => console.error("[seed] failed to install seed skills:", errMessage(e))),
      deploymentLayerReady.catch((e) => console.error("[seed] deployment layer not ready:", errMessage(e))),
    ]).then(() => undefined);
  } else {
    skillsReady = deploymentLayerReady.then(
      () => undefined,
      (e) => console.error("[seed] deployment layer not ready:", errMessage(e)),
    );
  }
  const rateLimitOpts = { maxPerWindow: config.rateLimitPerWindow, windowMs: config.rateLimitWindowMs };
  const rateLimiter = config.databaseUrl
    ? createPostgresRateLimiter(config.databaseUrl, rateLimitOpts)
    : createRateLimiter(rateLimitOpts);
  const budgetOpts = {
    ...(config.budgetUsdPerWindow !== undefined ? { limitUsd: config.budgetUsdPerWindow } : {}),
    ...(config.orgBudgetUsdPerWindow !== undefined ? { orgLimitUsd: config.orgBudgetUsdPerWindow } : {}),
    windowMs: config.budgetWindowMs,
  };
  const budget =
    config.databaseUrl && (config.budgetUsdPerWindow !== undefined || config.orgBudgetUsdPerWindow !== undefined)
      ? createPostgresBudgetTracker(config.databaseUrl, budgetOpts)
      : createBudgetTracker(budgetOpts);
  const resolution = createResolutionService(config.orgId, configStore, acl);

  const workspace = createLocalWorkspaceStore(config.dataDir);
  const blobTransfer: BlobTransferStore =
    config.transferStore === "s3" && config.s3Bucket
      ? createS3BlobTransferStore({
          bucket: config.s3Bucket,
          ...(config.s3Region ? { region: config.s3Region } : {}),
          ...(config.s3Prefix ? { prefix: config.s3Prefix } : {}),
        })
      : createLocalBlobTransferStore(join(config.dataDir, "transfer"));
  const fileBytes: DurableByteStore =
    config.snapshotStore === "s3" && config.s3Bucket
      ? createS3DurableByteStore({
          bucket: config.s3Bucket,
          ...(config.s3Region ? { region: config.s3Region } : {}),
          ...(config.s3Prefix ? { prefix: config.s3Prefix } : {}),
        })
      : createLocalDurableByteStore(join(config.dataDir, "docstore"));
  const files: FileArtifactStore = config.databaseUrl
    ? createPostgresFileArtifactStore(config.databaseUrl, fileBytes)
    : createMemoryFileArtifactStore(fileBytes);
  const fileUploads =
    config.databaseUrl && config.snapshotStore === "s3" && config.s3Bucket
      ? createDirectFileUploads({
          bucket: config.s3Bucket,
          ...(config.s3Region ? { region: config.s3Region } : {}),
          ...(config.s3Prefix ? { prefix: config.s3Prefix } : {}),
          store: createPostgresFileUploadStore(config.databaseUrl),
          files,
        })
      : undefined;
  const defaultMemory: MemoryService = config.databaseUrl
    ? createPostgresMemoryService(config.databaseUrl)
    : createMemoryService(workspace);
  // Session storage is built further down; trace-derived providers only read it after the first turn.
  const memorySessions: { store?: SessionStore } = {};
  const baseMemory: MemoryService = createConfiguredMemoryService({
    defaultMemory,
    config: config.memoryProviderConfig,
    sessionEntries: (sessionId) => {
      if (!memorySessions.store) throw new Error("session store is not ready");
      return memorySessions.store.getEntries(sessionId, { limit: MEMORY_CAPTURE_ENTRY_WINDOW });
    },
  });
  const mcpServers = createMcpServerStore(artifactMap<McpServer>("mcp_servers"));
  const mcpToolService = createMcpToolService({ servers: mcpServers, audit: auditLog });
  const mcpTools = () => mcpToolService.toolDefs();
  const errors = config.databaseUrl ? createPostgresErrorLog(config.databaseUrl) : createErrorLog();
  const sandboxOnError = (e: { category: string; code: string; message: string; scopeLabel?: string }) =>
    errors.record({
      category: e.category,
      code: e.code,
      message: e.message,
      scopeLabel: (e.scopeLabel ?? "unknown") as ScopeId,
    });
  const buildKubernetes = (): Sandbox =>
    createKubernetesSandbox(workspace, {
      ...config.kubernetesSandbox,
      orgId: config.orgId,
    });
  const buildLocal = (): Sandbox =>
    createLocalSandbox(workspace, {
      ...config.localSandbox,
      onError: sandboxOnError,
    });
  const buildSprites = (): Sandbox =>
    createSpritesSandbox(workspace, {
      ...config.spritesSandbox,
      blobTransfer,
      extraTools: deploymentLayer.advertisedTools,
      credentialPaths: deploymentLayer.credentialPaths,
      layerToolFiles: () => deploymentLayer.installFiles,
      ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
      ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
      ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
      onError: sandboxOnError,
    });
  const buildSmolmachines = (): Sandbox =>
    createSmolmachinesSandbox(workspace, {
      ...config.smolmachinesSandbox,
      blobTransfer,
      extraTools: deploymentLayer.advertisedTools,
      credentialPaths: deploymentLayer.credentialPaths,
      layerToolFiles: () => deploymentLayer.installFiles,
      ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
      ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
      ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
      onError: sandboxOnError,
    });
  const e2bBodies = artifactMap<StoredE2bSandbox>("e2b_sandbox_bodies");
  const modalBodies = artifactMap<StoredModalSandbox>("modal_sandbox_bodies");
  const awsBodies = artifactMap<StoredMicrovm>("aws_sandbox_bodies");
  const buildE2b = (): Sandbox => {
    const e2b = config.e2bSandbox;
    if (!e2b.apiKey) throw new Error("SANDBOX_BACKEND=e2b requires E2B_API_KEY");
    return createE2bSandbox(workspace, {
      client: createSdkE2bClient({
        apiKey: e2b.apiKey,
        ...(e2b.templateId ? { templateId: e2b.templateId } : {}),
        ...(e2b.sandboxTtlSec ? { sandboxTtlMs: e2b.sandboxTtlSec * 1000 } : {}),
        ...(e2b.proxy ? { proxy: e2b.proxy } : {}),
      }),
      ...(e2b.namePrefix ? { namePrefix: e2b.namePrefix } : {}),
      ...(e2b.defaultTimeoutSec ? { defaultTimeoutSec: e2b.defaultTimeoutSec } : {}),
      ...(e2b.snapshotIntervalSec !== undefined ? { snapshotIntervalMs: e2b.snapshotIntervalSec * 1000 } : {}),
      ...(e2b.egressProxyUrl ? { egressProxyUrl: e2b.egressProxyUrl } : {}),
      extraTools: deploymentLayer.advertisedTools,
      credentialPaths: deploymentLayer.credentialPaths,
      layerToolFiles: () => deploymentLayer.installFiles,
      blobTransfer,
      ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
      ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
      ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
      store: e2bBodies,
      ...(e2b.snapshotS3Bucket
        ? { snapshots: createS3SnapshotStore({ bucket: e2b.snapshotS3Bucket, prefix: "e2b-home" }) }
        : {}),
      onError: sandboxOnError,
    });
  };
  const buildModal = (): Sandbox => {
    const modal = config.modalSandbox;
    if (!modal.tokenId || !modal.tokenSecret)
      throw new Error("SANDBOX_BACKEND=modal requires MODAL_TOKEN_ID and MODAL_TOKEN_SECRET");
    return createModalSandbox(workspace, {
      client: createSdkModalClient({
        tokenId: modal.tokenId,
        tokenSecret: modal.tokenSecret,
        appName: modal.appName ?? "qm",
        image: modal.image ?? "ubuntu:24.04",
        ...(modal.image
          ? {}
          : {
              imageSetupCommands: [
                "RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git jq tar xz-utils unzip python3 python3-venv openssh-client && rm -rf /var/lib/apt/lists/*",
                "RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/* && node --version",
              ],
            }),
        ...(modal.environment ? { environment: modal.environment } : {}),
        ...(modal.cpus !== undefined ? { cpus: modal.cpus } : {}),
        ...(modal.memoryMb !== undefined ? { memoryMb: modal.memoryMb } : {}),
        ...(modal.regions?.length ? { regions: modal.regions } : {}),
        ...(modal.sandboxTimeoutSec ? { sandboxTimeoutMs: modal.sandboxTimeoutSec * 1000 } : {}),
        ...(modal.snapshotRetentionSec !== undefined ? { snapshotRetentionMs: modal.snapshotRetentionSec * 1000 } : {}),
      }),
      ...(modal.namePrefix ? { namePrefix: modal.namePrefix } : {}),
      ...(modal.defaultTimeoutSec ? { defaultTimeoutSec: modal.defaultTimeoutSec } : {}),
      ...(modal.snapshotIntervalSec !== undefined ? { snapshotIntervalMs: modal.snapshotIntervalSec * 1000 } : {}),
      nativeSnapshotsEnabled: modal.nativeSnapshotsEnabled ?? false,
      ...(modal.nativeSnapshotIntervalSec !== undefined
        ? { nativeSnapshotIntervalMs: modal.nativeSnapshotIntervalSec * 1000 }
        : {}),
      ...(modal.rotateAfterSec ? { rotateAfterMs: modal.rotateAfterSec * 1000 } : {}),
      ...(modal.reapIdleSec ? { reapIdleMs: modal.reapIdleSec * 1000 } : {}),
      ...(modal.egressProxyUrl ? { egressProxyUrl: modal.egressProxyUrl } : {}),
      extraTools: deploymentLayer.advertisedTools,
      credentialPaths: deploymentLayer.credentialPaths,
      layerToolFiles: () => deploymentLayer.installFiles,
      blobTransfer,
      ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
      ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
      ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
      store: modalBodies,
      ...(modal.snapshotS3Bucket
        ? { snapshots: createS3SnapshotStore({ bucket: modal.snapshotS3Bucket, prefix: "modal-home" }) }
        : {}),
      onError: sandboxOnError,
    });
  };
  const buildAgent37 = (): Sandbox =>
    createAgent37Sandbox(workspace, {
      ...config.agent37Sandbox,
      advisoryLock,
      blobTransfer,
      extraTools: deploymentLayer.advertisedTools,
      credentialPaths: deploymentLayer.credentialPaths,
      ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
      ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
      ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
      onError: sandboxOnError,
    });
  const buildAws = (): Sandbox => {
    if (!config.awsSandbox.s3Bucket) throw new Error("SANDBOX_BACKEND=aws requires AWS_SANDBOX_S3_BUCKET");
    return createAwsSandbox(workspace, {
      ...config.awsSandbox,
      s3Bucket: config.awsSandbox.s3Bucket,
      advisoryLock,
      extraTools: deploymentLayer.advertisedTools,
      credentialPaths: deploymentLayer.credentialPaths,
      blobTransfer,
      ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
      ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
      ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
      store: awsBodies,
      onError: sandboxOnError,
    });
  };
  const buildPorter = (): Sandbox =>
    createPorterSandbox(workspace, {
      ...config.porterSandbox,
      advisoryLock,
      blobTransfer,
      extraTools: deploymentLayer.advertisedTools,
      credentialPaths: deploymentLayer.credentialPaths,
      ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
      ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
      ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
      onError: sandboxOnError,
    });
  const buildBackend: Record<Config["sandboxBackend"], () => Sandbox> = {
    kubernetes: buildKubernetes,
    local: buildLocal,
    sprites: buildSprites,
    smolmachines: buildSmolmachines,
    e2b: buildE2b,
    modal: buildModal,
    aws: buildAws,
    porter: buildPorter,
    agent37: buildAgent37,
  };
  const enabledBackends = new Set(enabledSandboxBackends(config));
  const sandboxBackends: Partial<Record<SandboxBackendName, Sandbox>> = {
    [config.sandboxBackend]: buildBackend[config.sandboxBackend](),
  };
  for (const name of Object.keys(buildBackend) as Array<Config["sandboxBackend"]>) {
    if (name !== config.sandboxBackend && enabledBackends.has(name)) sandboxBackends[name] = buildBackend[name]();
  }
  const sandboxRoutes = artifactMap<SandboxRoute>("sandbox_routing");
  const sandboxResources = createSandboxResources({
    enabled: config.sandboxResourcesEnabled,
    rollout: artifactMap<SandboxResourceRollout>("sandbox_resource_rollout"),
    legacyScopes: async () => (await sessions.distinctScopes()).map((scope) => scope.scopeId),
    legacySandboxes: async () => {
      const [e2b, modal, aws] = await Promise.all([e2bBodies.entries(), modalBodies.entries(), awsBodies.entries()]);
      return [
        ...e2b.map(([scopeId, body]) => ({ scopeId, backend: "e2b" as const, machineId: body.sandboxId })),
        ...modal.map(([scopeId, body]) => ({ scopeId, backend: "modal" as const, machineId: body.sandboxId })),
        ...aws.map(([scopeId, body]) => ({ scopeId, backend: "aws" as const, machineId: body.microvmId })),
      ];
    },
    records: artifactMap<SandboxResource>("sandbox_resources"),
    defaults: artifactMap<SandboxDefault>("sandbox_defaults"),
    routes: sandboxRoutes,
    backends: sandboxBackends,
    defaultBackend: config.sandboxBackend,
    lock: advisoryLock,
    beforeRetire: async (record) => {
      if (
        (await processes?.liveByScope(record.ownerScopeId))?.some(
          (process) => !process.sandboxId || process.sandboxId === record.id,
        )
      )
        throw new Error("stop this sandbox's background jobs before retiring it");
    },
    beforeDefaultChange: async (scopeId) => {
      if ((await processes?.liveByScope(scopeId))?.some((process) => !process.sandboxId))
        throw new Error(
          "legacy background work has no saved sandbox target; finish or stop it before changing the default",
        );
    },
    provisionOptions: async (scopeId) => {
      const secret = config.capabilitySecret ?? config.signingSecret;
      if (!secret) return {};
      const egressToken = await mintCapabilityToken(
        {
          actorId: "system:sandbox-create",
          scopeId,
          aud: EGRESS_PROXY_AUD,
          egress: egressClaimAllowingControlPlane({ allowedHosts: [] }, config.apiBaseUrl ?? "", true),
          exp: Date.now() + CAPABILITY_TTL_MS,
        },
        secret,
      );
      return { egressToken };
    },
    canUseScope: (actorId, scopeId) => membership.canUseSandboxScope!(actorId, scopeId),
  });
  const sandbox: Sandbox = createSandboxRouter({
    resources: sandboxResources,
    backends: sandboxBackends,
    routes: sandboxRoutes,
    defaultBackend: config.sandboxBackend,
    onError: sandboxOnError,
  });
  const sandboxMigration = createSandboxMigrationRunner({
    backends: sandboxBackends,
    routes: sandboxRoutes,
    defaultBackend: config.sandboxBackend,
    advisoryLock,
    settleMs: ROUTE_CACHE_TTL_MS,
    provisionOptions: async (scopeId) => {
      const egressSecret = config.capabilitySecret ?? config.signingSecret;
      if (!egressSecret) return {};
      const egressToken = await mintCapabilityToken(
        {
          actorId: "system:sandbox-migration",
          scopeId: scopeId as ScopeId,
          aud: EGRESS_PROXY_AUD,
          egress: egressClaimAllowingControlPlane({ allowedHosts: [] }, config.apiBaseUrl ?? "", true),
          exp: Date.now() + CAPABILITY_TTL_MS,
        },
        egressSecret,
      );
      return { egressToken };
    },
    withLegacyMutation: (scope, action) => sandboxResources.withLegacyMutation(scope, action),
    hasLiveWork: async (scope) => !!processes && (await processes.liveByScope(scope)).length > 0,
  });
  const secretSource =
    config.secretsBackend === "aws"
      ? createLayeredSecretSource(
          createEnvSecretSource(),
          createAwsSecretsManagerSource({ prefix: config.secretsPrefix }),
        )
      : createEnvSecretSource();
  const resolveClient: OAuthClientResolver = createConnectorClientResolver({
    reader: configStore,
    orgScopeId: (o) => scopeId("org", o),
    secrets: secretSource,
  });
  const keychainKeyMaterial = config.connectorSecretKey;
  const legacyCredentialKey =
    keychainKeyMaterial && config.signingSecret && config.signingSecret !== keychainKeyMaterial
      ? deriveConnectorKey(config.signingSecret, "keychain")
      : undefined;
  const credentialKey: SecretKey = {
    ...deriveConnectorKey(keychainKeyMaterial ?? randomBytes(32), "keychain"),
    ...(legacyCredentialKey ? { fallbacks: [legacyCredentialKey] } : {}),
  };
  const credentialStore: Keychain = createKeychain({
    creds: artifactMap<KeychainCredential>("keychain_credentials"),
    grants: artifactMap<KeychainGrant>("keychain_grants"),
    asks: artifactMap<KeychainAsk>("keychain_asks"),
    key: credentialKey,
    refreshConnector: (() => {
      const base = makeRefresh({ resolveClient });
      // AI subscription logins ride the same connector-refresh machinery:
      // the keychain calls this single-flight when a token is stale.
      return async (host: string, token: OAuthToken, ctx?: { accountType?: string; clientRef?: string }) => {
        if (token.refreshToken && host === "auth.openai.com") {
          const fresh = await refreshChatGPTTokens(token.refreshToken);
          return oauthTokenFromUserTokens(fresh);
        }
        if (token.refreshToken && host === "claude.ai") {
          const fresh = await refreshClaudeTokens(token.refreshToken);
          return oauthTokenFromUserTokens(fresh);
        }
        return base(host, token, ctx);
      };
    })(),
  });
  const oauthTokenFromUserTokens = (fresh: {
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    accountId?: string;
    expiresAt?: number;
  }): OAuthToken => ({
    accessToken: fresh.accessToken,
    ...(fresh.refreshToken ? { refreshToken: fresh.refreshToken } : {}),
    ...(fresh.idToken ? { idToken: fresh.idToken } : {}),
    ...(fresh.accountId ? { accountId: fresh.accountId } : {}),
    ...(fresh.expiresAt !== undefined ? { expiresAt: fresh.expiresAt } : {}),
  });
  // Per-user AI accounts live in the keychain itself (unified custody):
  // same encryption, ownership, admin visibility, and removal flows as
  // every other personal credential.
  const userModelCredentials = createUserModelCredentialStore({ keychain: credentialStore });
  const keychain: Keychain | undefined = keychainKeyMaterial ? credentialStore : undefined;
  const browserSessionStore: BrowserSessionStore | undefined = keychainKeyMaterial
    ? createBrowserSessionStore({ sessions: artifactMap<StoredBrowserSession>("browser_sessions"), key: credentialKey })
    : undefined;
  const connectorTokens = withOperatorTokenFallback(credentialStore, config.egressServiceHosts ?? [], secretSource);
  const consentLinks: ConsentLinkStore = createConsentLinkStore(artifactMap<ConsentLinkRecord>("consent_links"));
  const oauthFlows: OAuthFlowStore = createOAuthFlowStore(artifactMap<OAuthState>("oauth_flows"));
  const secretDrops: SecretDropStore = createSecretDropStore(artifactMap<SecretDropRecord>("secret_drops"));
  const modelGateway = createModelGateway();

  const requireDbUrl = (kind: string): string => {
    if (!config.databaseUrl) throw new Error(`${kind}=postgres requires DATABASE_URL`);
    return config.databaseUrl;
  };
  const sessions: SessionStore =
    config.sessionStore === "postgres"
      ? createPostgresSessionStore(requireDbUrl("SESSION_STORE"))
      : createMemorySessionStore();
  memorySessions.store = sessions;
  const runStoreKind = config.runStore;
  const runSignals: RunSignalStore =
    runStoreKind === "postgres"
      ? createPostgresRunSignalStore(requireDbUrl("RUN_STORE"))
      : createMemoryRunSignalStore();
  const tasks = config.databaseUrl ? createPostgresTaskStore(config.databaseUrl) : createMemoryTaskStore();
  const writeModelRegistry = <T>(fn: () => Promise<T>): Promise<T> =>
    advisoryLock.withLock("model-registry", async () => {
      await refreshModels();
      return fn();
    });
  const customProviders = createCustomProviderStore({
    write: writeModelRegistry,
    backing: artifactMap("custom_model_providers"),
    keyMaterial: config.connectorSecretKey ?? randomBytes(32),
  });
  const modelVerifier = createModelVerifier({
    credentials: modelCredentials,
    keyMaterial: config.connectorSecretKey ?? randomBytes(32),
    modelGateway: config.modelGateway,
    probe: overrides.modelVerificationProbe,
  });
  const modelRegistry = createModelOverlayStore(artifactMap("model_registry"), writeModelRegistry, modelVerifier);
  const refreshCustomProviders = async () => {
    setCustomProviders(await customProviders.enabled());
  };
  const refreshModels = async () => {
    await refreshCustomProviders();
    await modelRegistry.refresh();
  };
  const resolveModelProviderKeys = async () => {
    await refreshModels();
    const [anthropic, openai, openrouter, enabledCustom] = await Promise.all([
      modelCredentials.resolve("anthropic"),
      modelCredentials.resolve("openai"),
      modelCredentials.resolve("openrouter"),
      customProviders.enabled(),
    ]);
    const customKeys = Object.fromEntries(
      (
        await Promise.all(
          enabledCustom.map(async (p) => {
            try {
              return [p.id, await customProviders.resolveKey(p.id)] as const;
            } catch (e) {
              // A corrupt/undecryptable custom key must degrade that one
              // provider, never the whole turn (built-ins included).
              console.error(`[model] custom provider ${p.id}: key unreadable: ${errMessage(e)}`);
              return [p.id, null] as const;
            }
          }),
        )
      ).filter(([, key]) => key),
    );
    return {
      ...(anthropic ? { anthropic } : {}),
      ...(openai ? { openai } : {}),
      ...(openrouter ? { openrouter } : {}),
      ...customKeys,
    };
  };
  const runtimeOrgScope = scopeId("org", config.orgId);
  const orgBaseModelId = (): string | undefined =>
    configStore.getRuntimeSelection(runtimeOrgScope)?.modelId ?? configStore.getBaseModel(runtimeOrgScope) ?? undefined;
  const adapters = new Map<HarnessId, Harness>([
    [
      "pi",
      createPiHarness({
        ...piHarnessConfigOptions(config),
        resolveBaseModelId: orgBaseModelId,
        resolveProviderKeys: resolveModelProviderKeys,
        signals: runSignals,
        mcpTools,
      }),
    ],
    [
      "opencode",
      createOpenCodeHarness({
        ...openCodeHarnessConfigOptions(config),
        signals: runSignals,
        tasks,
        mcpTools,
        resolveCustomProviders: async () => {
          const enabled = await customProviders.enabled();
          return Promise.all(
            enabled.map(async (spec) => {
              try {
                const apiKey = await customProviders.resolveKey(spec.id);
                return { spec, ...(apiKey ? { apiKey } : {}) };
              } catch (e) {
                // An unreadable key must not prevent the opencode server from
                // starting; the provider is configured keyless and its models
                // fail individually instead.
                console.error(`[model] custom provider ${spec.id}: key unreadable: ${errMessage(e)}`);
                return { spec };
              }
            }),
          );
        },
      }),
    ],
    [
      "codex",
      createCodexHarness({
        ...codexHarnessConfigOptions(config),
        // Keychain custody: the subscription login lives encrypted in its
        // owner's keychain; core refreshes it centrally and hands the harness
        // ephemeral derived material. The credential can be (re)registered at
        // runtime — resolution happens on every load.
        ...(config.codexAuthCredential && keychain
          ? { authStore: keychainCodexAuthStore({ keychain, credentialId: config.codexAuthCredential }) }
          : {}),
        signals: runSignals,
        tasks,
        mcpTools,
      }),
    ],
    [
      "claude",
      createClaudeHarness({
        ...claudeHarnessConfigOptions(config),
        ...(config.claudeAuthCredential && keychain
          ? {
              authEnv: keychainHarnessAuthEnv(keychain, config.claudeAuthCredential, [
                "CLAUDE_CODE_OAUTH_TOKEN",
                "ANTHROPIC_AUTH_TOKEN",
              ]),
            }
          : {}),
        signals: runSignals,
        tasks,
        mcpTools,
      }),
    ],
    ["mock", createMockHarness()],
  ]);
  const fallbackHarness = config.harness as HarnessId;
  const fallback = {
    harnessId: fallbackHarness,
    get modelId() {
      return defaultModelForHarness(
        fallbackHarness,
        configuredModelForHarness(config, fallbackHarness),
        baseModelProviders(config),
      );
    },
  };
  const judgeModelId = (): string => config.judgeModelId ?? auxiliaryModelFor(orgBaseModelId() ?? fallback.modelId);
  const hydrateModelCatalog = async (): Promise<unknown> => {
    await refreshModels();
    if (!(await modelCredentials.availability()).openrouter) return undefined;
    return selectableModelCatalog(overrides.modelCredentialFetch);
  };
  const harness = createHarnessRouter(adapters, adapters.get(fallbackHarness)!, async (input) => {
    await refreshModels();
    if (input.runtimePinned && input.runtime?.harnessId && input.runtime.modelId) {
      if (!modelSupportedByHarness(input.runtime.modelId, input.runtime.harnessId))
        throw new Error(`Unsupported model: ${input.runtime.modelId}`);
      return { ...input.runtime, harnessId: input.runtime.harnessId, modelId: input.runtime.modelId };
    }
    return resolveRuntimeChoiceDurable(
      configStore,
      runtimeOrgScope,
      input.scopeLabel,
      fallback,
      input.runtime,
      hydrateModelCatalog,
    );
  });

  const leaseTtlMs = config.leaseTtlMs;
  const maxAttempts = config.maxAttempts;
  const runStore =
    runStoreKind === "postgres"
      ? createPostgresRunStore(requireDbUrl("RUN_STORE"), { maxClaims: config.maxClaims })
      : createMemoryRunStore({ maxClaims: config.maxClaims });
  const runs: RunStore = runStore.runs;
  const ledger = runStore.ledger;

  let processes: ProcessRegistry | undefined;
  if (supportsProcessSessions(sandbox)) {
    processes = config.databaseUrl ? createPostgresProcessRegistry(config.databaseUrl) : createMemoryProcessRegistry();
  }

  const brokerSessions = config.databaseUrl ? createPostgresBrokerSessions(config.databaseUrl) : undefined;
  const replayDedupe = config.databaseUrl ? createPostgresReplayDedupe(config.databaseUrl) : createMemoryReplayDedupe();
  const metrics = config.databaseUrl ? createPostgresMetricsSink(config.databaseUrl) : createMetricsSink();
  const credentialUsage = config.databaseUrl
    ? createPostgresCredentialUsageSink(config.databaseUrl)
    : createCredentialUsageSink();
  const egressAudit = config.databaseUrl ? createPostgresEgressAuditSink(config.databaseUrl) : createEgressAuditSink();
  const turnStream = createTurnStream();
  const sessionStateBus: SessionStateBus = config.databaseUrl
    ? createPostgresSessionStateBus(config.databaseUrl)
    : createMemorySessionStateBus();
  const ledgerEventBus: LedgerEventBus = config.databaseUrl
    ? createPostgresLedgerEventBus(config.databaseUrl)
    : createMemoryLedgerEventBus();
  const runActivity: RunActivityStore =
    runStoreKind === "postgres"
      ? createPostgresRunActivityStore(requireDbUrl("RUN_STORE"))
      : createMemoryRunActivityStore();
  const deployStore = createDeployStore({
    deployments: artifactMap<Deployment>("deployments"),
    ...(pgArtifactMap ? { pg: pgArtifactMap.pool } : {}),
    touchDebounceMs: deployTouchDebounceMs(config.deployIdleTtlMs),
    git: {
      repoRoot: config.deployGitDir,
      archiveStore: artifactMap<DeployGitArchive>("deploy_git_repos"),
      ...(config.snapshotStore === "s3" && config.s3Bucket
        ? {
            archiveBytes: createS3DurableByteStore({
              bucket: config.s3Bucket,
              ...(config.s3Region ? { region: config.s3Region } : {}),
              prefix: `${config.s3Prefix ?? ""}deploy-git/`,
            }),
          }
        : {}),
    },
  });
  const buildAwsDeploy = (): DeployProvider =>
    createAwsDeployProvider({
      ...config.awsDeploy,
      ...(!config.awsDeploy.dataBucket && config.awsSandbox.s3Bucket ? { dataBucket: config.awsSandbox.s3Bucket } : {}),
      advisoryLock,
      store: artifactMap<StoredDeployBody>("aws_deploy_bodies"),
    });
  const buildDeployProvider: Record<Config["deployProvider"], () => DeployProvider> = {
    aws: buildAwsDeploy,
    docker: createDockerDeployProvider,
    fly: () => createFlyDeployProvider(config.flyDeploy),
    porter: () =>
      createPorterDeployProvider({
        ...config.porterDeploy,
        advisoryLock,
        store: artifactMap<StoredPorterDeployBody>("porter_deploy_bodies"),
      }),
  };
  const deployProvider: DeployProvider = buildDeployProvider[config.deployProvider]();
  if (config.deployProvider === "aws" && !config.awsDeploy.dataBucket && !config.awsSandbox.s3Bucket) {
    console.warn(
      "[wiring] aws deploy: no data bucket resolved (AWS_DEPLOY_DATA_BUCKET unset, sandbox is not aws) — deployed apps have NO durable /data",
    );
  }
  const approvals = artifactMap<PendingApprovalRecord>("approvals");
  const adminGrantPersist = config.databaseUrl
    ? createPostgresAdminGrantStore(config.databaseUrl)
    : createMapAdminGrantPersistence(createMemoryMap<AdminGrant>());
  const adminGrantStore = createAdminGrantStore(adminGrantPersist, {
    seed: bootAdminGrantSeed(config.adminGrants, config.orgId, !!config.databaseUrl),
  });
  const admin = createAdminService(adminGrantStore);
  const { strategy: memoryStrategy, memory } = createMemoryStrategy(config.memoryStrategy, {
    harness: harness.models,
    memory: baseMemory,
    workspace,
    ...(config.memoryConsolidateAfter !== undefined ? { consolidateAfter: config.memoryConsolidateAfter } : {}),
    captureQuietMs: config.memoryCaptureQuietMs,
    ...(config.memoryCaptureMaxTurns !== undefined ? { captureMaxTurns: config.memoryCaptureMaxTurns } : {}),
    onCaptureError: (e, scope) =>
      errors.record({ category: "memory", code: "capture_failed", message: errMessage(e), scopeLabel: scope }),
  });
  const directory = config.databaseUrl ? createPostgresDirectoryStore(config.databaseUrl) : createDirectoryStore();
  const projects = createProjectStore(artifactMap<Project>("projects"), {
    isActiveMember: (principalId) => identity.isInternal(identity.classify(principalId)),
    advisoryLock,
  });
  const canReadScope = createCanReadScope({ managedGroups: projects, directory, identity, sessions });
  const canWriteScope = createCanWriteScope({ managedGroups: projects, directory, identity });
  const canManageScope = createCanManageScope({ managedGroups: projects, directory, identity, sessions });
  const managesArtifactHome = createManagesArtifactHome({ managedGroups: projects, directory }, canManageScope);
  const currentScopeMembers = createCurrentScopeMembers({ managedGroups: projects, directory, identity });
  const isCurrentSharedScopeMember = createIsCurrentSharedScopeMember({ managedGroups: projects, directory, identity });
  membership.canReadScope = canReadScope;
  membership.canManageScope = canManageScope;
  membership.canUseSandboxScope = async (actorId, scopeId) =>
    identity.isInternal(identity.classify(actorId)) &&
    ((await admin.adminStatusOf(identity.classify(actorId))).isAdmin || (await canWriteScope(actorId, scopeId)));
  membership.managesArtifactHome = managesArtifactHome;
  const deployGitSecret = config.signingSecret;
  const deployGitBase = config.apiBaseUrl;
  const deployService = createDeployService({
    deployStore,
    provider: deployProvider,
    deployDir: join(config.dataDir, "deployments"),
    auditLog,
    acl,
    leaderLease,
    advisoryLock,
    canReadScope,
    canWriteScope,
    managesArtifactHome,
    ...(deployGitSecret && deployGitBase
      ? {
          deploymentEnv: async (deployment: Deployment): Promise<Record<string, string>> => {
            const env: Record<string, string> = {
              VIEWER_IDENTITY_KEY: viewerIdentityKey(deployGitSecret, deployment.id),
            };
            const orgScope = scopeId("org", config.orgId);
            const credentials = await deploymentCredentialSlugs(
              await credentialStore.listServiceCredentials(orgScope),
              orgScope,
              acl,
            );
            if (credentials.length) {
              env.AGENT_API_URL = deployGitBase;
              env.AGENT_CREDENTIAL_TOKEN = await mintCapabilityToken(
                {
                  actorId: deployment.createdBy,
                  scopeId: personalScope(deployment.createdBy),
                  aud: CREDENTIAL_BROKER_AUD,
                  credentials,
                  deployment: deployment.id,
                  exp: Date.now() + DEPLOYMENT_CREDENTIAL_TTL_MS,
                },
                config.capabilitySecret ?? deployGitSecret,
              );
            }
            return env;
          },
        }
      : {}),
  });
  const environments = config.databaseUrl
    ? createPostgresEnvironmentStore(config.databaseUrl)
    : createMemoryEnvironmentStore();
  const monitors = createMonitorStore(artifactMap<Monitor>("monitors"));
  const loopStore = createLoopStore(artifactMap<Loop>("loops"));
  const loopItemsMap = artifactMap<LoopItem>("loop_items");
  const loopOwnerCache = new Map<string, string>();
  const loopItems = createLoopItemLedger(loopItemsMap, (event) => {
    void (async () => {
      let owner = loopOwnerCache.get(event.loopId);
      if (owner === undefined) {
        owner = (await loopStore.get(event.loopId))?.owner ?? "";
        loopOwnerCache.set(event.loopId, owner);
      }
      if (owner) ledgerEventBus.emit({ ...event, owner });
    })().catch(() => {});
  });
  const loopOutputs = createLoopOutputStore(artifactMap<LoopOutput>("loop_outputs"));
  const loopGrants = createShipGrantStore(artifactMap<ShipGrant>("loop_ship_grants"));
  const cronChanged: { notify?: (id: string) => void } = {};
  const cronFires = config.databaseUrl ? createPostgresCronFireStore(config.databaseUrl) : createMemoryCronFireStore();
  const cronsBase = createCronStore(artifactMap<Cron>("crons"), {
    staleRunningMs: config.runMaxAgeMs,
    fires: cronFires,
  });
  const crons: CronStore = {
    ...cronsBase,
    async create(input) {
      const cron = await cronsBase.create(input);
      cronChanged.notify?.(cron.id);
      return cron;
    },
    async update(id, patch) {
      const cron = await cronsBase.update(id, patch);
      cronChanged.notify?.(id);
      return cron;
    },
    async setEnabled(id, enabled) {
      await cronsBase.setEnabled(id, enabled);
      cronChanged.notify?.(id);
    },
  };
  const webhooks = createWebhookStore(artifactMap<Webhook>("webhooks"));
  pgArtifactMap?.pool.registerMigration({
    id: "durable-map/webhooks/0002-disable-rows-orphaned-by-webhook-removal",
    legacyId: "durable-map/webhooks/0002-disable-rows-orphaned-by-webhook-removal",
    statements: [
      "CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, json JSONB NOT NULL)",
      `UPDATE webhooks SET json = jsonb_set(json, '{enabled}', 'false'::jsonb) WHERE (json ->> 'enabled')::boolean`,
    ],
  });
  const deliveries = withWebTranscriptDeliveries(
    config.databaseUrl ? createPostgresDeliveryStore(config.databaseUrl) : createDeliveryStore(),
    sessions,
  );
  let securityScreener = overrides.securityScreener;
  if (!securityScreener && config.securityScreenBackend === "proxy") {
    securityScreener = createSecurityScreenProxy({
      provider: config.securityScreenProxy!.provider,
      endpoint: config.securityScreenProxy!.endpoint,
      token: config.securityScreenProxy!.token,
      timeoutMs: config.securityScreenTimeoutMs,
      shadow: config.securityScreenProxy!.shadow,
    });
  }
  const layerEnv = config.layerEnv ?? {};
  const layerBrokerCache = new Map<string, AwsRoleBroker>();
  const layerBrokerFor = (tool: BrokeredLayerTool): AwsRoleBroker | undefined => {
    const override = overrides.credentialBrokers?.[tool.service];
    if (override) return override;
    const roleArn = layerEnv[tool.broker.roleArnEnv];
    if (!roleArn) return undefined;
    const region = (tool.broker.regionEnv ? layerEnv[tool.broker.regionEnv] : undefined) ?? tool.broker.region;
    if (!region) return undefined;
    const key = JSON.stringify([roleArn, region, tool.broker.sessionActions]);
    let broker = layerBrokerCache.get(key);
    if (!broker) {
      broker = createAwsRoleBroker({ roleArn, region, sessionActions: tool.broker.sessionActions });
      layerBrokerCache.set(key, broker);
    }
    return broker;
  };
  const orchestratorDeps: OrchestratorDeps = {
    refreshModels,
    identity,
    resolution,
    config: configStore,
    defaultHarness: fallbackHarness,
    defaultTurnWallClockMs: config.turnWallClockMs,
    userModelCredentials,
    ...(config.brandingDefault ? { brandingDefault: config.brandingDefault } : {}),
    sessionTapeMode: config.sessionTapeMode,
    sessions,
    workspace,
    files,
    sandbox,
    sandboxMigration,
    sandboxResources,
    connectorTokens,
    modelGateway,
    auditLog,
    rateLimiter,
    budget,
    harness,
    memory,
    deploy: deployService,
    acl,
    admin,
    mcp: mcpToolService,
    ...(config.maxContextTokens !== undefined ? { maxContextTokens: config.maxContextTokens } : {}),
    execTimeoutMs: config.execTimeoutDefaultMs,
    execTimeoutCeilingMs: config.execTimeoutMaxMs,
    approvalSummaryTimeoutMs: config.approvalSummaryTimeoutMs,
    turnLeaseWaitMs: config.turnLeaseWaitMs,
    securityScreenTimeoutMs: config.securityScreenTimeoutMs,
    ...(securityScreener ? { securityScreener } : {}),
    backgroundJobTtlMs: config.backgroundJobTtlMs,
    backgroundJobTtlMaxMs: config.backgroundJobTtlMaxMs,
    ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
    ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
    ...(config.publicWebUrl ? { publicWebUrl: config.publicWebUrl } : {}),
    ...(config.publicUrl ? { webhookPublicUrl: config.publicUrl } : {}),
    memoryPolicy: { recall: config.memoryRecall, capture: config.memoryCapture },
    memoryStrategy,
    skills,
    skillBundles,
    skillsReady,
    advisoryLock,
    errors,
    metrics,
    ledger,
    turnStream,
    runActivity,
    runs,
    tasks,
    blobTransfer,
    livenessCache,
    deviceFlowCutover,
    featureFlags,
    credentialUsage,
    connectorStatusCache,
    resolveConnectorClient: resolveClient,
    ...(keychain ? { keychain } : {}),
    serviceCreds: credentialStore,
    deliveries,
    approvals,
    approvalGrants: artifactMap<CommandApprovalGrant>("approval_grants"),
    ...(processes ? { processes } : {}),
    monitors,
    crons,
    webhooks,
    resolveBaseModelId: () => orgBaseModelId() ?? fallback.modelId,
    ...(config.scratchExecEnabled ? { scratchExec: true } : {}),
    ...(config.sharedOwnerAuthIsolation ? { ownerAuthExec: true, sharedOwnerAuthIsolation: true } : {}),
    directory,
    isCurrentSharedScopeMember,
    managedGroups: projects,
    ...(config.reachExecEnabled ? { reachExec: true } : {}),
    ...(config.surfaceDebugFooter ? { surfaceDebugFooter: true } : {}),
    ...(config.eagerProvisionEnabled ? { eagerProvision: true } : {}),
    environments,
    credentialTools,
    brokeredTools,
    deploymentLayer,
    layerBrokerFor,
  };
  const orchestrator = createOrchestrator(orchestratorDeps);

  const uuidId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const recoveryAdminBase = config.publicWebUrl?.replace(/\/$/, "");
  const recoveryAdminUrlFor = recoveryAdminBase
    ? (sessionId: string): string | undefined =>
        uuidId.test(sessionId) ? adminSessionUrl(recoveryAdminBase, sessionId) : undefined
    : undefined;
  wireRunResultDeliveries(runs, deliveries, tasks, recoveryAdminUrlFor, sessions);
  const idempotency = createIdempotencyStore(artifactMap<IdempotencyRecord>("idempotency"));
  const skillFetcher = createGitFetcher(
    keychain
      ? {
          allowLocalRepos: !config.production,
          resolveAuth: (pack) =>
            resolvePackAuth(
              {
                serviceCredential: async (slug) => {
                  const record = await keychain.getServiceCredentialSecret(scopeId("org", config.orgId), slug);
                  return record && record.delivery !== "env" ? record : undefined;
                },
                connectorToken: async (host, principalId) =>
                  (await keychain.connectorAccessToken(host, principalId)) ?? undefined,
              },
              pack,
            ),
        }
      : { allowLocalRepos: !config.production },
  );
  const reaper: Reaper = createReaper(runs, sessions, {
    intervalMs: config.reaperIntervalMs,
    leaderLease,
    maxAgeMs: config.runMaxAgeMs,
    errors,
  });
  const engaged = createEngagedRegistry();
  let reapInFlight = false;
  let lastReapAt = 0;
  const REAP_POKE_COOLDOWN_MS = 1_000;
  const pokeReaper = (): void => {
    if (reapInFlight || Date.now() - lastReapAt < REAP_POKE_COOLDOWN_MS) return;
    reapInFlight = true;
    void leaderLease
      .hold(REAPER_LEASE_KEY, () => reaper.sweep())
      .catch(swallowAs("wake: reaper poke", null))
      .finally(() => {
        reapInFlight = false;
        lastReapAt = Date.now();
      });
  };
  const liveFallback = async (
    container: string,
    opts?: { limit?: number },
  ): Promise<Array<{
    container: string;
    ts: string;
    authorId?: string;
    authorName?: string;
    text: string;
    createdAt: number;
  }> | null> => {
    const puller = orchestratorDeps.surfaceContext;
    if (!puller) return null;
    const result = await puller.pull("slack", { conversationTarget: container, count: opts?.limit ?? 100 });
    if (!result) return null;
    return (result.messages as Array<Record<string, unknown>>).map((m) => ({
      container,
      ts: String(m.ts ?? ""),
      ...(m.authorId ? { authorId: String(m.authorId) } : {}),
      ...((m.author ?? m.authorName) ? { authorName: String(m.author ?? m.authorName) } : {}),
      text: String(m.text ?? ""),
      createdAt: Date.now(),
    }));
  };
  const surfaceCache: SurfaceCache = config.databaseUrl
    ? createPostgresSurfaceCache(config.databaseUrl, { liveFallback })
    : createMemorySurfaceCache({ liveFallback });
  const channelPolicy: ChannelPolicyStore = config.databaseUrl
    ? createPostgresChannelPolicyStore(config.databaseUrl)
    : createMemoryChannelPolicyStore();
  const ambientJudgments: AmbientJudgmentStore = config.databaseUrl
    ? createPostgresAmbientJudgmentStore(config.databaseUrl)
    : createMemoryAmbientJudgmentStore();
  const ackEmojiPicks: AckEmojiPickStore = config.databaseUrl
    ? createPostgresAckEmojiPickStore(config.databaseUrl)
    : createMemoryAckEmojiPickStore();
  const providerKeys = directProviderAvailability;
  const screenSecurity: SecurityScreenProbe | undefined = harness.models.screenSecurity
    ? ({ payload, harnessId, modelId, systemPrompt, actorId, scopeLabel, signal }) =>
        harness.models.screenSecurity!({
          payload,
          harnessId,
          modelId,
          systemPrompt,
          signal,
          recordModelCall: (rec) => {
            modelGateway.recordCall({ at: Date.now(), scopeLabel, ...rec });
            void budget?.record(actorId, estimateCostUsd(rec.inputTokens));
          },
        })
    : undefined;
  const app = createApp({
    identity,
    ...(config.publicWebUrl ? { publicWebUrl: config.publicWebUrl } : {}),
    sessions,
    orchestrator,
    runs,
    leaseTtlMs,
    maxAttempts,
    turnStream,
    runActivity,
    signals: runSignals,
    tasks,
    modelGateway,
    modelCredentials,
    userModelCredentials,
    modelRegistry,
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
    deliveries,
    directory,
    ...(config.emailAuthPrincipals?.length
      ? {
          emailAuthMembers: config.emailAuthPrincipals.map((principalId) => ({
            principalId,
            displayName: principalId,
            type: "internal" as const,
          })),
        }
      : {}),
    projects,
    environments,
    deploy: deployService,
    deploymentLayer,
    ...(processes ? { processes } : {}),
    monitors,
    sandbox,
    files,
    approvals,
    sessionStateBus,
    ledgerEventBus,
    contextRequests: artifactMap<SurfaceContextRequest>("context_requests"),
    engaged,
    reaperPoke: pokeReaper,
    surfaceCache,
    channelPolicy,
    ...(harness.models.judge ? { ambientJudge: (s: string, pr: string) => harness.models.judge!(s, pr) } : {}),
    ...(screenSecurity ? { screenSecurity } : {}),
    ambientCursors: artifactMap<{ lastJudgedTs: string; lastJudgedAt?: number }>("ambient_cursors"),
    ambientJudgments,
    ackEmojiPicks,
    judgeModelId,
    harnessId: config.harness,
    runtimeFallback: fallback,
    providerKeys,
    modelProviders: modelProviderAvailabilityFor(config.harness, providerKeys),
    runWaitMs: config.runWaitMs,
  });
  const inboxRealtime = createInboxRealtime({
    loops: loopStore,
    items: loopItems,
    requestFire: (loopId) => void loopFire.fire(loopId, `loop:${loopId}:slack-event:${Date.now()}`).catch(() => {}),
  });
  const slackCore = createSlackCoreClient({
    inboxEvent: (event) => inboxRealtime.onConversationEvent(event),
    app,
    leaderLease,
    stagedEnvelopes: artifactMap<StagedEnvelope>("slack_staged_envelopes"),
    config: configStore,
    runtimeFallback: fallback,
    blobTransfer,
    deliveries,
    errors,
    metrics,
    runs,
    turnStream,
    tasks,
    agentRequests: artifactMap<SlackAgentRequestContext>("slack_agent_requests"),
    ackPicks: ackEmojiPicks,
    ackModelId: () => auxiliaryModelForProvider("anthropic"),
    ...(config.brandingDefault ? { brandingDefault: config.brandingDefault } : {}),
    ...(harness.models.pickAckEmoji ? { pickAckEmoji: (t, c) => harness.models.pickAckEmoji!(t, c) } : {}),
  });
  runs.onTerminal((run) => {
    void runs
      .activeForThread(run.sessionId)
      .then((live) => {
        if (!live) engaged.settle(run.sessionId);
      })
      .catch(swallowAs("wake: settle on terminal", undefined));
  });
  runs.onTerminal((run) => {
    void app.replayOrphanedRunSignals(run.id).catch(swallowAs("wake: orphaned-signal replay", undefined));
  });
  runs.onTerminal((run) => {
    void (async () => {
      const uuid = (await sessions.getByThread(run.sessionId))?.id;
      const rows = uuid ? await approvals.entries() : [];
      const awaiting = rows.some(
        ([, r]) => r.sessionId === uuid && r.blocksInput !== false && actorAssertionActive(identity, r.request?.actor),
      );
      const participants = uuid ? await sessions.participantsOf(uuid) : [];
      if (await runs.activeForThread(run.sessionId)) return;
      sessionStateBus.emit({
        threadRef: run.sessionId,
        ...(uuid ? { sessionId: uuid } : {}),
        state: awaiting ? "awaiting_approval" : "idle",
        at: run.finishedAt ?? Date.now(),
        ...(participants.length ? { participants } : {}),
      });
    })().catch(swallowAs("session-state: terminal emit", undefined));
  });
  let lastSignalPrune = 0;
  const orphanedSignalSweeper = createSweeper(
    async () => {
      for (const runId of await runSignals.pendingRunIds()) {
        const run = await runs.get(runId);
        if (!run || isTerminal(run.status)) await app.replayOrphanedRunSignals(runId);
      }
      if (Date.now() - lastSignalPrune > 60 * 60_000) {
        lastSignalPrune = Date.now();
        await runSignals.prune(7 * 24 * 60 * 60_000);
      }
    },
    config.reaperIntervalMs,
    { label: "orphaned-signals" },
  );
  const wakeSweep: WakeSweep = createWakeSweep(
    {
      async engagedSessions() {
        return engaged.list();
      },
      async sweepSession(threadRef) {
        const live = await runs.activeForThread(threadRef);
        if (!live) {
          pokeReaper();
          engaged.settle(threadRef);
          return 1;
        }
        return 0;
      },
    },
    { intervalMs: config.reaperIntervalMs, leaderLease },
  );
  orchestratorDeps.surfaceContext = createSurfaceContextPuller(
    app,
    keychain
      ? {
          searchToken: async (source, viewer) =>
            source === "slack" && viewer
              ? ((await keychain.connectorAccessToken("slack.com", viewer, "personal")) ??
                (await keychain.connectorAccessToken("slack.com", viewer)) ??
                keychain.connectorAccessToken("slack.com", viewer, "company"))
              : null,
        }
      : {},
  );
  orchestratorDeps.channelPolicy = channelPolicy;
  orchestratorDeps.surfaceCache = surfaceCache;
  const askResolution = keychain
    ? (ask: KeychainAsk, grant?: KeychainGrant) =>
        fireAskResolution(
          {
            deliveries,
            idempotency,
            identity,
            run: (req) => app.turn(req),
            directory,
            getAsk: (id) => keychain.getAsk(id),
            getGrant: (id) => keychain.getGrant(id),
          },
          ask,
          grant,
        )
    : undefined;
  const dropResolution = keychain
    ? (drop: DropResolution) =>
        fireDropResolution({ deliveries, idempotency, identity, run: (req) => app.turn(req), directory }, drop)
    : undefined;
  const loopFire: LoopFireService = createLoopFireService({
    loops: loopStore,
    items: loopItems,
    outputs: loopOutputs,
    grants: loopGrants,
    trigger: {
      deliveries,
      idempotency,
      identity,
      run: (req) => app.turn(req),
      directory,
      currentScopeMembers,
      sessions,
    },
  });
  const loops: LoopServiceDeps = {
    store: loopStore,
    items: loopItems,
    outputs: loopOutputs,
    grants: loopGrants,
    fire: loopFire,
    crons,
    config: configStore,
  };
  const sweepAsks =
    keychain && askResolution ? createAskExpirySweep({ keychain, fire: askResolution, auditLog }) : undefined;
  const scheduler = createScheduler({
    crons,
    deliveries,
    idempotency,
    identity,
    run: (req) => app.turn(req),
    leaderLease,
    directory,
    currentScopeMembers,
    sessions,
    fireLoop: (loopId, fireKey) => loopFire.fire(loopId, fireKey),
    ...(config.databaseUrl
      ? { jobQueue: createPgBossCronQueue(config.databaseUrl, undefined, config.cronFireConcurrency) }
      : {}),
    sweepAsks: async (now) => {
      await Promise.all([sweepAsks?.(now), loopFire.sweepStale(now)]);
    },
  });
  cronChanged.notify = (id) => scheduler.notifyChanged(id);
  orchestratorDeps.control = createControlService(app, scheduler, admin);
  orchestratorDeps.runtime = createRuntimeService(
    {
      config: configStore,
      harnessId: fallbackHarness,
      baseModelDefault: fallback.modelId,
      providerKeys: providerKeysPresent(config),
      modelCredentials,
      modelCredentialFetch: overrides.modelCredentialFetch,
      refreshModels,
    },
    app,
  );
  const monitorPoller: MonitorPoller | null =
    processes && supportsProcessSessions(sandbox)
      ? createMonitorPoller({
          monitors,
          processes,
          sandbox,
          deliveries,
          idempotency,
          identity,
          run: (req) => app.turn(req),
          directory,
          currentScopeMembers,
          sessions,
          leaderLease,
          heartbeatMs: config.monitorHeartbeatMs,
        })
      : null;
  const skillSyncEngine = createSkillSyncEngine({
    packs: skillPacks,
    fetcher: skillFetcher,
    reconcile: (id) => app.syncSkillPack(id),
    leaderLease,
  });
  const webhookReceiver = createWebhookReceiver({
    webhooks,
    deliveries,
    idempotency,
    identity,
    run: (req) => app.turn(req),
    directory,
    currentScopeMembers,
  });
  const instanceRegistry: InstanceRegistry =
    config.buildSha && pgArtifactMap
      ? createPostgresInstanceRegistry(pgArtifactMap.pool, {
          instanceId: randomUUID(),
          buildSha: config.buildSha,
          startedAt: Date.now(),
        })
      : createNoopInstanceRegistry();
  const taskProtection: TaskProtection | null =
    config.ecsTaskProtection && config.ecsAgentUri ? createEcsTaskProtection(config.ecsAgentUri) : null;
  const drain: DrainController = createDrainController({
    registry: instanceRegistry,
    protection: taskProtection,
    busy: () => workers.some((w) => w.busy()),
  });
  const workers: Worker[] = Array.from({ length: Math.max(1, config.workers) }, () =>
    createWorker({
      runs,
      sessions,
      orchestrator,
      leaseTtlMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      errors,
      pollMs: 250,
      canClaim: () => drain.canClaim(),
      onClaimed: () => drain.noteBusy(),
    }),
  );
  const processReaper: ProcessReaper | null = processes
    ? createProcessReaper(processes, {
        intervalMs: config.processReaperIntervalMs,
        ...(supportsProcessSessions(sandbox) ? { kill: createReaperKillHook(sandbox) } : {}),
        leaderLease,
      })
    : null;
  const MONITOR_RETENTION_SWEEP_MS = 24 * 60 * 60_000;
  const monitorRetentionSweeper = createSweeper(
    () => leaderLease.hold("monitor:retention:sweep", () => monitors.deleteDefunct(Date.now())),
    MONITOR_RETENTION_SWEEP_MS,
    { label: "monitor-retention", immediate: true },
  );
  const deployIdleTtlMs = deployProvider.profile.managedScaleToZero ? undefined : config.deployIdleTtlMs;
  const BLOB_TTL_MS = 6 * 60 * 60_000;
  const blobSweeper = createSweeper(() => blobTransfer.sweep(BLOB_TTL_MS), 30 * 60_000);
  const BLOB_TRANSFER_EXPIRY_DAYS = 1;
  void blobTransfer
    .ensureExpiry?.(BLOB_TRANSFER_EXPIRY_DAYS)
    .catch((e) =>
      console.error("[blob-transfer] S3 lifecycle expiry install failed (sweep remains the fallback):", errMessage(e)),
    );
  const idleSweeper =
    deployIdleTtlMs && deployIdleTtlMs > 0
      ? createSweeper(() => app.reapIdleDeployments(deployIdleTtlMs), Math.max(5_000, Math.floor(deployIdleTtlMs / 4)))
      : null;
  const KEEP_WARM_INTERVAL_MS = 5 * 60_000;
  const keepWarmSweeper = createSweeper(() => app.keepAlwaysOnWarm(), KEEP_WARM_INTERVAL_MS);
  const deepIdleMachineMs = config.deepIdleMachineMs;
  const devIdleMachineMs = config.devIdleMachineMs;
  const sweepFractions = [deepIdleMachineMs, devIdleMachineMs]
    .filter((w): w is number => !!w && w > 0)
    .map((w) => Math.floor(w / 24));
  const deepIdleReapEnabled = Boolean(sandbox.reapDeepIdle && sweepFractions.length);
  const deepIdleSweeper = deepIdleReapEnabled
    ? createSweeper(
        () =>
          leaderLease.hold("sandbox:deep-idle-reaper", () =>
            sandbox.reapDeepIdle!(deepIdleMachineMs, devIdleMachineMs),
          ),
        Math.max(60_000, Math.min(...sweepFractions)),
        { immediate: true },
      )
    : null;
  const runtime: Runtime = {
    start() {
      if (!config.backgroundWorkEnabled) return;
      for (const w of workers) w.start();
      reaper.start();
      processReaper?.start();
      monitorPoller?.start(config.monitorPollMs);
      monitorRetentionSweeper.start();
      if (config.skillSyncPollMs > 0) skillSyncEngine.start(config.skillSyncPollMs);
      blobSweeper.start();
      fileUploads?.start();
      idleSweeper?.start();
      keepWarmSweeper.start();
      deepIdleSweeper?.start();
      wakeSweep.start();
      orphanedSignalSweeper.start();
      drain.start();
    },
    async releaseInFlightRuns() {
      await Promise.all(workers.map((w) => w.releaseInFlight()));
    },
    async stop() {
      reaper.stop();
      processReaper?.stop();
      monitorPoller?.stop();
      monitorRetentionSweeper.stop();
      skillSyncEngine.stop();
      idleSweeper?.stop();
      keepWarmSweeper.stop();
      deepIdleSweeper?.stop();
      blobSweeper.stop();
      fileUploads?.stop();
      wakeSweep.stop();
      orphanedSignalSweeper.stop();
      await Promise.all(workers.map((w) => w.stop(config.shutdownDrainMs))).catch(
        swallowAs("wiring: worker drain failed", undefined),
      );
      await Promise.all(workers.map((w) => w.releaseInFlight()));
      drain.stop();
      runs.close?.();
      void runSignals.close?.();
      void sessionStateBus.close?.();
      void ledgerEventBus.close?.();
      void runActivity.close?.();
      await harness.turns.close?.();
      await tasks.close?.();
    },
  };

  return {
    app,
    ...(screenSecurity ? { screenSecurity } : {}),
    deploymentLayer,
    deploymentLayerStore,
    credentialTools,
    brokeredTools,
    deploymentLayerReady,
    deploymentLayerRefresh,
    sessions,
    runs,
    signals: runSignals,
    tasks,
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
    modelGateway,
    modelCredentials,
    userModelCredentials,
    modelRegistry,
    modelVerifier,
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
    loops,
    webhookReceiver,
    admin,
    rateLimiter,
    errors,
    metrics,
    crons,
    credentialUsage,
    egressAudit,
    identity,
    workspace,
    memory,
    ...(keychain ? { keychain } : {}),
    serviceCreds: credentialStore,
    deliveries,
    ...(askResolution ? { fireAskResolution: askResolution } : {}),
    ...(dropResolution ? { fireDropResolution: dropResolution } : {}),
    sandbox,
    sandboxMigration,
    sandboxResources,
    advisoryLock,
    blobTransfer,
    files,
    ...(fileUploads ? { fileUploads } : {}),
    livenessCache,
    deviceFlowCutover,
    featureFlags,
    ...(replayDedupe ? { replayDedupe } : {}),
    ...(brokerSessions ? { brokerSessions } : {}),
    directory,
    projects,
    environments,
    ...(processes ? { processes } : {}),
    monitors,
    ...(browserSessionStore ? { browserSessionStore } : {}),
    ...(monitorPoller ? { monitorPoller } : {}),
    ...(ambientJudgments ? { ambientJudgments } : {}),
    ...(ackEmojiPicks ? { ackEmojiPicks } : {}),
    channelPolicy,
    uiState: artifactMap<PersistedUiState>("web_ui_state"),
    sessionShares: artifactMap<SessionShare>("session_shares"),
    sessionShareBytes:
      config.snapshotStore === "s3" && config.s3Bucket
        ? createS3DurableByteStore({
            bucket: config.s3Bucket,
            ...(config.s3Region ? { region: config.s3Region } : {}),
            prefix: `${config.s3Prefix ?? ""}session-shares/`,
          })
        : createLocalDurableByteStore(join(config.dataDir, "session-shares")),
    skillSyncEngine,
    slackCore,
  };
}

export function serverDeps(
  config: Config,
  built: BuiltApp,
  slackEnvironmentState: "absent" | "configured" | "partial" = "absent",
  slackEnvBotToken?: string,
): Omit<ServerDeps, "control"> {
  const configuredModel = configuredModelForHarness(config, config.harness);
  const carriedModelAuth = harnessCarriedModelAuth(config);
  return {
    production: config.production,
    allowUnauthenticatedCore: config.allowUnauthenticatedCore,
    ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
    ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
    ...(config.portalIdentitySecret ? { portalIdentitySecret: config.portalIdentitySecret } : {}),
    ...(config.requireSignedPortalIdentity ? { requireSignedPortalIdentity: true } : {}),
    ...(built.replayDedupe ? { replayDedupe: built.replayDedupe } : {}),
    ...(built.brokerSessions ? { brokerSessions: built.brokerSessions } : {}),
    config: built.config,
    ...(built.screenSecurity ? { screenSecurity: built.screenSecurity } : {}),
    ...(configuredModel ? { baseModelDefault: configuredModel } : {}),
    modelProviders: modelProviderAvailabilityFor(config.harness, providerKeysPresent(config)),
    providerKeys: providerKeysPresent(config),
    modelCredentials: built.modelCredentials,
    userModelCredentials: built.userModelCredentials,
    modelRegistry: built.modelRegistry,
    modelVerifier: built.modelVerifier,
    refreshModels: built.refreshModels,
    customProviders: built.customProviders,
    refreshCustomProviders: built.refreshCustomProviders,
    mcpServers: built.mcpServers,
    mcpToolService: built.mcpToolService,
    ...(config.brandingDefault ? { brandingDefault: config.brandingDefault } : {}),
    ...(carriedModelAuth ? { harnessCarriedModelAuth: carriedModelAuth } : {}),
    harnessId: config.harness,
    connectorTokens: built.connectorTokens,
    slackInstallation: built.slackInstallation,
    slackEnvironmentState,
    ...(config.slackEventsPort ? { slackEventsPort: config.slackEventsPort } : {}),
    ...(slackEnvBotToken ? { slackEnvBotToken } : {}),
    resolveClient: built.resolveClient,
    consentLinks: built.consentLinks,
    oauthFlows: built.oauthFlows,
    secretDrops: built.secretDrops,
    ...(built.fireDropResolution ? { fireDropResolution: built.fireDropResolution } : {}),
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
    ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
    ...(config.publicWebUrl ? { portalUrl: config.publicWebUrl } : {}),
    admin: built.admin,
    ...(config.emailAuthPrincipals ? { emailAuthPrincipals: config.emailAuthPrincipals } : {}),
    ...(config.emailAuthDomain ? { emailAuthDomain: config.emailAuthDomain } : {}),
    ...(config.resendApiKey && config.emailFrom
      ? { inviteMailer: createResendMailer(config.resendApiKey, config.emailFrom) }
      : {}),
    rateLimiter: built.rateLimiter,
    acl: built.acl,
    credentialUsage: built.credentialUsage,
    deviceFlowCutover: built.deviceFlowCutover,
    featureFlags: built.featureFlags,
    egressAudit: built.egressAudit,
    sessions: built.sessions,
    auditLog: built.auditLog,
    errors: built.errors,
    metrics: built.metrics,
    crons: built.crons,
    loops: built.loops,
    credentialServices: () => built.credentialTools.map((tool) => tool.service),
    deploymentLayer: built.deploymentLayerStore,
    deployDialTimeoutMs: config.deployDialTimeoutMs,
    ...(config.awsDeploy.appsDomain ? { deployAppsDomain: config.awsDeploy.appsDomain } : {}),
    ...(config.awsDeploy.gateSecret ? { deployGateSecret: config.awsDeploy.gateSecret } : {}),
    ...(config.deployAppsSessionSecret ? { deployAppsSessionSecret: config.deployAppsSessionSecret } : {}),
    ...(config.deployAppsLoginUrl ? { deployAppsLoginUrl: config.deployAppsLoginUrl } : {}),
    scheduler: built.scheduler,
    webhookReceiver: built.webhookReceiver,
    identity: built.identity,
    ...(built.keychain ? { keychain: built.keychain } : {}),
    serviceCreds: built.serviceCreds,
    deliveries: built.deliveries,
    ...(built.fireAskResolution ? { fireAskResolution: built.fireAskResolution } : {}),
    runs: built.runs,
    signals: built.signals,
    workspace: built.workspace,
    files: built.files,
    ...(built.fileUploads ? { fileUploads: built.fileUploads } : {}),
    filesDirectUploadsEnabled: config.filesDirectUploadsEnabled,
    memory: built.memory,
    blobTransfer: built.blobTransfer,
    sandboxBackend: built.sandbox.profile.backend,
    egressDeclaredEnforcement: built.sandbox.profile.egressEnforcement ?? "none",
    egressEnforcement: effectiveEgressEnforcement(built.sandbox.profile, {
      signingSecret: config.signingSecret,
      apiBaseUrl: config.apiBaseUrl,
    }),
    egressControlPlaneConfigured: Boolean(config.signingSecret && config.apiBaseUrl),
    sandbox: built.sandbox,
    advisoryLock: built.advisoryLock,
    ...(built.processes ? { processes: built.processes } : {}),
    ...(built.browserSessionStore ? { browserSessionStore: built.browserSessionStore } : {}),
    directory: built.directory,
    ...(built.ambientJudgments ? { ambientJudgments: built.ambientJudgments } : {}),
    ...(built.ackEmojiPicks ? { ackEmojiPicks: built.ackEmojiPicks } : {}),
    channelPolicy: built.channelPolicy,
    uiState: built.uiState,
    ...(built.keychain ? { loopSourceTokens: built.keychain } : {}),
    loopSlackClient: slackUserClientFactory(config.slack?.apiUrl),
    sessionShares: built.sessionShares,
    sessionShareBytes: built.sessionShareBytes,
    environments: built.environments,
    sandboxMigration: built.sandboxMigration,
    sandboxResources: built.sandboxResources,
  };
}
