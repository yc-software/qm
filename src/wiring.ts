import { mkdirSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { baseModelProviders, configuredModelForHarness, providerKeysPresent, type Config } from "./config.ts";
import type { ServerDeps } from "./api/deps.ts";
import { createIdentityService, type DeactivationRecord, type IdentityService } from "./identity/identity-service.ts";
import {
  createMemoryConfigStore,
  type ScopedConfigStore,
  type PersistedSoul,
  type PersistedSoulRevision,
  type PersistedCommandPolicy,
  type PersistedSecurityPosture,
  type PersistedApprovalGrantModes,
  type PersistedEgressPolicy,
  type PersistedScopedFlag,
  type PersistedBaseModel,
  type PersistedApprovedHarnesses,
  type PersistedWebuiModels,
  type PersistedPeopleDirectoryUrl,
  type PersistedAckEmoji,
  type PersistedBranding,
  type PersistedBrowseMaxSteps,
  type PersistedBrowseModel,
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
import { configurePgCaTrust } from "./persistence/pg-pool.ts";
import { createPostgresLeaderLease, createNoopLeaderLease, type LeaderLease } from "./persistence/leader-lease.ts";
import {
  createMemoryAdvisoryLock,
  createPostgresAdvisoryLock,
  type AdvisoryLock,
} from "./persistence/advisory-lock.ts";
import type {
  CommandApprovalGrant,
  Cron,
  Monitor,
  PendingApprovalRecord,
  ScopeId,
  SurfaceContextRequest,
  Webhook,
} from "./types.ts";
import { scopeId } from "./types.ts";
import { createAuditLog, type AuditLog } from "./audit/audit-log.ts";
import { createPostgresAuditLog } from "./admin/postgres-audit-log.ts";
import { createRateLimiter, type RateLimiter } from "./ratelimit/rate-limiter.ts";
import { createPostgresRateLimiter } from "./ratelimit/postgres-rate-limiter.ts";
import { createBudgetTracker } from "./ratelimit/budget.ts";
import { createPostgresBudgetTracker } from "./ratelimit/postgres-budget.ts";
import { createCronStore, type CronStore } from "./cron/cron-store.ts";
import { createDeliveryStore, type DeliveryStore } from "./delivery/delivery-store.ts";
import { createPostgresDeliveryStore } from "./delivery/postgres-delivery-store.ts";
import { wireRunResultDeliveries } from "./delivery/run-result-delivery.ts";
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
import { createWebhookStore, disableLegacyWebhookRows } from "./webhooks/webhook-store.ts";
import { createWebhookReceiver, type WebhookReceiver } from "./webhooks/webhook-receiver.ts";
import { createDeployStore, type Deployment } from "./deploy/deploy-store.ts";
import { createDockerDeployProvider } from "./deploy/docker-deploy-provider.ts";
import { createAwsDeployProvider, type StoredDeployBody } from "./deploy/aws-deploy-provider.ts";
import { createFlyDeployProvider } from "./deploy/fly-deploy-provider.ts";
import type { DeployProvider } from "./deploy/deploy-provider.ts";
import { createDeployService } from "./deploy/deploy-service.ts";
import {
  createCanReadScope,
  createCanManageScope,
  createCanWriteScope,
  createCurrentScopeMembers,
  createManagesArtifactHome,
  type CanReadScope,
  type CanManageScope,
  type ManagesArtifactHome,
} from "./resolution/scope-membership.ts";
import type { DeployGitArchive } from "./deploy/deploy-git-store.ts";
import { createLocalWorkspaceStore, type WorkspaceStore } from "./workspace/workspace-store.ts";
import { createMemoryService, type MemoryService } from "./memory/memory-service.ts";
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
import { createLocalSandbox } from "./sandbox/local-sandbox.ts";
import { createSpritesSandbox } from "./sandbox/sprites-sandbox.ts";
import { createSmolmachinesSandbox } from "./sandbox/smolmachines-sandbox.ts";
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
import { makeRefresh, type OAuthClientResolver } from "./connectors/oauth.ts";
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
import { createModelGateway, type ModelGateway } from "./model/model-gateway.ts";
import { createModelCredentialStore, type ModelCredentialStore } from "./model/model-credential-store.ts";
import { setProviderBaseUrls } from "./model/provider-endpoints.ts";
import { setCustomProviders } from "./model/custom-providers.ts";
import { createCustomProviderStore, type CustomProviderStore } from "./model/custom-provider-store.ts";
import { createMemorySessionStore } from "./sessions/memory-session-store.ts";
import { createPostgresSessionStore } from "./sessions/postgres-session-store.ts";
import type { SessionStore } from "./sessions/session-store.ts";
import { createMockHarness } from "./harness/mock-harness.ts";
import { createOpenCodeHarness, openCodeHarnessConfigOptions } from "./harness/opencode-harness.ts";
import { createCodexHarness, codexHarnessConfigOptions } from "./harness/codex-harness.ts";
import { createClaudeHarness, claudeHarnessConfigOptions } from "./harness/claude-harness.ts";
import { createPiHarness, piHarnessConfigOptions } from "./harness/pi-harness.ts";
import { createHarnessRouter, resolveRuntimeChoiceDurable } from "./harness/harness-router.ts";
import type { Harness } from "./harness/harness.ts";
import { createSecurityScreenProxy, type SecurityScreener } from "./security/security-screener.ts";
import { createMemoryTaskStore } from "./tasks/memory-task-store.ts";
import { createPostgresTaskStore } from "./tasks/postgres-task-store.ts";
import type { TaskStore } from "./tasks/task-store.ts";
import { createMemoryStrategy } from "./memory/strategy.ts";
import { createOrchestrator, egressClaimAllowingControlPlane, type OrchestratorDeps } from "./core/orchestrator.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, EGRESS_PROXY_AUD } from "./auth/capability-token.ts";
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
import { createReachDeniedNotifier, type ReachDeniedCursor } from "./insights/reach-denied-notifier.ts";
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
import { createSlackCoreClient, type SlackCoreClient } from "./api/slack-core-client.ts";
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
  type HarnessId,
} from "./model/pi-models.ts";
import { createAdminService, bootAdminGrantSeed, type AdminService } from "./admin/admin-service.ts";
import { createAdminGrantStore, createMapAdminGrantPersistence, type AdminGrant } from "./admin/admin-grant-store.ts";
import { createPostgresAdminGrantStore } from "./admin/postgres-admin-grant-store.ts";
import { createProjectStore, type Project, type ProjectStore } from "./projects/project-store.ts";
import { createErrorLog, type ErrorLog } from "./admin/error-log.ts";
import { createMemoryReplayDedupe, createPostgresReplayDedupe, type ReplayDedupe } from "./auth/replay-dedupe.ts";
import { createAwsRoleBroker, type AwsRoleBroker } from "./auth/aws-role-broker.ts";
import {
  emptyDeploymentLayer,
  loadDeploymentLayer,
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
  deploymentLayer: DeploymentLayerRuntime;
  brokeredTools: readonly BrokeredLayerTool[];
  deploymentLayerStore: DeploymentLayerStore;
  deploymentLayerReady: Promise<unknown>;
  deploymentLayerRefresh: Sweeper;
  sessions: SessionStore;
  runs: RunStore;
  signals: RunSignalStore;
  tasks: TaskStore;
  sessionStateBus: SessionStateBus;
  runtime: Runtime;
  config: ScopedConfigStore;
  connectorTokens: ConnectorTokenStore;
  slackInstallation: SlackInstallationStore;
  resolveClient: OAuthClientResolver;
  consentLinks: ConsentLinkStore;
  secretDrops: SecretDropStore;
  modelGateway: ModelGateway;
  modelCredentials: ModelCredentialStore;
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
  blobTransfer: BlobTransferStore;
  files: FileArtifactStore;
  livenessCache: LivenessCache;
  deviceFlowCutover: DeviceFlowCutoverStore;
  replayDedupe?: ReplayDedupe;
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
  skillSyncEngine: SkillSyncEngine;
  slackCore: SlackCoreClient;
}

export function buildApp(
  config: Config,
  overrides: {
    securityScreener?: SecurityScreener;
    credentialBrokers?: Record<string, AwsRoleBroker>;
    modelCredentialFetch?: typeof fetch;
  } = {},
): BuiltApp {
  if (config.databaseUrl && !config.connectorSecretKey) {
    throw new Error("CONNECTOR_SECRET_KEY is required with durable storage");
  }
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
  const modelCredentials = createModelCredentialStore({
    backing: artifactMap("model_credentials"),
    keyMaterial: config.connectorSecretKey ?? randomBytes(32),
    fallback: {
      ...(config.anthropicApiKey ? { anthropic: config.anthropicApiKey } : {}),
      ...(config.openaiApiKey ? { openai: config.openaiApiKey } : {}),
      ...(config.openrouterApiKey ? { openrouter: config.openrouterApiKey } : {}),
    },
  });
  const identity = createIdentityService(artifactMap<DeactivationRecord>("deactivated_principals"));
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
    approvalGrantModes: artifactMap<PersistedApprovalGrantModes>("approval_grant_modes"),
    egressPolicies: artifactMap<PersistedEgressPolicy>("egress_policies"),
    unfulfilledInsights: artifactMap<PersistedScopedFlag>("unfulfilled_insights_flag"),
    externalSlackParticipants: artifactMap<PersistedScopedFlag>("external_slack_participants_flag"),
    channelHeaderPin: artifactMap<PersistedScopedFlag>("channel_header_pin_flag"),
    baseModels: artifactMap<PersistedBaseModel>("base_model_configs"),
    approvedHarnesses: artifactMap<PersistedApprovedHarnesses>("approved_harness_configs"),
    orgAmbient: artifactMap<PersistedScopedFlag>("org_ambient_flag"),
    interactiveFastMode: artifactMap<PersistedScopedFlag>("interactive_fast_mode_flag"),
    webuiModels: artifactMap<PersistedWebuiModels>("webui_model_configs"),
    peopleDirectoryUrls: artifactMap<PersistedPeopleDirectoryUrl>("people_directory_urls"),
    ackEmoji: artifactMap<PersistedAckEmoji>("ack_emoji"),
    branding: artifactMap<PersistedBranding>("branding_configs"),
    browseMaxSteps: artifactMap<PersistedBrowseMaxSteps>("browse_max_steps_configs"),
    browseModels: artifactMap<PersistedBrowseModel>("browse_model_configs"),
    turnWallClocks: artifactMap<PersistedTurnWallClock>("turn_wall_clock_configs"),
    deploymentIdentity: artifactMap<PersistedDeploymentIdentity>("deployment_identity"),
    defaultSecurityPosture: config.securityPosture,
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
  const baseMemory: MemoryService = config.databaseUrl
    ? createPostgresMemoryService(config.databaseUrl)
    : createMemoryService(workspace);
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
      store: artifactMap<StoredMicrovm>("aws_sandbox_bodies"),
      onError: sandboxOnError,
    });
  };
  const buildBackend: Record<Config["sandboxBackend"], () => Sandbox> = {
    local: buildLocal,
    sprites: buildSprites,
    smolmachines: buildSmolmachines,
    aws: buildAws,
  };
  const sandboxBackends: Partial<Record<SandboxBackendName, Sandbox>> = {
    [config.sandboxBackend]: buildBackend[config.sandboxBackend](),
  };
  if (config.sandboxSecondaryBackend && config.sandboxSecondaryBackend !== config.sandboxBackend) {
    sandboxBackends[config.sandboxSecondaryBackend] = buildBackend[config.sandboxSecondaryBackend]();
  }
  const sandboxRoutes = artifactMap<SandboxRoute>("sandbox_routing");
  const sandbox: Sandbox = createSandboxRouter({
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
    refreshConnector: makeRefresh({ resolveClient }),
  });
  const keychain: Keychain | undefined = keychainKeyMaterial ? credentialStore : undefined;
  const browserSessionStore: BrowserSessionStore | undefined = keychainKeyMaterial
    ? createBrowserSessionStore({ sessions: artifactMap<StoredBrowserSession>("browser_sessions"), key: credentialKey })
    : undefined;
  const connectorTokens = withOperatorTokenFallback(credentialStore, config.egressServiceHosts ?? [], secretSource);
  const consentLinks: ConsentLinkStore = createConsentLinkStore(artifactMap<ConsentLinkRecord>("consent_links"));
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
  const runStoreKind = config.runStore;
  const runSignals: RunSignalStore =
    runStoreKind === "postgres"
      ? createPostgresRunSignalStore(requireDbUrl("RUN_STORE"))
      : createMemoryRunSignalStore();
  const tasks = config.databaseUrl ? createPostgresTaskStore(config.databaseUrl) : createMemoryTaskStore();
  const customProviders = createCustomProviderStore({
    backing: artifactMap("custom_model_providers"),
    keyMaterial: config.connectorSecretKey ?? randomBytes(32),
  });
  const refreshCustomProviders = async () => {
    setCustomProviders(await customProviders.enabled());
  };
  void refreshCustomProviders().catch((e) =>
    console.error("[wiring] custom provider hydration failed:", errMessage(e)),
  );
  const resolveModelProviderKeys = async () => {
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
    ["codex", createCodexHarness({ ...codexHarnessConfigOptions(config), signals: runSignals, tasks, mcpTools })],
    ["claude", createClaudeHarness({ ...claudeHarnessConfigOptions(config), signals: runSignals, tasks, mcpTools })],
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
  const harness = createHarnessRouter(adapters, adapters.get(fallbackHarness)!, (input) =>
    resolveRuntimeChoiceDurable(configStore, runtimeOrgScope, input.scopeLabel, fallback, {
      ...(input.harness ? { harnessId: input.harness as HarnessId } : {}),
      ...(input.model ? { modelId: input.model } : {}),
    }),
  );

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
  const runActivity: RunActivityStore =
    runStoreKind === "postgres"
      ? createPostgresRunActivityStore(requireDbUrl("RUN_STORE"))
      : createMemoryRunActivityStore();
  const deployStore = createDeployStore({
    deployments: artifactMap<Deployment>("deployments"),
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
  const deployProvider: DeployProvider = ((): DeployProvider => {
    if (config.deployProvider === "aws")
      return createAwsDeployProvider({
        ...config.awsDeploy,
        ...(!config.awsDeploy.dataBucket && config.awsSandbox.s3Bucket
          ? { dataBucket: config.awsSandbox.s3Bucket }
          : {}),
        advisoryLock,
        store: artifactMap<StoredDeployBody>("aws_deploy_bodies"),
      });
    if (config.deployProvider === "fly") return createFlyDeployProvider(config.flyDeploy);
    return createDockerDeployProvider();
  })();
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
  membership.canReadScope = canReadScope;
  membership.canManageScope = canManageScope;
  membership.managesArtifactHome = managesArtifactHome;
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
  });
  const environments = config.databaseUrl
    ? createPostgresEnvironmentStore(config.databaseUrl)
    : createMemoryEnvironmentStore();
  const monitors = createMonitorStore(artifactMap<Monitor>("monitors"));
  const cronChanged: { notify?: (id: string) => void } = {};
  const cronsBase = createCronStore(artifactMap<Cron>("crons"));
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
  if (pgArtifactMap)
    void disableLegacyWebhookRows(pgArtifactMap.pool).catch(swallowAs("wiring: legacy webhook sweep", undefined));
  const deliveries = config.databaseUrl ? createPostgresDeliveryStore(config.databaseUrl) : createDeliveryStore();
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
  const orchestratorDeps: OrchestratorDeps = {
    identity,
    resolution,
    config: configStore,
    ...(config.brandingDefault ? { brandingDefault: config.brandingDefault } : {}),
    sessionTapeMode: config.sessionTapeMode,
    sessions,
    workspace,
    files,
    sandbox,
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
    ...(config.maxContextEntries !== undefined ? { maxContextEntries: config.maxContextEntries } : {}),
    ...(config.maxContextTokens !== undefined ? { maxContextTokens: config.maxContextTokens } : {}),
    execTimeoutMs: config.execTimeoutDefaultMs,
    execTimeoutCeilingMs: config.execTimeoutMaxMs,
    approvalSummaryTimeoutMs: config.approvalSummaryTimeoutMs,
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
    managedGroups: projects,
    ...(config.reachExecEnabled ? { reachExec: true } : {}),
    ...(config.surfaceDebugFooter ? { surfaceDebugFooter: true } : {}),
    ...(config.eagerProvisionEnabled ? { eagerProvision: true } : {}),
    environments,
    layerBrokerFor,
    brokeredTools,
    deploymentLayer,
  };
  const orchestrator = createOrchestrator(orchestratorDeps);

  wireRunResultDeliveries(runs, deliveries, tasks);
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
  const providerKeys = providerKeysPresent(config);
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
    contextRequests: artifactMap<SurfaceContextRequest>("context_requests"),
    engaged,
    reaperPoke: pokeReaper,
    surfaceCache,
    channelPolicy,
    ...(harness.models.judge ? { ambientJudge: (s: string, pr: string) => harness.models.judge!(s, pr) } : {}),
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
  const slackCore = createSlackCoreClient({
    app,
    config: configStore,
    runtimeFallback: fallback,
    blobTransfer,
    deliveries,
    metrics,
    runs,
    turnStream,
    tasks,
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
      const awaiting = rows.some(([, r]) => r.sessionId === uuid && r.blocksInput !== false);
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
    ...(config.databaseUrl
      ? { jobQueue: createPgBossCronQueue(config.databaseUrl, undefined, config.cronFireConcurrency) }
      : {}),
    ...(keychain && askResolution
      ? { sweepAsks: createAskExpirySweep({ keychain, fire: askResolution, auditLog }) }
      : {}),
  });
  cronChanged.notify = (id) => scheduler.notifyChanged(id);
  orchestratorDeps.control = createControlService(app, scheduler, admin);
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
  const reachDeniedNotifier: Sweeper | undefined = config.reachDeniedNotifyChannel
    ? createReachDeniedNotifier({
        auditLog,
        cursors: artifactMap<ReachDeniedCursor>("insight_cursors"),
        leaderLease,
        notify: async (e) => {
          const channel = config.reachDeniedNotifyChannel!;
          const who = e.principalId;
          const app = e.resource;
          const url = config.publicWebUrl ? ` — ${config.publicWebUrl.replace(/\/$/, "")}/d/${app}/` : "";
          await deliveries.enqueue({
            destination: { type: "slack", target: channel, audienceScopeId: scopeId("channel", channel) },
            text: `:no_entry: ${who} was denied reach to app \`${app}\`${url}. The owner (or an operator) can grant read if they should have it.`,
            idempotencyKey: `reach-denied:${who}|${app}|${Math.floor(e.at / 3_600_000)}`,
          });
        },
      })
    : undefined;
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
      if (config.skillSyncPollMs > 0) skillSyncEngine.start(config.skillSyncPollMs);
      blobSweeper.start();
      idleSweeper?.start();
      deepIdleSweeper?.start();
      reachDeniedNotifier?.start(config.insightsIntervalMs);
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
      skillSyncEngine.stop();
      idleSweeper?.stop();
      deepIdleSweeper?.stop();
      reachDeniedNotifier?.stop();
      blobSweeper.stop();
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
      void runActivity.close?.();
      await harness.turns.close?.();
      await tasks.close?.();
    },
  };

  return {
    app,
    deploymentLayer,
    deploymentLayerStore,
    brokeredTools,
    deploymentLayerReady,
    deploymentLayerRefresh,
    sessions,
    runs,
    signals: runSignals,
    tasks,
    sessionStateBus,
    runtime,
    config: configStore,
    connectorTokens,
    slackInstallation,
    resolveClient,
    consentLinks,
    secretDrops,
    modelGateway,
    modelCredentials,
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
    advisoryLock,
    blobTransfer,
    files,
    livenessCache,
    deviceFlowCutover,
    ...(replayDedupe ? { replayDedupe } : {}),
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
  return {
    production: config.production,
    allowUnauthenticatedCore: config.allowUnauthenticatedCore,
    ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
    ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
    ...(config.portalIdentitySecret ? { portalIdentitySecret: config.portalIdentitySecret } : {}),
    ...(config.requireSignedPortalIdentity ? { requireSignedPortalIdentity: true } : {}),
    ...(built.replayDedupe ? { replayDedupe: built.replayDedupe } : {}),
    config: built.config,
    ...(configuredModel ? { baseModelDefault: configuredModel } : {}),
    modelProviders: modelProviderAvailabilityFor(config.harness, providerKeysPresent(config)),
    providerKeys: providerKeysPresent(config),
    modelCredentials: built.modelCredentials,
    customProviders: built.customProviders,
    refreshCustomProviders: built.refreshCustomProviders,
    mcpServers: built.mcpServers,
    mcpToolService: built.mcpToolService,
    ...(config.brandingDefault ? { brandingDefault: config.brandingDefault } : {}),
    harnessId: config.harness,
    connectorTokens: built.connectorTokens,
    slackInstallation: built.slackInstallation,
    slackEnvironmentState,
    ...(slackEnvBotToken ? { slackEnvBotToken } : {}),
    resolveClient: built.resolveClient,
    consentLinks: built.consentLinks,
    secretDrops: built.secretDrops,
    ...(built.fireDropResolution ? { fireDropResolution: built.fireDropResolution } : {}),
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
    ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
    ...(config.publicWebUrl ? { portalUrl: config.publicWebUrl } : {}),
    admin: built.admin,
    rateLimiter: built.rateLimiter,
    acl: built.acl,
    credentialUsage: built.credentialUsage,
    deviceFlowCutover: built.deviceFlowCutover,
    egressAudit: built.egressAudit,
    sessions: built.sessions,
    auditLog: built.auditLog,
    errors: built.errors,
    metrics: built.metrics,
    crons: built.crons,
    brokeredServices: () => built.brokeredTools.map((tool) => tool.service),
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
    workspace: built.workspace,
    files: built.files,
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
    environments: built.environments,
    sandboxMigration: built.sandboxMigration,
  };
}
