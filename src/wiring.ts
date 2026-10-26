import type { MemoryEmbedder } from "./model/embeddings.ts";
import { nonDeploymentCredential, withDeploymentCredentials } from "./credentials/deployment-credentials.ts";
import { resolveEmbeddingModel } from "./model/pi-models.ts";
import { createPostgresTeamStore, type TeamStore } from "./teams/teams.ts";
import type { DecisionBackend } from "./decisions/decisions.ts";
import { createDecisionHooks, routeTurnRuntime, turnStartState } from "./decisions/hooks.ts";
import { createDecisionBackend } from "./decisions/providers.ts";
import { createPostgresDecisionStore, type DecisionStore } from "./decisions/store.ts";
import type { SlackSessionStatusState } from "./slack/session-status.ts";
import { availableRuntimeError } from "./api/runtime-config.ts";
import { createApprovalStore } from "./core/approval-store.ts";
import { createKeychainApprovals, type KeychainApprovals } from "./credentials/keychain-approval.ts";
import { flushErrorReporting } from "../plugins/chassis/src/error-reporting.ts";
import { createProductAnalytics } from "./util/product-analytics.ts";
import { createAdmittedWork } from "./util/admitted-work.ts";
import { runSessionSmoke } from "./deployment/postdeploy-smoke.ts";
import {
  createBackgroundOwnershipStore,
  type BackgroundOwnershipControl,
  type BackgroundOwnership,
} from "./runs/background-ownership.ts";
import { loadConnectorSdk } from "./sandbox/connector-sdk.ts";
import { createFlyTunnelManager, parseFlyWireguardPeers } from "./deploy/fly-tunnel-manager.ts";
import type { FlyPeerClaim } from "./deploy/fly-peer-claims.ts";
import { createMemoryEventBus } from "./util/event-bus.ts";
import { createPostgresNotifyBus } from "./persistence/postgres-notify-bus.ts";
import { emitRunReasoning, emitRunText, reasoningKey, type RunStreamEvent } from "./runs/run-stream-events.ts";
import { createPostgresResourceSearch } from "./search/resource-search.ts";
import { createSessionMailbox, type SessionMessage } from "./sessions/session-mailbox.ts";
import type { TaskAckState } from "./slack/task-ack.ts";
import { createLoopIngress, type LoopIngressService, type LoopIngress, type IngressDelivery } from "./loops/ingress.ts";
import { createGmailPushClient } from "./loops/gmail-push.ts";
import { createGatewayCatalog } from "./model/gateway-catalog.ts";
import { createSuggestedActivityService, type SuggestedActivityProfile } from "./suggestions/activities.ts";
import { createMemoryTidyService, withMemoryTidy, type MemoryTidyProfile } from "./memory/tidy.ts";
import { createRuntimeService } from "./harness/runtime-control.ts";
import {
  createSessionSyscalls,
  deliverSubagentMail,
  sessionTreeRoot,
  sessionTreeRunCount,
  sessionTreeWorking,
  stoppableAncestors,
  SUBAGENT_TREE_RUN_CAP,
} from "./sessions/session-syscalls.ts";
import { createMemoryEmbedder } from "./model/embeddings.ts";
import { createSemanticMemory } from "./memory/semantic-memory.ts";
import { createPostgresBrokerSessions, type BrokerSessionStore } from "./auth/broker-sessions.ts";
import { createDirectFileUploads, type DirectFileUploads } from "./files/direct-file-upload.ts";
import { createPostgresFileUploadStore } from "./files/file-upload-store.ts";
import {
  createSandboxResources,
  type SandboxResource,
  type SandboxDefault,
  type SandboxResources,
} from "./sandbox/sandbox-resources.ts";
import { createModelVerifier, type ModelVerifier } from "./model/model-verification.ts";
import type { probeModel } from "./harness/pi-harness.ts";
import { createAwsRoleBroker, type AwsRoleBroker } from "./auth/aws-role-broker.ts";
import type { SessionShare, SessionShareStore } from "./sessions/session-share.ts";
import { createModelOverlayStore, type ModelOverlayStore } from "./model/model-overlay-store.ts";
import { mkdirSync } from "node:fs";
import type { StagedEnvelope } from "./slack/envelope-staging.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
import {
  createPrincipalLinkService,
  type PrincipalLink,
  type PrincipalLinkService,
} from "./identity/principal-links.ts";
import type { SlackAccountLink, ComposioReturn } from "./api/routes/composio.ts";
import { installPrincipalLinks } from "./directory/person.ts";
import type { ExternalMember } from "./identity/external-members.ts";
import { resendMailer } from "../plugins/chassis/src/resend.ts";
import { configStoreMaps, createMemoryConfigStore, type ScopedConfigStore } from "./resolution/config-store.ts";
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
import { installSharedCanvas } from "./surfaces/ui-canvas.ts";
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
  Session,
  SurfaceContextRequest,
  TurnRequest,
  TurnResult,
  Webhook,
} from "./types.ts";
import { personalScope, scopeId } from "./types.ts";
import { createAuditLog, type AuditLog } from "./audit/audit-log.ts";
import { createPostgresAuditLog } from "./admin/postgres-audit-log.ts";
import { createPostgresAppPageViewLog, type AppPageViewLog } from "./deploy/page-views.ts";
import { createRateLimiter, type RateLimiter } from "./ratelimit/rate-limiter.ts";
import { createPostgresRateLimiter } from "./ratelimit/postgres-rate-limiter.ts";
import { createBudgetTracker, estimateCostUsd } from "./ratelimit/budget.ts";
import type { SecurityScreenProbe } from "./security/security-screener.ts";
import { createPostgresBudgetTracker } from "./ratelimit/postgres-budget.ts";
import { createCronStore, DROP_RUN_AS_MIGRATION, type CronStore } from "./cron/cron-store.ts";
import { DROP_RECIPIENT_CONSENT_MIGRATION } from "./triggers/trigger-store.ts";
import { LEGACY_HARNESS_MIGRATION } from "./model/legacy-harness-migration.ts";
import { createMemoryCronFireStore, createPostgresCronFireStore } from "./cron/fire-store.ts";
import { createLoopStore } from "./loops/loop-store.ts";
import { createLoopItemLedger } from "./loops/item-ledger.ts";
import {
  createMemoryLedgerEventBus,
  createPostgresLedgerEventBus,
  type LedgerEventBus,
} from "./loops/ledger-events.ts";
import { createInboxSourceRefresh } from "./loops/inbox-source-refresh.ts";
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
import { createWebhookStore, type WebhookHistory } from "./webhooks/webhook-store.ts";
import { createWebhookReceiver, type WebhookReceiver } from "./webhooks/webhook-receiver.ts";
import { createDeployStore, deployTouchDebounceMs, type Deployment } from "./deploy/deploy-store.ts";
import { viewerIdentityKey } from "./deploy/access-token.ts";
import { deploymentCredentialSlugs } from "./deploy/deployment-credentials.ts";
import { createDockerDeployProvider } from "./deploy/docker-deploy-provider.ts";
import { createAwsDeployProvider, type StoredDeployBody } from "./deploy/aws-deploy-provider.ts";
import { createFlyDeployProvider, type FlyMachineConfig } from "./deploy/fly-deploy-provider.ts";
import { createPorterDeployProvider, type StoredPorterDeployBody } from "./deploy/porter-deploy-provider.ts";
import {
  createE2bDeployProvider,
  E2B_DEPLOY_IDLE_TIMEOUT_SEC,
  type StoredE2bDeployBody,
} from "./deploy/e2b-deploy-provider.ts";
import type { DeployProvider } from "./deploy/deploy-provider.ts";
import { createDeployService } from "./deploy/deploy-service.ts";
import {
  createCanReadScope,
  createCanManageScope,
  createCanWriteScope,
  createCurrentScopeMembers,
  createIsCurrentSharedScopeMember,
  createManagesArtifactHome,
  rosterAdmits,
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
import { createLocalSandbox } from "./sandbox/local-sandbox.ts";
import { createSpritesSandbox } from "./sandbox/sprites-sandbox.ts";
import { createSmolmachinesSandbox, type StoredSmolmachinesSandbox } from "./sandbox/smolmachines-sandbox.ts";
import { createAgent37Sandbox } from "./sandbox/agent37-sandbox.ts";
import {
  createConfigEpochResolver,
  createSuperserveSandbox,
  type StoredConfigEpoch,
  type StoredSuperserveSandbox,
} from "./sandbox/superserve-sandbox.ts";
import { createSdkSuperserveClient } from "./sandbox/superserve-client.ts";
import { createE2bSandbox, E2B_TEMPLATE_TOOLS, type StoredE2bSandbox } from "./sandbox/e2b-sandbox.ts";
import { createSdkE2bClient, type E2bClient } from "./sandbox/e2b-client.ts";
import {
  createManagedAgentsSandbox,
  QM_TEMPLATE_TOOLS,
  type StoredManagedAgentsSandbox,
} from "./sandbox/managed-agents-sandbox.ts";
import { createSdkManagedAgentsClient } from "./sandbox/managed-agents-client.ts";
import { createS3SnapshotStore } from "./sandbox/home-snapshot.ts";
import { createModalSandbox, type StoredModalSandbox } from "./sandbox/modal-sandbox.ts";
import { createSdkModalClient } from "./sandbox/modal-client.ts";
import { createPorterSandbox } from "./sandbox/porter-sandbox.ts";
import { createSandboxRouter, type SandboxBackendName } from "./sandbox/sandbox-routing.ts";
import {
  upgradeLegacySandboxes,
  legacySandboxBackendForScope,
  type LegacyRoute,
} from "./sandbox/sandbox-resource-upgrade.ts";
import { effectiveEgressEnforcement, type Sandbox } from "./sandbox/sandbox.ts";
import { withOperatorTokenFallback } from "./credentials/connector-token.ts";
import {
  createAwsSecretsManagerSource,
  createEnvSecretSource,
  createLayeredSecretSource,
} from "./credentials/secret-source.ts";
import {
  credentialRequestHeaders,
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
import { createConnectorStatusCache, type ConnectorStatusRecord } from "./credentials/connector-status.ts";
import {
  createFeatureFlagStore,
  externalAppSharingAllowed,
  type FeatureFlagRecord,
  type FeatureFlagStore,
} from "./feature-flags.ts";
import { makeRefresh, withPublicOAuthClients, type OAuthClientResolver, type OAuthState } from "./connectors/oauth.ts";
import {
  createConnectorClientResolver,
  deriveConnectorKey,
  type SecretKey,
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
import { type ModelGatewayTransportConfig, setProviderBaseUrls } from "./model/provider-endpoints.ts";
import { setCustomProviders } from "./model/custom-providers.ts";
import { createCustomProviderStore, type CustomProviderStore } from "./model/custom-provider-store.ts";
import { createMemorySessionStore } from "./sessions/memory-session-store.ts";
import { createPostgresSessionStore } from "./sessions/postgres-session-store.ts";
import { createMemoryToolOutputStore, createPostgresToolOutputStore } from "./sessions/tool-output.ts";
import { LLM_CAPTURE_RETENTION_MS, type SessionStore } from "./sessions/session-store.ts";
import {
  fileCompanyChatGPTAuth,
  keychainCompanyChatGPTAuth,
  type CompanyChatGPTAuth,
} from "./model/company-chatgpt-auth.ts";
import { keychainHarnessAuthEnv } from "./credentials/harness-auth-env.ts";
import { createClaudeHarness, claudeHarnessConfigOptions } from "./harness/claude-harness.ts";
import { createPiHarness, piHarnessConfigOptions, type ProviderKeys } from "./harness/pi-harness.ts";
import { createHarnessRouter, resolveRuntimeChoiceDurable } from "./harness/harness-router.ts";
import { selectableModelCatalog } from "./model/model-catalog.ts";
import type { Harness } from "./harness/harness.ts";
import { createSecurityScreenProxy, type SecurityScreener } from "./security/security-screener.ts";
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
import { isTerminal, type Run, type RunStore } from "./runs/run-store.ts";
import { createRunPreemption, createWorker, type Worker } from "./runs/worker.ts";
import {
  createNoopInstanceRegistry,
  createPostgresInstanceRegistry,
  type InstanceRegistry,
} from "./runs/instance-registry.ts";
import { createDrainController, type DrainController } from "./runs/drain.ts";
import { createReaper, REAPER_LEASE_KEY, type Reaper } from "./runs/reaper.ts";
import { createSweeper as createUntrackedSweeper, type Sweeper } from "./util/sweeper.ts";
import {
  createMemoryProcessRegistry,
  createPostgresProcessRegistry,
  type ProcessRegistry,
} from "./processes/process-registry.ts";
import { createProcessReaper, createReaperKillHook, type ProcessReaper } from "./processes/process-reaper.ts";
import { createJobComputerSweep } from "./processes/job-computers.ts";
import { createMonitorStore, type MonitorStore } from "./monitors/monitor-store.ts";
import { createMonitorPoller, type MonitorPoller } from "./monitors/monitor-poller.ts";
import { createSkillSyncEngine, type SkillSyncEngine } from "./skills/skill-sync-engine.ts";
import { supportsProcessSessions, type SandboxHandle } from "./sandbox/sandbox.ts";
import { finishProcessCredentials } from "./credentials/execute-files.ts";
import { createTurnStream } from "./runs/turn-stream.ts";
import { createMemorySessionStateBus, type SessionStateBus } from "./runs/session-state-bus.ts";
import { createPostgresSessionStateBus } from "./runs/postgres-session-state-bus.ts";
import { createMemoryRunActivityStore, type RunActivityStore } from "./runs/run-activity-store.ts";
import { createPostgresRunActivityStore } from "./runs/postgres-run-activity-store.ts";
import { createApp, type App } from "./api/app.ts";
import { startSession } from "./api/start-session.ts";
import { createSwarmStore, type SwarmStorage } from "./swarms/swarm-store.ts";
import { createSwarmService } from "./swarms/swarm-service.ts";
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
  CODEX_SUBSCRIPTION_PROVIDER,
  codexSubscriptionModelId,
  isOverlayModel,
  modelRequestOverrides,
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
import { withErrorReporting, createErrorLog, type ErrorLog } from "./admin/error-log.ts";
import { createMemoryReplayDedupe, createPostgresReplayDedupe, type ReplayDedupe } from "./auth/replay-dedupe.ts";
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
import { errMessage, reportFailureAs, swallowAs } from "./util/errors.ts";
import { sleep, withTimeout } from "./util/async.ts";
import { createSlackInstallationStore, type SlackInstallationStore } from "./surfaces/slack-installation.ts";

export interface Runtime {
  start(): void;
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
  backgroundOwnership?: BackgroundOwnershipControl;
  suggestedActivities?: ReturnType<typeof createSuggestedActivityService>;
  app: App;
  screenSecurity?: SecurityScreenProbe;
  deploymentLayer: DeploymentLayerRuntime;
  brokeredTools: readonly BrokeredLayerTool[];
  deploymentLayerStore: DeploymentLayerStore;
  deploymentLayerReady: Promise<unknown>;
  deploymentLayerRefresh: Sweeper;
  sessions: SessionStore;
  runs: RunStore;
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
  browserModelGateway?: ModelGatewayTransportConfig;
  resolveBrowserCompanyKeys: (includeSubscription?: boolean) => Promise<ProviderKeys>;
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
  loopIngress: LoopIngressService;
  admin: AdminService;
  rateLimiter: RateLimiter;
  errors: ErrorLog;
  crons: CronStore;
  credentialUsage: CredentialUsageSink;
  egressAudit: EgressAuditSink;
  identity: IdentityService;
  principalLinks: PrincipalLinkService;
  slackAccounts: DurableMap<SlackAccountLink>;
  composioReturns: DurableMap<ComposioReturn>;
  keychain?: Keychain;
  serviceCreds: ServiceCredentialStore;
  deliveries: DeliveryStore;
  keychainApprovals?: KeychainApprovals;
  fireAskResolution?: (ask: KeychainAsk, grant?: KeychainGrant) => Promise<unknown>;
  fireDropResolution?: (drop: DropResolution) => Promise<unknown>;
  workspace: WorkspaceStore;
  memory: MemoryService;
  sandbox: Sandbox;
  advisoryLock: AdvisoryLock;
  sandboxResources: SandboxResources;
  blobTransfer: BlobTransferStore;
  files: FileArtifactStore;
  fileUploads?: DirectFileUploads;
  featureFlags: FeatureFlagStore;
  teams?: TeamStore;
  decisions?: DecisionStore;
  replayDedupe?: ReplayDedupe;
  brokerSessions?: BrokerSessionStore;
  directory: DirectoryStore;
  projects: ProjectStore;
  environments: EnvironmentStore;
  processes?: ProcessRegistry;
  appPageViews?: AppPageViewLog;
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
    decisionBackend?: DecisionBackend;
    credentialBrokers?: Record<string, AwsRoleBroker>;
    modelCredentialFetch?: typeof fetch;
    modelVerificationProbe?: typeof probeModel;
    harnesses?: Partial<Record<HarnessId, Harness>>;
  } = {},
): BuiltApp {
  let backgroundAdmission = () => !config.backgroundDeploymentId;
  let backgroundActive = () => false;
  const admittedWork = createAdmittedWork({
    canStart: () => !config.backgroundDeploymentId || backgroundAdmission(),
  });
  let inlineShutdown = new AbortController();
  const createSweeper: typeof createUntrackedSweeper = (work, interval, options) =>
    createUntrackedSweeper(() => admittedWork.run(work), interval, options);
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
    resolveFiles: (refs) => files.resolveByIds(refs),
  });
  const pgArtifactMap = config.databaseUrl ? createPostgresMapFactory(config.databaseUrl) : null;
  const artifactMap = <T>(table: string, indexedFields?: readonly Extract<keyof T, string>[]): DurableMap<T> =>
    pgArtifactMap ? pgArtifactMap.map<T>(table, indexedFields) : createMemoryMap<T>();
  setProviderBaseUrls(config.providerBaseUrls);
  const unknownGatewayModels = Object.keys(config.modelGateway?.models ?? {}).filter((id) => !resolveModel(id));
  if (unknownGatewayModels.length) {
    throw new Error(`MODEL_GATEWAY_MODELS contains unsupported models: ${unknownGatewayModels.join(", ")}`);
  }
  const gatewayCatalog = config.modelGateway
    ? createGatewayCatalog(config.modelGateway, overrides.modelCredentialFetch)
    : undefined;
  const gatewayTransport = gatewayCatalog?.transport;
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
      await gatewayCatalog?.refresh();
      const direct = await directModelCredentials.availability();
      return {
        ...direct,
        ...(directProviderAvailability.codexOAuth ? { codexOAuth: true } : {}),
        modelIds: new Set(Object.keys(gatewayTransport?.models ?? {})),
      };
    },
  };
  const advisoryLock: AdvisoryLock = pgArtifactMap
    ? createPostgresAdvisoryLock(pgArtifactMap.pool)
    : createMemoryAdvisoryLock();
  const principalLinks = createPrincipalLinkService(artifactMap<PrincipalLink>("principal_links"), advisoryLock);
  installPrincipalLinks(principalLinks);
  const identity = createIdentityService(artifactMap<DeactivationRecord>("deactivated_principals"), {
    directorySyncProtected: config.emailAuthPrincipals,
    externalMembers: artifactMap<ExternalMember>("external_members"),
    principalLinks,
  });
  void identity.hydrate().catch(reportFailureAs("startup: hydrate identity", undefined));
  const leaderLease: LeaderLease = pgArtifactMap
    ? createPostgresLeaderLease(pgArtifactMap.pool)
    : createNoopLeaderLease();
  const configStore = createMemoryConfigStore(config.orgId, {
    ...configStoreMaps(artifactMap),
    defaultSecurityPosture: config.securityPosture,
    defaultSharingPosture: config.sharingPosture,
    ...(config.connectorSecretKey ? { connectorSecretKey: config.connectorSecretKey } : {}),
  });
  void configStore.hydrate?.().catch(reportFailureAs("startup: hydrate configuration", undefined));
  const skills: SkillStore = createSkillStore({
    backing: artifactMap<Skill>("skills"),
    advisoryLock,
    ...(config.skillSigningSecret ? { signingSecret: config.skillSigningSecret } : {}),
  });
  const skillPacks = createSkillPackStore({ backing: artifactMap<SkillPack>("skill_packs") });
  const skillBundles = createSkillBundleStore({ backing: artifactMap<SkillBundle>("skill_bundles") });
  const featureFlags = createFeatureFlagStore(artifactMap<FeatureFlagRecord>("feature_flags"));
  const teams = config.databaseUrl
    ? createPostgresTeamStore(config.databaseUrl, featureFlags, scopeId("org", config.orgId))
    : undefined;
  const decisions = config.databaseUrl ? createPostgresDecisionStore(config.databaseUrl) : undefined;
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
  const deploymentLayerRefresh = createUntrackedSweeper(() => deploymentLayerStore.hydrate(), 30_000, {
    label: "deployment layer refresh",
  });
  let skillsReady: Promise<void>;
  if (config.seedSkills) {
    const installCatalogs = async (): Promise<void> => {
      await installSeedSkills(skills, { dir: config.skillsSeedDir, scopeId: orgScope, respectArchived: true });
      for (const dir of config.pluginSkillDirs) {
        if (layerSkillsDir && resolve(dir) === layerSkillsDir) continue;
        await installSeedSkills(skills, {
          dir,
          scopeId: orgScope,
          createdBy: "system:plugin-skills",
          reviewer: "system:plugin-skills-reviewer",
          respectArchived: true,
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
  const resolution = createResolutionService(
    config.orgId,
    configStore,
    acl,
    config.securityScreen === "off" && overrides.securityScreener ? "enforce" : config.securityScreen,
  );

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
  const notebookMemory: MemoryService = config.databaseUrl
    ? createPostgresMemoryService(config.databaseUrl)
    : createMemoryService(workspace);
  const semanticMemory = createSemanticMemory({
    notebook: notebookMemory,
    databaseUrl: config.databaseUrl,
    embeddingModel: () => configStore.getEmbeddingModelDurable(),
    resolveEmbedder: (id) => resolveMemoryEmbedder(id),
    leaderLease,
    createSweeper,
  });
  // Session storage is built further down; trace-derived providers only read it after the first turn.
  const memorySessions: { store?: SessionStore } = {};
  const baseMemory: MemoryService = withMemoryTidy(
    createConfiguredMemoryService({
      defaultMemory: semanticMemory.memory,
      config: config.memoryProviderConfig,
      sessionEntries: (sessionId) => {
        if (!memorySessions.store) throw new Error("session store is not ready");
        return memorySessions.store.getEntries(sessionId, { limit: MEMORY_CAPTURE_ENTRY_WINDOW });
      },
    }),
    (scope) => memoryTidy.ensure(scope),
  );
  const mcpServers = createMcpServerStore(artifactMap<McpServer>("mcp_servers"));
  const errors = withErrorReporting(config.databaseUrl ? createPostgresErrorLog(config.databaseUrl) : createErrorLog());
  const sandboxOnError = (
    e: { category: string; code: string; message: string; scopeLabel?: string },
    error?: unknown,
  ) =>
    errors.record(
      {
        category: e.category,
        code: e.code,
        message: e.message,
        scopeLabel: (e.scopeLabel ?? "unknown") as ScopeId,
      },
      error,
    );
  const buildLocal = (): Sandbox =>
    createLocalSandbox(workspace, {
      ...config.localSandbox,
      onError: sandboxOnError,
    });
  const buildSprites = (): Sandbox => {
    const { snapshotS3Bucket, ...sprites } = config.spritesSandbox;
    return createSpritesSandbox(workspace, {
      ...sprites,
      initializationStore: artifactMap<{ pending: boolean }>("sprites_initialization"),
      advisoryLock,
      ...(snapshotS3Bucket
        ? { snapshots: createS3SnapshotStore({ bucket: snapshotS3Bucket, prefix: "sprites-home" }) }
        : {}),
      blobTransfer,
      extraTools: deploymentLayer.advertisedTools,
      credentialPaths: deploymentLayer.credentialPaths,
      connectorSdk: loadConnectorSdk,
      layerToolFiles: () => deploymentLayer.installFiles,
      ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
      ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
      ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
      onError: sandboxOnError,
    });
  };
  const smolmachinesBodies = artifactMap<StoredSmolmachinesSandbox>("smolmachines_sandbox_bodies");
  const buildSmolmachines = (): Sandbox => {
    const { snapshotS3Bucket, snapshotIntervalSec, ...smol } = config.smolmachinesSandbox;
    return createSmolmachinesSandbox(workspace, {
      ...smol,
      ...(snapshotIntervalSec !== undefined ? { snapshotIntervalMs: snapshotIntervalSec * 1000 } : {}),
      blobTransfer,
      extraTools: deploymentLayer.advertisedTools,
      credentialPaths: deploymentLayer.credentialPaths,
      layerToolFiles: () => deploymentLayer.installFiles,
      ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
      ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
      ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
      store: smolmachinesBodies,
      advisoryLock,
      ...(snapshotS3Bucket
        ? { snapshots: createS3SnapshotStore({ bucket: snapshotS3Bucket, prefix: "smolmachines-home" }) }
        : {}),
      onError: sandboxOnError,
    });
  };
  const e2bBodies = artifactMap<StoredE2bSandbox>("e2b_sandbox_bodies");
  const modalBodies = artifactMap<StoredModalSandbox>("modal_sandbox_bodies");
  const awsBodies = artifactMap<StoredMicrovm>("aws_sandbox_bodies");
  const e2bClient = (use: "computers" | "apps"): E2bClient => {
    const e2b = config.e2bSandbox;
    if (!e2b.apiKey)
      throw new Error(`${use === "apps" ? "DEPLOY_PROVIDER" : "SANDBOX_BACKEND"}=e2b requires E2B_API_KEY`);
    const ttlSec = use === "apps" ? E2B_DEPLOY_IDLE_TIMEOUT_SEC : e2b.sandboxTtlSec;
    return createSdkE2bClient({
      apiKey: e2b.apiKey,
      ...(e2b.templateId ? { templateId: e2b.templateId } : {}),
      ...(ttlSec ? { sandboxTtlMs: ttlSec * 1000 } : {}),
      ...(e2b.maxLifetimeSec ? { maxLifetimeMs: e2b.maxLifetimeSec * 1000 } : {}),
      ...(e2b.proxy ? { proxy: e2b.proxy } : {}),
      ...(use === "computers" && e2b.egressProxyUrl ? { egressProxyUrl: e2b.egressProxyUrl } : {}),
    });
  };
  const buildE2b = (): Sandbox => {
    const e2b = config.e2bSandbox;
    return createE2bSandbox(workspace, {
      advisoryLock,
      client: e2bClient("computers"),
      ...(e2b.namePrefix ? { namePrefix: e2b.namePrefix } : {}),
      ...(e2b.defaultTimeoutSec ? { defaultTimeoutSec: e2b.defaultTimeoutSec } : {}),
      keepWarmSec: Math.ceil(config.backgroundJobTtlMaxMs / 1000),
      ...(e2b.snapshotIntervalSec !== undefined ? { snapshotIntervalMs: e2b.snapshotIntervalSec * 1000 } : {}),
      ...(e2b.nativeSnapshotIntervalSec !== undefined
        ? { nativeSnapshotIntervalMs: e2b.nativeSnapshotIntervalSec * 1000 }
        : {}),
      ...(e2b.egressProxyUrl ? { egressProxyUrl: e2b.egressProxyUrl } : {}),
      extraTools: [...(e2b.templateId ? E2B_TEMPLATE_TOOLS : []), ...deploymentLayer.advertisedTools],
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
  const managedAgentsBodies = artifactMap<StoredManagedAgentsSandbox>("do_managed_agents_sandbox_bodies");
  const buildManagedAgents = (): Sandbox => {
    const managedAgents = config.managedAgentsSandbox;
    if (!managedAgents.apiToken) throw new Error("SANDBOX_BACKEND=do-managed-agents requires DO_AGENTS_API_TOKEN");
    return createManagedAgentsSandbox(workspace, {
      client: createSdkManagedAgentsClient({
        apiToken: managedAgents.apiToken,
        ...(managedAgents.apiBaseUrl ? { apiBaseUrl: managedAgents.apiBaseUrl } : {}),
        ...(managedAgents.template ? { template: managedAgents.template } : {}),
        ...(managedAgents.sizeSlug ? { sizeSlug: managedAgents.sizeSlug } : {}),
        ...(managedAgents.idleTimeoutSec ? { idleTimeoutSec: managedAgents.idleTimeoutSec } : {}),
        ...(managedAgents.egressProxyUrl ? { egressProxyUrl: managedAgents.egressProxyUrl } : {}),
      }),
      ...(managedAgents.namePrefix ? { namePrefix: managedAgents.namePrefix } : {}),
      ...(managedAgents.defaultTimeoutSec ? { defaultTimeoutSec: managedAgents.defaultTimeoutSec } : {}),
      ...(managedAgents.snapshotIntervalSec !== undefined
        ? { snapshotIntervalMs: managedAgents.snapshotIntervalSec * 1000 }
        : {}),
      ...(managedAgents.egressProxyUrl ? { egressProxyUrl: managedAgents.egressProxyUrl } : {}),
      extraTools: [...(managedAgents.template ? QM_TEMPLATE_TOOLS : []), ...deploymentLayer.advertisedTools],
      credentialPaths: deploymentLayer.credentialPaths,
      layerToolFiles: () => deploymentLayer.installFiles,
      blobTransfer,
      ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
      ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
      ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
      store: managedAgentsBodies,
      ...(managedAgents.snapshotS3Bucket
        ? {
            snapshots: createS3SnapshotStore({ bucket: managedAgents.snapshotS3Bucket, prefix: "managed-agents-home" }),
          }
        : {}),
      onError: sandboxOnError,
    });
  };
  const buildModal = (): Sandbox => {
    const modal = config.modalSandbox;
    if (!modal.tokenId || !modal.tokenSecret)
      throw new Error("SANDBOX_BACKEND=modal requires MODAL_TOKEN_ID and MODAL_TOKEN_SECRET");
    return createModalSandbox(workspace, {
      advisoryLock,
      client: createSdkModalClient({
        tokenId: modal.tokenId,
        tokenSecret: modal.tokenSecret,
        appName: modal.appName ?? "qm",
        ...(modal.image ? { image: modal.image } : {}),
        ...(modal.environment ? { environment: modal.environment } : {}),
        ...(modal.cpus !== undefined ? { cpus: modal.cpus } : {}),
        ...(modal.memoryMb !== undefined ? { memoryMb: modal.memoryMb } : {}),
        ...(modal.regions?.length ? { regions: modal.regions } : {}),
        ...(modal.sandboxTimeoutSec ? { sandboxTimeoutMs: modal.sandboxTimeoutSec * 1000 } : {}),
        ...(modal.reapIdleSec ? { idleTimeoutMs: 2 * modal.reapIdleSec * 1000 } : {}),
        ...(modal.snapshotRetentionSec !== undefined ? { snapshotRetentionMs: modal.snapshotRetentionSec * 1000 } : {}),
        ...(modal.egressProxyUrl ? { egressProxyUrl: modal.egressProxyUrl } : {}),
      }),
      ...(modal.namePrefix ? { namePrefix: modal.namePrefix } : {}),
      ...(modal.defaultTimeoutSec ? { defaultTimeoutSec: modal.defaultTimeoutSec } : {}),
      ...(modal.nativeSnapshotIntervalSec !== undefined
        ? { nativeSnapshotIntervalMs: modal.nativeSnapshotIntervalSec * 1000 }
        : {}),
      ...(modal.rotateAfterSec ? { rotateAfterMs: modal.rotateAfterSec * 1000 } : {}),
      ...(modal.reapIdleSec ? { reapIdleMs: modal.reapIdleSec * 1000 } : {}),
      ...(modal.egressProxyUrl ? { egressProxyUrl: modal.egressProxyUrl } : {}),
      extraTools: deploymentLayer.advertisedTools,
      credentialPaths: deploymentLayer.credentialPaths,
      connectorSdk: loadConnectorSdk,
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
  const superserveBodies = artifactMap<StoredSuperserveSandbox>("superserve_sandbox_bodies");
  const superserveEpochs = artifactMap<StoredConfigEpoch>("superserve_config_epochs");
  const buildSuperserve = (): Sandbox => {
    const ss = config.superserveSandbox;
    if (!ss.apiKey) throw new Error("SANDBOX_BACKEND=superserve requires SUPERSERVE_API_KEY");
    if (!ss.template)
      throw new Error("SANDBOX_BACKEND=superserve requires SUPERSERVE_TEMPLATE (a ready qm-agent-<release> template)");
    const keepWarmSec = Math.ceil(config.backgroundJobTtlMaxMs / 1000);
    const generationKey = createHash("sha256")
      .update(
        JSON.stringify([
          config.buildSha ?? "",
          ss.template,
          ss.namePrefix ?? "",
          ss.homeDir ?? "",
          ss.idlePauseSec ?? null,
          ss.retentionSec ?? null,
          keepWarmSec,
          [...(ss.egressAllow ?? [])].sort(),
          [...(ss.egressDeny ?? [])].sort(),
        ]),
      )
      .digest("hex")
      .slice(0, 32);
    return createSuperserveSandbox(workspace, {
      configEpoch: ss.configGeneration ?? createConfigEpochResolver(superserveEpochs, generationKey, advisoryLock),
      client: createSdkSuperserveClient({
        apiKey: ss.apiKey,
        ...(ss.baseUrl ? { baseUrl: ss.baseUrl } : {}),
        ...(ss.template ? { template: ss.template } : {}),
      }),
      ...(ss.namePrefix ? { namePrefix: ss.namePrefix } : {}),
      template: ss.template,
      ...(ss.homeDir ? { homeDir: ss.homeDir } : {}),
      ...(ss.idlePauseSec !== undefined ? { idlePauseSec: ss.idlePauseSec } : {}),
      keepWarmSec,
      ...(ss.retentionSec !== undefined ? { retentionSec: ss.retentionSec } : {}),
      ...(ss.egressAllow ? { egressAllow: ss.egressAllow } : {}),
      ...(ss.egressDeny ? { egressDeny: ss.egressDeny } : {}),
      ...(ss.defaultTimeoutSec ? { defaultTimeoutSec: ss.defaultTimeoutSec } : {}),
      advisoryLock,
      extraTools: deploymentLayer.advertisedTools,
      credentialPaths: deploymentLayer.credentialPaths,
      layerToolFiles: () => deploymentLayer.installFiles,
      blobTransfer,
      ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
      ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
      ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
      store: superserveBodies,
      onError: sandboxOnError,
    });
  };
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
    local: buildLocal,
    sprites: buildSprites,
    smolmachines: buildSmolmachines,
    e2b: buildE2b,
    modal: buildModal,
    aws: buildAws,
    porter: buildPorter,
    agent37: buildAgent37,
    superserve: buildSuperserve,
    "do-managed-agents": buildManagedAgents,
  };
  const enabledBackends = new Set(enabledSandboxBackends(config));
  const sandboxBackends: Partial<Record<SandboxBackendName, Sandbox>> = {
    [config.sandboxBackend]: buildBackend[config.sandboxBackend](),
  };
  for (const name of Object.keys(buildBackend) as Array<Config["sandboxBackend"]>) {
    if (name !== config.sandboxBackend && enabledBackends.has(name)) sandboxBackends[name] = buildBackend[name]();
  }
  const sandboxRecords = artifactMap<SandboxResource>("sandbox_resources");
  const sandboxDefaults = artifactMap<SandboxDefault>("sandbox_defaults");
  const sandboxResources = createSandboxResources({
    records: sandboxRecords,
    defaults: sandboxDefaults,
    upgrade: () =>
      upgradeLegacySandboxes({
        availableBackends: Object.keys(sandboxBackends) as SandboxBackendName[],
        records: sandboxRecords,
        defaults: sandboxDefaults,
        marker: artifactMap<{ activatedAt: string }>("sandbox_resource_rollout"),
        routes: () => artifactMap<LegacyRoute>("sandbox_routing").entries(),
        lock: advisoryLock,
        legacyBackend: (scope) =>
          legacySandboxBackendForScope(scope, config.sandboxBackend, config.legacySandboxScopeDefaults),
        specFor: (backend) => sandboxBackends[backend]?.profile.spec,
        legacyScopes: async () => [
          ...(await sessions.distinctScopes()).map((scope) => scope.scopeId),
          ...(await environments.list()).map((environment) => environment.id),
        ],
        legacySandboxes: async () => {
          const [e2b, modal, aws, superserve] = await Promise.all([
            e2bBodies.entries(),
            modalBodies.entries(),
            awsBodies.entries(),
            superserveBodies.entries(),
          ]);
          return [
            ...e2b.map(([scopeId, body]) => ({ scopeId, backend: "e2b" as const, machineId: body.sandboxId })),
            ...modal.map(([scopeId, body]) => ({ scopeId, backend: "modal" as const, machineId: body.sandboxId })),
            ...aws.map(([scopeId, body]) => ({ scopeId, backend: "aws" as const, machineId: body.microvmId })),
            ...superserve.map(([scopeId, body]) => ({
              scopeId,
              backend: "superserve" as const,
              machineId: body.sandboxId,
            })),
          ];
        },
      }),
    backends: sandboxBackends,
    defaultBackend: config.sandboxBackend,
    lock: advisoryLock,
    beforeRetire: async (record) => {
      if ((await processes?.liveByScope(record.ownerScopeId))?.some((process) => process.sandboxId === record.id))
        throw new Error("stop this sandbox's background jobs before retiring it");
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
        config.capabilityTokenCompression,
      );
      return { egressToken };
    },
    canUseScope: (actorId, scopeId) => membership.canUseSandboxScope!(actorId, scopeId),
  });
  const sandbox: Sandbox = createSandboxRouter({
    resources: sandboxResources,
    backends: sandboxBackends,
    defaultBackend: config.sandboxBackend,
    onError: sandboxOnError,
  });
  const secretSource =
    config.secretsBackend === "aws"
      ? createLayeredSecretSource(
          createEnvSecretSource(),
          createAwsSecretsManagerSource({ prefix: config.secretsPrefix }),
        )
      : createEnvSecretSource();
  const resolveClient: OAuthClientResolver = withPublicOAuthClients(
    createConnectorClientResolver({
      reader: configStore,
      orgScopeId: (o) => scopeId("org", o),
      secrets: secretSource,
    }),
  );
  const keychainKeyMaterial = config.connectorSecretKey;
  const legacyCredentialKey =
    keychainKeyMaterial && config.signingSecret && config.signingSecret !== keychainKeyMaterial
      ? deriveConnectorKey(config.signingSecret, "keychain")
      : undefined;
  const credentialKey: SecretKey = {
    ...deriveConnectorKey(keychainKeyMaterial ?? randomBytes(32), "keychain"),
    ...(legacyCredentialKey ? { fallbacks: [legacyCredentialKey] } : {}),
  };
  pgArtifactMap?.pool.registerMigration({
    id: "durable-map/keychain_credentials/0002-delete-auto-captured-logins",
    statements: [
      "CREATE TABLE IF NOT EXISTS keychain_credentials (id TEXT PRIMARY KEY, json JSONB NOT NULL)",
      "CREATE TABLE IF NOT EXISTS keychain_grants (id TEXT PRIMARY KEY, json JSONB NOT NULL)",
      `DELETE FROM keychain_grants WHERE json ->> 'credentialId' IN (SELECT id FROM keychain_credentials WHERE json ->> 'origin' = 'device-flow-auto-capture')`,
      `DELETE FROM keychain_credentials WHERE json ->> 'origin' = 'device-flow-auto-capture'`,
    ],
  });
  const credentialStore: Keychain = createKeychain({
    creds: artifactMap<KeychainCredential>("keychain_credentials", ["ownerId"]),
    grants: artifactMap<KeychainGrant>("keychain_grants", ["ownerId"]),
    asks: artifactMap<KeychainAsk>("keychain_asks"),
    key: credentialKey,
    lock: advisoryLock,
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
  const serviceCreds = withDeploymentCredentials(
    credentialStore,
    scopeId("org", config.orgId),
    config.brokerCredentials ?? [],
  );
  if (config.brokerCredentials?.length) {
    const reserved = new Set(config.brokerCredentials.map((c) => c.slug));
    void credentialStore.listServiceCredentials(scopeId("org", config.orgId)).then(
      (stored) => {
        const shadowed = stored.filter((c) => reserved.has(c.slug)).map((c) => c.slug);
        if (shadowed.length)
          console.warn(`[broker-credentials] BROKER_CREDENTIALS overrides stored credentials: ${shadowed.join(", ")}`);
      },
      (error) =>
        console.warn(`[broker-credentials] could not check for overridden stored credentials: ${errMessage(error)}`),
    );
  }
  const mcpToolService = createMcpToolService({
    servers: mcpServers,
    audit: auditLog,
    ...(keychain ? { userTokens: keychain } : {}),
    ...(config.publicWebUrl
      ? {
          signInUrl: (id: string) =>
            `${config.publicWebUrl!.replace(/\/$/, "")}/connect/${encodeURIComponent(id)}/self-connect`,
        }
      : {}),
  });
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
  const toolOutput =
    config.sessionStore === "postgres" && pgArtifactMap
      ? createPostgresToolOutputStore({
          pool: pgArtifactMap.pool,
          bytesFor: (prefix) =>
            config.snapshotStore === "s3" && config.s3Bucket
              ? createS3DurableByteStore({
                  bucket: config.s3Bucket,
                  ...(config.s3Region ? { region: config.s3Region } : {}),
                  prefix: `${config.s3Prefix ?? ""}${prefix}`,
                })
              : createLocalDurableByteStore(join(config.dataDir, prefix)),
        })
      : createMemoryToolOutputStore({ sessions });
  const runStoreKind = config.runStore;
  const runSignals: RunSignalStore =
    runStoreKind === "postgres"
      ? createPostgresRunSignalStore(requireDbUrl("RUN_STORE"))
      : createMemoryRunSignalStore();
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
    modelGateway: gatewayTransport,
    probe: overrides.modelVerificationProbe,
    fetchImpl: overrides.modelCredentialFetch,
  });
  const modelRegistry = createModelOverlayStore(artifactMap("model_registry"), writeModelRegistry, modelVerifier);
  const refreshCustomProviders = async () => {
    setCustomProviders(await customProviders.enabled());
  };
  const refreshModels = async () => {
    await gatewayCatalog?.refresh();
    await refreshCustomProviders();
    await modelRegistry.refresh();
  };
  const resolveMemoryEmbedder = async (id: string): Promise<MemoryEmbedder> => {
    const model = resolveEmbeddingModel(id);
    if (!model) throw new Error(`Embedding model unavailable: ${id}`);
    const key = model.provider === "openai" ? await modelCredentials.resolve("openai") : null;
    return createMemoryEmbedder(model, key, gatewayTransport, overrides.modelCredentialFetch);
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
  let companyChatGPTAuth: CompanyChatGPTAuth | undefined;
  if (config.codexAuthCredential && keychain)
    companyChatGPTAuth = keychainCompanyChatGPTAuth({ keychain, credentialId: config.codexAuthCredential });
  else if (config.codexAuthFile) companyChatGPTAuth = fileCompanyChatGPTAuth(config.codexAuthFile);
  const resolveCompanySubscriptionKeys = async (): Promise<ProviderKeys> => {
    if (!companyChatGPTAuth) return {};
    try {
      const token = await companyChatGPTAuth.accessToken();
      return token ? { [CODEX_SUBSCRIPTION_PROVIDER]: token } : {};
    } catch (e) {
      console.error(`[model] company ChatGPT auth (${companyChatGPTAuth.description}) unreadable: ${errMessage(e)}`);
      return {};
    }
  };
  const resolvePiProviderKeys = async (): Promise<ProviderKeys> => ({
    ...(await resolveModelProviderKeys()),
    ...(await resolveCompanySubscriptionKeys()),
  });
  const resolveBrowserCompanyKeys = async (includeSubscription = true): Promise<ProviderKeys> =>
    includeSubscription ? resolvePiProviderKeys() : resolveModelProviderKeys();
  const companyModelId = (id: string): string => {
    if (resolveModel(id)?.provider !== "openai" || isOverlayModel(id) || modelRequestOverrides(id)) return id;
    const subscription = codexSubscriptionModelId(id);
    return resolveModel(subscription) ? subscription : id;
  };
  const runtimeOrgScope = scopeId("org", config.orgId);
  const orgBaseModelId = (): string | undefined =>
    configStore.getRuntimeSelection(runtimeOrgScope)?.modelId ?? configStore.getBaseModel(runtimeOrgScope) ?? undefined;
  const defaultForHarness = (harness: string) =>
    defaultModelForHarness(
      harness,
      configuredModelForHarness(config, harness),
      baseModelProviders(config) ??
        (harness === "pi" && gatewayTransport
          ? { ...directProviderAvailability, modelIds: new Set(Object.keys(gatewayTransport.models)) }
          : undefined),
    );
  const adapters = new Map<HarnessId, Harness>([
    [
      "pi",
      overrides.harnesses?.pi ??
        createPiHarness({
          ...piHarnessConfigOptions(config),
          modelGateway: gatewayTransport,
          resolveBaseModelId: () => orgBaseModelId() ?? defaultForHarness("pi"),
          resolveFallbackRuntime: () => configStore.getPurposeRuntime("fallback"),
          resolveProviderKeys: resolvePiProviderKeys,
          ...(directProviderAvailability.codexOAuth ? { companyModelId } : {}),
          signals: runSignals,
        }),
    ],
    [
      "claude",
      overrides.harnesses?.claude ??
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
        }),
    ],
  ]);
  const fallbackHarness = config.harness as HarnessId;
  const fallback = {
    harnessId: fallbackHarness,
    get modelId() {
      return defaultForHarness(fallbackHarness);
    },
  };
  const decide = createDecisionHooks(
    decisions,
    overrides.decisionBackend ??
      createDecisionBackend({
        providers: async (ids) => (await decisions?.providers(ids)) ?? [],
        ...(config.modelGateway?.apiKey
          ? {
              gateway: {
                url: config.modelGateway.url,
                apiKey: config.modelGateway.apiKey,
                ...(config.modelGateway.apiKeyHeader ? { apiKeyHeader: config.modelGateway.apiKeyHeader } : {}),
              },
            }
          : {}),
        credential: async (slug) => {
          const rec = keychain
            ? nonDeploymentCredential(await serviceCreds.getServiceCredentialSecret(scopeId("org", config.orgId), slug))
            : null;
          return rec ? { host: rec.host, enabled: rec.enabled, headers: credentialRequestHeaders(rec) } : null;
        },
      }),
    auditLog,
  );
  const judgeModelId = (): string => config.judgeModelId ?? auxiliaryModelFor(orgBaseModelId() ?? fallback.modelId);
  const hydrateModelCatalog = async (): Promise<unknown> => {
    await refreshModels();
    if (!(await modelCredentials.availability()).openrouter) return undefined;
    return selectableModelCatalog(overrides.modelCredentialFetch);
  };
  const harness = createHarnessRouter(adapters, adapters.get(fallbackHarness)!, async (input, routedBy) => {
    await refreshModels();
    const resolve = (requested: typeof input.runtime) =>
      resolveRuntimeChoiceDurable(
        configStore,
        runtimeOrgScope,
        input.scopeLabel,
        fallback,
        requested,
        hydrateModelCatalog,
        input.runtimePurpose,
      );
    const decision = await decide("turn_start", turnStartState(input), {
      ...(input.runtimeActorId ? { actorId: input.runtimeActorId } : {}),
      scopeLabel: input.scopeLabel,
      sessionId: input.session.id,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.cancel ? { cancel: input.cancel } : {}),
    });
    const routed = await routeTurnRuntime(decision, resolve, async () => {
      if (input.runtimePinned && input.runtime?.harnessId && input.runtime.modelId) {
        if (!modelSupportedByHarness(input.runtime.modelId, input.runtime.harnessId))
          throw new Error(`Unsupported model: ${input.runtime.modelId}`);
        return { ...input.runtime, harnessId: input.runtime.harnessId, modelId: input.runtime.modelId };
      }
      return resolve(input.runtime);
    });
    if (routed.routedBy) routedBy(routed.routedBy);
    return routed.choice;
  });

  if (config.securityScreen === "off" || config.securityScreenClassifier !== "model") {
    delete harness.models.screenSecurity;
  }

  const leaseTtlMs = config.leaseTtlMs;
  const maxAttempts = config.maxAttempts;
  const runStore =
    runStoreKind === "postgres"
      ? createPostgresRunStore(requireDbUrl("RUN_STORE"), { maxClaims: config.maxClaims })
      : createMemoryRunStore({ maxClaims: config.maxClaims });
  const blockingApprovalSessions = async (sessionIds: readonly string[]): Promise<Set<string>> => {
    if (!sessionIds.length) return new Set();
    const wanted = new Set(sessionIds);
    return new Set(
      (await approvals.select({ where: { field: "sessionId", anyOfFold: sessionIds } }))
        .filter(
          (r) => wanted.has(r.sessionId) && r.blocksInput !== false && actorAssertionActive(identity, r.request?.actor),
        )
        .map((r) => r.sessionId),
    );
  };
  const workingAncestors = async (session: Session) => {
    const candidates = await stoppableAncestors(sessions, session);
    const awaiting = await blockingApprovalSessions(candidates.map((ancestor) => ancestor.id));
    const ancestors = candidates.filter((ancestor) => !awaiting.has(ancestor.id));
    return Promise.all(
      ancestors.map(async (ancestor) => ({
        session: ancestor,
        participants: await sessions.participantsOf(ancestor.id),
      })),
    );
  };
  const runs: RunStore = {
    ...runStore.runs,
    async enqueue(input) {
      const enqueue = async () => {
        const known = await sessions.getByThread(input.sessionId);
        if (
          known &&
          (known.parentSessionId || (await sessions.childrenOf(known.id)).length > 0) &&
          !(input.dedupKey && (await runStore.runs.getByDedupKey(input.dedupKey))) &&
          (await sessionTreeRunCount(sessions, runStore.runs, await sessionTreeRoot(sessions, known))) >=
            SUBAGENT_TREE_RUN_CAP
        )
          throw new Error(`all ${SUBAGENT_TREE_RUN_CAP} session run slots are in use`);
        const participants = known ? await sessions.participantsOf(known.id) : [];
        const ancestors = known?.parentSessionId ? await workingAncestors(known) : [];
        const result = await runStore.runs.enqueue(input);
        if (result.deduped) return result;
        sessionStateBus.emit({
          threadRef: input.sessionId,
          ...(known ? { sessionId: known.id } : {}),
          state: "working",
          at: result.run.createdAt,
          participants: participants.length ? participants : [input.request.actor.id],
        });
        for (const ancestor of ancestors)
          sessionStateBus.emit({
            threadRef: ancestor.session.threadRef,
            sessionId: ancestor.session.id,
            state: "working",
            at: result.run.createdAt,
            participants: ancestor.participants,
          });
        return result;
      };
      return advisoryLock.withLock("session-run-admission", enqueue);
    },
  };
  const swarmStoreKind = config.databaseUrl ? "postgres" : "memory";
  const swarms =
    config.swarmsEnabled !== false && config.sessionStore === swarmStoreKind && runStoreKind === swarmStoreKind
      ? createSwarmService({
          defaults: config.swarmDefaults,
          store: createSwarmStore(artifactMap<SwarmStorage>("swarms", ["pending"]), {
            runs,
            sessions,
            ...(pgArtifactMap && runStoreKind === "postgres" ? { pg: pgArtifactMap.pool } : {}),
          }),
          sessions,
          runs,
          sandboxes: sandboxResources,
          lock: advisoryLock,
          signals: runSignals,
          enabled: (actorId) => featureFlags.enabled("swarms", scopeId("personal", actorId)),
          authorize: async (claims) => {
            if (!(await featureFlags.enabled("swarms", scopeId("personal", claims.actorId)))) return false;
            await identity.refresh();
            return (
              identity.isInternal(identity.classify(claims.actorId)) &&
              (claims.members ?? []).every((member) => identity.isInternal(identity.classify(member.id))) &&
              app.authorizesCapabilityScope(claims)
            );
          },
        })
      : undefined;
  const productAnalytics = createProductAnalytics(config.orgId, config.productAnalytics);
  runs.onTerminal((run) => void productAnalytics.responseFinished(run));
  const ledger = runStore.ledger;

  let processes: ProcessRegistry | undefined;
  if (supportsProcessSessions(sandbox)) {
    processes = config.databaseUrl ? createPostgresProcessRegistry(config.databaseUrl) : createMemoryProcessRegistry();
  }

  const appPageViews =
    config.databaseUrl && config.awsDeploy.appsDomain ? createPostgresAppPageViewLog(config.databaseUrl) : undefined;
  const brokerSessions = config.databaseUrl ? createPostgresBrokerSessions(config.databaseUrl) : undefined;
  const replayDedupe = config.databaseUrl ? createPostgresReplayDedupe(config.databaseUrl) : createMemoryReplayDedupe();
  const credentialUsage = config.databaseUrl
    ? createPostgresCredentialUsageSink(config.databaseUrl)
    : createCredentialUsageSink();
  const egressAudit = config.databaseUrl ? createPostgresEgressAuditSink(config.databaseUrl) : createEgressAuditSink();
  const runStreamEvents = config.databaseUrl
    ? createPostgresNotifyBus<RunStreamEvent>(config.databaseUrl, "run_stream", "run-stream")
    : createMemoryEventBus<RunStreamEvent>("run-stream");
  const refreshRunStream = (runId: string): void => runStreamEvents.emit({ runId, kind: "refresh" });
  const turnStream = createTurnStream({
    onDelta: (runId, text, offset, startOffset) => emitRunText(runStreamEvents, runId, text, offset, startOffset),
    onReasoning: (runId, block, text, offset) => emitRunReasoning(runStreamEvents, runId, block, text, offset),
    onChange: refreshRunStream,
  });
  const stopStreamSync = runStreamEvents.subscribe((event) => {
    if (event.kind !== "sync") return;
    const text = turnStream.snapshot(event.runId);
    const startOffset = turnStream.startOffset(event.runId);
    const offset = Math.max(event.offset, startOffset);
    if (text) emitRunText(runStreamEvents, event.runId, text.slice(offset - startOffset), offset, startOffset);
    for (const block of turnStream.reasoning(event.runId)) {
      const sent = event.reasoning?.[reasoningKey(block)] ?? 0;
      if (block.text.length > sent) emitRunReasoning(runStreamEvents, event.runId, block, block.text.slice(sent), sent);
    }
  });
  runs.onTerminal((run) => refreshRunStream(run.id));
  const sessionStateBus: SessionStateBus = config.databaseUrl
    ? createPostgresSessionStateBus(config.databaseUrl)
    : createMemorySessionStateBus();
  const ledgerEventBus: LedgerEventBus = config.databaseUrl
    ? createPostgresLedgerEventBus(config.databaseUrl)
    : createMemoryLedgerEventBus();
  const activityStore: RunActivityStore =
    runStoreKind === "postgres"
      ? createPostgresRunActivityStore(requireDbUrl("RUN_STORE"))
      : createMemoryRunActivityStore();
  const runActivity: RunActivityStore = {
    ...activityStore,
    async append(runId, entry) {
      await activityStore.append(runId, entry);
      refreshRunStream(runId);
    },
  };
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
      onError: sandboxOnError,
    });
  if (config.deployProvider === "fly" && config.flyDeploy.sharedAppName && !config.flyDeploy.wireguardPeers)
    throw new Error("Fly shared apps require FLY_DEPLOY_WIREGUARD_PEERS for private connectivity");
  const flyTunnel =
    config.deployProvider === "fly" && config.flyDeploy.wireguardPeers
      ? createFlyTunnelManager({
          peers: parseFlyWireguardPeers(config.flyDeploy.wireguardPeers),
          claims: artifactMap<FlyPeerClaim>("fly_peer_claims"),
          metadataUri: config.flyDeploy.metadataUri ?? "",
          executable: "wireproxy",
          port: 18096,
        })
      : undefined;
  const buildDeployProvider: Record<Config["deployProvider"], () => DeployProvider> = {
    aws: buildAwsDeploy,
    docker: () => createDockerDeployProvider({ onError: sandboxOnError }),
    fly: () =>
      createFlyDeployProvider({
        ...config.flyDeploy,
        ...(flyTunnel ? { privateTransport: flyTunnel } : {}),
        configStore: artifactMap<FlyMachineConfig>("fly_deploy_configs"),
        portStore: artifactMap<string>("fly_deploy_ports"),
        onError: sandboxOnError,
      }),
    porter: () =>
      createPorterDeployProvider({
        ...config.porterDeploy,
        advisoryLock,
        store: artifactMap<StoredPorterDeployBody>("porter_deploy_bodies"),
        onError: sandboxOnError,
      }),
    e2b: () => {
      const e2b = config.e2bSandbox;
      return createE2bDeployProvider({
        client: e2bClient("apps"),
        ...(e2b.namePrefix ? { namePrefix: e2b.namePrefix } : {}),
        advisoryLock,
        store: artifactMap<StoredE2bDeployBody>("e2b_deploy_bodies"),
        onError: sandboxOnError,
      });
    },
  };
  if (
    config.deployProvider === "fly" &&
    (config.flyDeploy.dataVolumeSizeGb || config.flyDeploy.sharedAppName || config.flyDeploy.wireguardPeers) &&
    !config.databaseUrl
  ) {
    throw new Error("Fly durable application storage requires DATABASE_URL for persistent rollback configuration");
  }
  const deployProvider: DeployProvider = buildDeployProvider[config.deployProvider]();
  if (config.deployProvider === "aws" && !config.awsDeploy.dataBucket && !config.awsSandbox.s3Bucket) {
    console.warn(
      "[wiring] aws deploy: no data bucket resolved (AWS_DEPLOY_DATA_BUCKET unset, sandbox is not aws) — deployed apps have NO durable /data",
    );
  }
  const adminGrantPersist = config.databaseUrl
    ? createPostgresAdminGrantStore(config.databaseUrl)
    : createMapAdminGrantPersistence(createMemoryMap<AdminGrant>());
  const adminGrantStore = createAdminGrantStore(adminGrantPersist, {
    seed: bootAdminGrantSeed(config.adminGrants, config.orgId, !!config.databaseUrl),
  });
  const admin = createAdminService(adminGrantStore, { trustedOidcAdminIssuer: config.trustedOidcAdminIssuer });
  const { strategy: memoryStrategy, memory } = createMemoryStrategy(config.memoryStrategy, {
    harness: harness.models,
    memory: baseMemory,
    captureQuietMs: config.memoryCaptureQuietMs,
    ...(config.memoryCaptureMaxTurns !== undefined ? { captureMaxTurns: config.memoryCaptureMaxTurns } : {}),
    onCaptureError: (e, scope) =>
      errors.record({ category: "memory", code: "capture_failed", message: errMessage(e), scopeLabel: scope }, e),
  });
  const directory = config.databaseUrl ? createPostgresDirectoryStore(config.databaseUrl) : createDirectoryStore();
  const projects = createProjectStore(artifactMap<Project>("projects"), {
    isActiveMember: (principalId) => identity.isInternal(identity.classify(principalId)),
    advisoryLock,
  });
  const canReadScope = createCanReadScope({ managedGroups: projects, directory, identity, teams, sessions });
  const canWriteScope = createCanWriteScope({ managedGroups: projects, directory, identity, teams });
  const canManageScope = createCanManageScope({ managedGroups: projects, directory, identity, sessions });
  const managesArtifactHome = createManagesArtifactHome(
    { managedGroups: projects, directory, identity, teams },
    canManageScope,
  );
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
  const deliveries = withWebTranscriptDeliveries(
    config.databaseUrl ? createPostgresDeliveryStore(config.databaseUrl) : createDeliveryStore(),
    sessions,
  );
  const deployService = createDeployService({
    deliveries,
    deployAppsDomain: config.awsDeploy.appsDomain,
    publicLinksAvailable: !!(config.awsDeploy.appsDomain && config.awsDeploy.gateSecret),
    publicWebUrl: config.publicWebUrl,
    appPublished: productAnalytics.appPublished,
    deployStore,
    provider: deployProvider,
    deployDir: join(config.dataDir, "deployments"),
    auditLog,
    acl,
    leaderLease,
    advisoryLock,
    canReadScope,
    canWriteScope,
    externalSharingAllowed: (ownerScopeId) => externalAppSharingAllowed(featureFlags, ownerScopeId),
    canManageEmail: async (email) => {
      await identity.refresh();
      return (
        identity.isInternal(identity.classify(email)) &&
        ((await directory.get(email))?.type === "internal" ||
          config.emailAuthPrincipals?.includes(email) ||
          Boolean(config.emailAuthDomain && email.endsWith(`@${config.emailAuthDomain}`)) ||
          identity.externalMember(email) !== undefined)
      );
    },
    managesArtifactHome,
    ...(deployGitSecret && deployGitBase
      ? {
          deploymentEnv: async (deployment: Deployment): Promise<Record<string, string>> => {
            const env: Record<string, string> = {
              VIEWER_IDENTITY_KEY: viewerIdentityKey(deployGitSecret, deployment.id),
            };
            const orgScope = scopeId("org", config.orgId);
            const credentials = await deploymentCredentialSlugs(
              await serviceCreds.listServiceCredentials(orgScope),
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
                config.capabilityTokenCompression,
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
  const loopItemsMap = artifactMap<LoopItem>("loop_items", ["loopId"]);
  const loopOwnerCache = new Map<string, string>();
  const publishLoopEvent = (event: import("./loops/ledger-events.ts").LedgerEvent): void => {
    void (async () => {
      let owner = loopOwnerCache.get(event.loopId);
      if (owner === undefined) {
        owner = (await loopStore.get(event.loopId))?.owner ?? "";
        loopOwnerCache.set(event.loopId, owner);
      }
      if (owner) ledgerEventBus.emit({ ...event, owner });
    })().catch(() => {});
  };
  const loopItems = createLoopItemLedger(loopItemsMap, publishLoopEvent, {
    lock: advisoryLock,
    accepts: async (id) => {
      const loop = await loopStore.get(id);
      return Boolean(loop && (loop.surface !== "inbox" || loop.state === "enabled"));
    },
  });
  const loopOutputs = createLoopOutputStore(artifactMap<LoopOutput>("loop_outputs", ["itemId"]), (output) =>
    publishLoopEvent({ loopId: output.loopId, itemId: output.itemId, op: "ready", at: Date.now() }),
  );
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
  pgArtifactMap?.pool.registerMigration(DROP_RUN_AS_MIGRATION);
  pgArtifactMap?.pool.registerMigration(DROP_RECIPIENT_CONSENT_MIGRATION);
  pgArtifactMap?.pool.registerMigration({
    id: "durable-map/turn_wall_clock_configs/0002-drop",
    statements: [
      "DROP TABLE IF EXISTS turn_wall_clock_configs",
      "DELETE FROM durable_map_versions WHERE tbl = 'turn_wall_clock_configs'",
    ],
  });
  pgArtifactMap?.pool.registerMigration({
    id: "durable-map/pinned_skills/0002-drop",
    statements: ["DROP TABLE IF EXISTS pinned_skills", "DELETE FROM durable_map_versions WHERE tbl = 'pinned_skills'"],
  });
  pgArtifactMap?.pool.registerMigration({
    id: "durable-map/internal_member_overrides/0002-drop",
    statements: [
      "DROP TABLE IF EXISTS internal_member_overrides",
      "DELETE FROM durable_map_versions WHERE tbl = 'internal_member_overrides'",
    ],
  });
  pgArtifactMap?.pool.registerMigration(LEGACY_HARNESS_MIGRATION);
  pgArtifactMap?.pool.registerMigration({
    id: "durable-map/suggested_activity_profiles/0001-nightly-on-use",
    statements: [
      "CREATE TABLE IF NOT EXISTS crons (id TEXT PRIMARY KEY, json JSONB NOT NULL)",
      "CREATE TABLE IF NOT EXISTS suggested_activity_profiles (id TEXT PRIMARY KEY, json JSONB NOT NULL)",
      `UPDATE crons c SET json = jsonb_set(c.json, '{schedule,cron}', to_jsonb(get_byte(sha256(convert_to(p.id, 'UTF8')), 0) % 60 || ' 2 * * *')) FROM suggested_activity_profiles p WHERE p.json ->> 'cronId' = c.id AND c.json -> 'schedule' = p.json -> 'managedSchedule'`,
      `UPDATE crons c SET json = jsonb_set(c.json, '{enabled}', 'true') FROM suggested_activity_profiles p WHERE p.json ->> 'cronId' = c.id AND (p.json ->> 'autoPaused')::boolean`,
    ],
  });
  const webhooks = createWebhookStore(artifactMap<Webhook>("webhooks"), artifactMap<WebhookHistory>("webhook_history"));
  pgArtifactMap?.pool.registerMigration({
    id: "durable-map/webhooks/0002-disable-rows-orphaned-by-webhook-removal",
    legacyId: "durable-map/webhooks/0002-disable-rows-orphaned-by-webhook-removal",
    statements: [
      "CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, json JSONB NOT NULL)",
      `UPDATE webhooks SET json = jsonb_set(json, '{enabled}', 'false'::jsonb) WHERE (json ->> 'enabled')::boolean`,
    ],
  });
  const approvals = createApprovalStore(artifactMap<PendingApprovalRecord>("approvals", ["sessionId"]), deliveries);
  let securityScreener = overrides.securityScreener;
  if (!securityScreener && config.securityScreen !== "off" && config.securityScreenProxy) {
    securityScreener = createSecurityScreenProxy({
      ...config.securityScreenProxy,
      timeoutMs: config.securityScreenTimeoutMs,
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
  const prepareSessionRequest = async (request: Parameters<RunStore["enqueue"]>[0]["request"]) => {
    const scope = resolution.scopeFor(request.conversation, request.actor);
    if (!(await canWriteScope(request.actor.id, scope))) throw new Error("session actor no longer has scope access");
    const ref = request.conversation.channelRef;
    if (request.conversation.kind !== "group" || !ref || !projects.recognizes(ref)) return request;
    const version = await projects.version(ref);
    const audience = await currentScopeMembers(scope);
    if (
      !version ||
      !audience ||
      !rosterAdmits(
        audience.map((p) => p.id),
        request.actor.id,
        scope,
      )
    )
      throw new Error("session owner is no longer a member of this project");
    return {
      ...request,
      scopeVersion: version,
      sessionParticipantIds: audience.map((p) => p.id),
      conversation: { ...request.conversation, audience, publishMembers: audience },
    };
  };
  const sessionMailbox = createSessionMailbox(artifactMap<SessionMessage>("session_mailbox", ["recipientId"]));
  const sessionSyscalls = createSessionSyscalls({
    mailbox: sessionMailbox,
    enabled: async (actorId) =>
      (await featureFlags.enabled("persistent_subagents", scopeId("personal", actorId))) ||
      (await featureFlags.enabled("responsive_spine", scopeId("personal", actorId))),
    sessions,
    runs,
    signals: runSignals,
    maxAttempts,
    advisoryLock,
    prepareRequest: prepareSessionRequest,
    authorize: (session, actorId) => canWriteScope(actorId, session.scopeId),
    conversations: {
      search: ({ query, principals, limit }) => app.searchConversations(query, principals, limit),
      list: (actorId) => app.listSessions(actorId),
      start: (actorId, input) => startSession(app, sessions, actorId, input),
    },
    async validateRuntime(input, scope) {
      await resolveRuntimeChoiceDurable(
        configStore,
        runtimeOrgScope,
        scope,
        fallback,
        {
          ...(input.harness ? { harnessId: input.harness as HarnessId } : {}),
          ...(input.model ? { modelId: input.model } : {}),
          ...(input.thinkingLevel ? { effortLevel: input.thinkingLevel } : {}),
          ...(typeof input.fastMode === "boolean" ? { fastMode: input.fastMode } : {}),
        },
        hydrateModelCatalog,
        "subagent",
      );
    },
  });
  const uiState = artifactMap<PersistedUiState>("web_ui_state");
  const orchestratorDeps: OrchestratorDeps = {
    installSharedCanvas: async (actorId, fileId, where) => {
      const canvas = await installSharedCanvas(uiState, actorId, await app.openFileForViewer(fileId, actorId));
      if (typeof canvas === "string") return canvas;
      auditLog.record({
        at: Date.now(),
        principalId: actorId,
        action: "ui.canvas.install",
        resource: `file:${fileId}`,
        scopeLabel: personalScope(actorId),
        detail: `rev ${canvas.rev}`,
      });
      sessionStateBus.emit({ ...where, participants: [actorId], state: "ui", at: Date.now(), ui: { kind: "canvas" } });
      return null;
    },
    sessionStateBus,
    externalSlackPolicies: config.externalSlackPolicies,
    sessionSyscalls,
    refreshModels,
    identity,
    resolution,
    config: configStore,
    defaultHarness: fallbackHarness,
    defaultTurnWallClockMs: config.turnWallClockMs,
    userModelCredentials,
    ...(config.brandingDefault ? { brandingDefault: config.brandingDefault } : {}),
    sessions,
    workspace,
    files,
    toolOutput,
    sandbox,
    sandboxResources,
    swarms,
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
    sandboxCapabilityTtlMs: config.sandboxCapabilityTtlMs,
    ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
    ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
    capabilityTokenCompression: config.capabilityTokenCompression,
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
    ...(config.publicWebUrl ? { publicWebUrl: config.publicWebUrl } : {}),
    ...(config.deployAppsDomain ? { deployAppsDomain: config.deployAppsDomain } : {}),
    ...(config.resendApiKey && config.emailFrom
      ? { inviteMailer: resendMailer(config.resendApiKey, config.emailFrom) }
      : {}),
    ...(config.publicUrl ? { webhookPublicUrl: config.publicUrl } : {}),
    memoryPolicy: { recall: config.memoryRecall, capture: config.memoryCapture },
    memoryStrategy,
    skills,
    skillBundles,
    skillsReady,
    advisoryLock,
    errors,
    ledger,
    signals: runSignals,
    turnStream,
    runActivity,
    runs,
    blobTransfer,
    featureFlags,
    teams,
    credentialUsage,
    connectorStatusCache,
    resolveConnectorClient: resolveClient,
    ...(keychain ? { keychain } : {}),
    serviceCreds,
    deliveries,
    approvals,
    approvalGrants: artifactMap<CommandApprovalGrant>("approval_grants"),
    ...(processes ? { processes } : {}),
    monitors,
    crons,
    webhooks,
    resolveBaseModelId: () => orgBaseModelId() ?? fallback.modelId,
    directory,
    isCurrentSharedScopeMember,
    currentScopeMembers: createCurrentScopeMembers({ managedGroups: projects, directory, identity }, true),
    managedGroups: projects,
    projects,
    ...(config.reachExecEnabled ? { reachExec: true } : {}),
    ...(config.surfaceDebugFooter ? { surfaceDebugFooter: true } : {}),
    environments,
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
  const runResultRecovery = wireRunResultDeliveries(runs, deliveries, recoveryAdminUrlFor, sessions);
  const idempotency = createIdempotencyStore(artifactMap<IdempotencyRecord>("idempotency"));
  const skillFetcher = createGitFetcher(
    keychain
      ? {
          allowLocalRepos: !config.production,
          resolveAuth: (pack) =>
            resolvePackAuth(
              {
                serviceCredential: async (slug) => {
                  const record = nonDeploymentCredential(
                    await serviceCreds.getServiceCredentialSecret(scopeId("org", config.orgId), slug),
                  );
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
    const result = await puller.pull("slack", {
      conversationTarget: container,
      ...(opts?.limit !== undefined ? { count: opts.limit } : {}),
    });
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
    teams,
    externalSlackPolicies: config.externalSlackPolicies,
    admittedWork,
    shutdown: () => inlineShutdown.signal,
    ...(pgArtifactMap ? { resourceSearch: createPostgresResourceSearch(pgArtifactMap.pool) } : {}),
    swarms,
    identity,
    ...(config.publicWebUrl ? { publicWebUrl: config.publicWebUrl } : {}),
    sessions,
    orchestrator,
    runs,
    leaseTtlMs,
    maxAttempts,
    turnStream,
    runStreamEvents,
    runActivity,
    signals: runSignals,
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
    deployAppsDomain: config.awsDeploy.appsDomain,
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
    ...(harness.models.judge
      ? { ambientJudge: (s: string, pr: string, signal?: AbortSignal) => harness.models.judge!(s, pr, signal) }
      : {}),
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
    enqueue: (loop, entries) => loopIngress.enqueueConversation(loop, entries),
  });
  const keychainApprovals = keychain
    ? createKeychainApprovals({
        keychain,
        app,
        identity,
        sessions,
        audit: auditLog,
        deliveries,
        resume: (ask, grant) => askResolution!(ask, grant),
      })
    : undefined;
  const slackCore = createSlackCoreClient({
    identity,
    memory,
    ...(keychainApprovals ? { keychainApprovals } : {}),
    surfaceCache,
    taskAcknowledgements: artifactMap<TaskAckState>("slack_task_acknowledgements"),
    sessionStatus: artifactMap<SlackSessionStatusState>("slack_session_status"),
    statusActivity: { processes, monitors, sessions, publicWebUrl: config.publicWebUrl },
    featureFlags,
    inboxEvent: (event) => inboxRealtime.onConversationEvent(event),
    app,
    leaderLease,
    stagedEnvelopes: artifactMap<StagedEnvelope>("slack_staged_envelopes"),
    config: configStore,
    runtimeFallback: fallback,
    blobTransfer,
    deliveries,
    errors,
    runs,
    turnStream,
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
      const session = await sessions.getByThread(run.sessionId);
      const at = run.finishedAt ?? Date.now();
      if (!session) {
        if (!(await runs.activeForThread(run.sessionId)))
          sessionStateBus.emit({ threadRef: run.sessionId, state: "idle", at });
        return;
      }
      const settle = async (target: Session): Promise<boolean> => {
        if (await runs.activeForThread(target.threadRef)) return false;
        const waiting = (await blockingApprovalSessions([target.id])).has(target.id);
        if (!waiting && (await sessionTreeWorking(sessions, runs, target))) return false;
        const participants = await sessions.participantsOf(target.id);
        sessionStateBus.emit({
          threadRef: target.threadRef,
          sessionId: target.id,
          state: waiting ? "awaiting_approval" : "idle",
          at,
          ...(participants.length ? { participants } : {}),
        });
        return true;
      };
      if (!(await settle(session))) return;
      for (const ancestor of await stoppableAncestors(sessions, session)) if (!(await settle(ancestor))) return;
    })().catch(swallowAs("session-state: terminal emit", undefined));
  });
  let lastSignalPrune = 0;
  const returnSessionRun = (run: Run) =>
    advisoryLock
      .withLock("session-tree-admission", async () => {
        const settled = await deliverSubagentMail(
          {
            sessions,
            runs,
            maxAttempts,
            mailbox: sessionMailbox,
            prepareRequest: prepareSessionRequest,
            delegationEnabled: (actorId) => featureFlags.enabled("responsive_spine", scopeId("personal", actorId)),
            deliveries,
            signals: runSignals,
          },
          run,
        );
        if (settled) await runs.markReturned(run.id);
      })
      .catch(async (error: unknown) => {
        await runs.deferReturn(run.id, 60_000);
        throw error;
      });
  runs.onTerminal((run) => {
    if (run.sessionId.startsWith("agent:main:subagent:"))
      void returnSessionRun(run).catch(swallowAs("sessions: return", undefined));
  });
  const sweepSessionReturns = async () => {
    let afterId: string | undefined;
    for (;;) {
      const batch = await runs.pendingReturns(100, afterId);
      if (!batch.length) return;
      for (const run of batch) await returnSessionRun(run).catch(swallowAs("sessions: recover return", undefined));
      afterId = batch.at(-1)!.id;
    }
  };
  const approvalDeliverySweeper = createSweeper(
    () => advisoryLock.withLock("approval-deliveries", () => approvals.deliverPending()),
    30_000,
    {
      label: "approval-deliveries",
      immediate: true,
    },
  );
  const sessionReturnSweeper = createSweeper(
    () =>
      advisoryLock.tryWithLock
        ? advisoryLock.tryWithLock("session-return-sweep", sweepSessionReturns)
        : advisoryLock.withLock("session-return-sweep", sweepSessionReturns),
    1_000,
    { label: "session-returns", immediate: true },
  );
  const runResultSweeper = createSweeper(
    () =>
      advisoryLock.tryWithLock
        ? advisoryLock.tryWithLock("run-result-sweep", () => runResultRecovery.sweep())
        : advisoryLock.withLock("run-result-sweep", () => runResultRecovery.sweep()),
    60_000,
    { label: "run-results" },
  );
  const orphanedSignalSweeper = createSweeper(
    async () => {
      for (const runId of await runSignals.pendingRunIds()) {
        const run = await runs.get(runId);
        if (!run || isTerminal(run.status))
          await app.replayOrphanedRunSignals(runId).catch(swallowAs("sessions: recover signal", undefined));
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
  const resolveRecipient = (query: string) => app.resolveRecipient(query);
  const runTriggered = async (req: TurnRequest): Promise<TurnResult> => {
    const slackSource =
      !req.slackSource && (await sessions.getByThread(req.conversation.threadRef))?.surface === "slack"
        ? (await runs.latestForThread(req.conversation.threadRef))?.request.slackSource
        : undefined;
    return app.turn(slackSource ? { ...req, slackSource } : req);
  };
  const askResolution = keychain
    ? (ask: KeychainAsk, grant?: KeychainGrant) =>
        fireAskResolution(
          {
            deliveries,
            idempotency,
            identity,
            run: runTriggered,
            directory,
            currentScopeMembers,
            sessions,
            resolveRecipient,
            getCron: (id) => crons.get(id),
            getAsk: (id) => keychain.getAsk(id),
            getGrant: (id) => keychain.getGrant(id),
          },
          ask,
          grant,
        )
    : undefined;
  const dropResolution = keychain
    ? (drop: DropResolution) =>
        fireDropResolution({ deliveries, idempotency, identity, run: runTriggered, directory, resolveRecipient }, drop)
    : undefined;
  const loopFire: LoopFireService = createLoopFireService({
    admittedWork,
    crons,
    samePerson: (a, b) => app.samePerson(a, b),
    triageEnabledFor: (owner) => featureFlags.enabled("loop_triage", scopeId("personal", owner)),
    lock: advisoryLock,
    loops: loopStore,
    items: loopItems,
    outputs: loopOutputs,
    grants: loopGrants,
    trigger: {
      deliveries,
      idempotency,
      identity,
      run: runTriggered,
      directory,
      currentScopeMembers,
      sessions,
      resolveRecipient,
    },
  });
  const loopIngress = createLoopIngress({
    enabledFor: (owner) => featureFlags.enabled("inbox_loops", scopeId("personal", owner)),
    sources: artifactMap<LoopIngress>("loop_ingress", ["loopId"]),
    deliveries: artifactMap<IngressDelivery>("loop_ingress_deliveries", ["queueKey"]),
    loops: loopStore,
    items: loopItems,
    outputs: loopOutputs,
    fire: loopFire,
    lock: advisoryLock,
    ...(config.gmailPubSub && keychain
      ? { gmailConfig: config.gmailPubSub, gmailClient: createGmailPushClient(keychain, config.gmailPubSub) }
      : {}),
  });
  const loops: LoopServiceDeps = {
    lock: advisoryLock,
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
  let ingressMaintenance: Promise<void> | undefined;
  const suggestedActivityProfiles = artifactMap<SuggestedActivityProfile>("suggested_activity_profiles");
  const memoryTidy = createMemoryTidyService({
    store: artifactMap<MemoryTidyProfile>("memory_tidy_profiles"),
    memory: baseMemory,
    timezone: async (principalId) => (await suggestedActivityProfiles.get(principalId))?.timezone,
    crons,
    scheduler: { notifyChanged: (id) => scheduler.notifyChanged(id) },
  });
  const scheduler = createScheduler({
    admittedWork,
    skipFire: async (cron) => (await memoryTidy.skipFire(cron)) ?? suggestedActivities.skipFire(cron),
    deleteCron: (id) => app.deleteCron(id),
    requireQueueStart: Boolean(config.backgroundDeploymentId),
    advisoryLock,
    crons,
    deliveries,
    idempotency,
    identity,
    run: runTriggered,
    leaderLease,
    directory,
    currentScopeMembers,
    sessions,
    resolveRecipient,
    fireLoop: (loopId, fireKey, cronId) => loopFire.fire(loopId, fireKey, cronId),
    ...(config.databaseUrl
      ? { jobQueue: createPgBossCronQueue(config.databaseUrl, undefined, config.cronFireConcurrency) }
      : {}),
    sweepAsks: async (now) => {
      if (!ingressMaintenance)
        ingressMaintenance = admittedWork
          .run(() => loopIngress.maintain())
          .catch(swallowAs("Loop ingress maintenance", undefined))
          .finally(() => {
            ingressMaintenance = undefined;
          });
      await Promise.all([sweepAsks?.(now), loopFire.sweepStale(now)]);
    },
  });
  const suggestedActivities = createSuggestedActivityService({
    store: suggestedActivityProfiles,
    sessions,
    crons,
    scheduler,
    enabled: config.suggestedActivitiesEnabled === true,
    ...(config.suggestedActivitiesContext ? { context: config.suggestedActivitiesContext } : {}),
  });
  cronChanged.notify = (id) => scheduler.notifyChanged(id);
  orchestratorDeps.control = createControlService(app, scheduler, admin);
  orchestratorDeps.validateScheduledRuntime = (scope, choice, purpose) =>
    availableRuntimeError(
      {
        deps: {
          config: configStore,
          harnessId: fallbackHarness,
          baseModelDefault: fallback.modelId,
          providerKeys: providerKeysPresent(config),
          modelCredentials,
          modelCredentialFetch: overrides.modelCredentialFetch,
          refreshModels,
        },
      },
      scope,
      choice,
      purpose,
    );
  orchestratorDeps.runtime = createRuntimeService(
    {
      config: configStore,
      harnessId: fallbackHarness,
      get baseModelDefault() {
        return fallback.modelId;
      },
      providerKeys: providerKeysPresent(config),
      modelCredentials,
      modelCredentialFetch: overrides.modelCredentialFetch,
      refreshModels,
    },
    app,
  );
  const finishCredentials = (handle: SandboxHandle, processId: string) =>
    finishProcessCredentials({ sandbox, processes: processes!, ...(keychain ? { keychain } : {}) }, handle, processId);
  const monitorPoller: MonitorPoller | null =
    processes && supportsProcessSessions(sandbox)
      ? createMonitorPoller({
          admittedWork,
          monitors,
          processes,
          sandbox,
          deliveries,
          idempotency,
          identity,
          run: runTriggered,
          directory,
          currentScopeMembers,
          sessions,
          resolveRecipient,
          leaderLease,
          onProcessExit: finishCredentials,
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
    run: runTriggered,
    directory,
    currentScopeMembers,
    resolveRecipient,
  });
  const backgroundOwnership: BackgroundOwnershipControl | undefined = config.backgroundDeploymentId
    ? {
        store: createBackgroundOwnershipStore(artifactMap<BackgroundOwnership>("background_ownership")),
        instanceId: randomUUID(),
        deploymentId: config.backgroundDeploymentId,
        active: () => backgroundActive(),
      }
    : undefined;
  const instanceRegistry: InstanceRegistry =
    pgArtifactMap && !backgroundOwnership && config.buildSha && config.backgroundWorkEnabled
      ? createPostgresInstanceRegistry(pgArtifactMap.pool, {
          instanceId: randomUUID(),
          buildSha: config.buildSha,
          startedAt: Date.now(),
        })
      : createNoopInstanceRegistry();
  const drain: DrainController = createDrainController({ registry: instanceRegistry });
  const canClaimRuns = () => backgroundAdmission() && drain.canClaim();
  const workers: Worker[] = Array.from({ length: Math.max(1, config.workers) }, () =>
    createWorker({
      admittedWork,
      runs,
      orchestrator,
      leaseTtlMs,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      errors,
      pollMs: 250,
      canClaim: canClaimRuns,
    }),
  );
  const preemption = createRunPreemption({ runs, workers, canClaim: canClaimRuns });
  const preemptionSweeper = createSweeper(() => preemption.sweep(), 1_000, { label: "run-preemption" });
  const processReaper: ProcessReaper | null = processes
    ? createProcessReaper(processes, {
        intervalMs: config.processReaperIntervalMs,
        ...(supportsProcessSessions(sandbox)
          ? {
              kill: createReaperKillHook(sandbox, { onExit: finishCredentials }),
              afterSweep: createJobComputerSweep({
                resources: sandboxResources,
                sandbox,
                processes: processes!,
                finish: finishCredentials,
                onError: (error, scopeId) =>
                  errors.record(
                    {
                      category: "process_session",
                      code: "job_computer_retire_failed",
                      message: errMessage(error),
                      scopeLabel: scopeId,
                    },
                    error,
                  ),
              }),
            }
          : {}),
        leaderLease,
      })
    : null;
  const MONITOR_RETENTION_SWEEP_MS = 24 * 60 * 60_000;
  const LLM_CAPTURE_SWEEP_MS = 5 * 60_000;
  const LLM_CAPTURE_SWEEP_BUDGET_MS = 30_000;
  const spendSweeper = sessions.refreshSpendRollup
    ? createSweeper(() => leaderLease.hold("spend:refresh", () => sessions.refreshSpendRollup!()), 60_000, {
        label: "spend-refresh",
        immediate: true,
      })
    : null;
  const llmCaptureSweeper = sessions.purgeLlmCaptures
    ? createSweeper(
        () =>
          leaderLease.hold("llm-capture:retention", async (lost) => {
            let leaseLost = false;
            void lost.then(() => (leaseLost = true));
            const purged = await sessions.purgeLlmCaptures!(Date.now() - LLM_CAPTURE_RETENTION_MS, {
              deadline: Date.now() + LLM_CAPTURE_SWEEP_BUDGET_MS,
              stop: () => leaseLost,
            });
            if (purged) console.log(`[llm-capture] purged ${purged} prompt envelope(s) past retention`);
          }),
        LLM_CAPTURE_SWEEP_MS,
        { label: "llm-capture-retention" },
      )
    : null;
  const monitorRetentionSweeper = createSweeper(
    () => leaderLease.hold("monitor:retention:sweep", () => monitors.deleteDefunct(Date.now())),
    MONITOR_RETENTION_SWEEP_MS,
    { label: "monitor-retention", immediate: true },
  );
  const deployIdleTtlMs = deployProvider.profile.managedScaleToZero ? undefined : config.deployIdleTtlMs;
  const BLOB_TTL_MS = 6 * 60 * 60_000;
  const composioReturns = artifactMap<ComposioReturn>("composio_returns");
  const composioReturnSweeper = createSweeper(
    async () => {
      for (const [id, entry] of await composioReturns.entries())
        if (entry.expiresAt <= Date.now()) await composioReturns.delete(id);
    },
    30 * 60_000,
    { label: "Composio consent returns", immediate: true },
  );
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
  const DEPLOY_MAINTENANCE_INTERVAL_MS = 5 * 60_000;
  const deployMaintenanceSweeper = createSweeper(() => app.maintainDeployments(), DEPLOY_MAINTENANCE_INTERVAL_MS);
  const deepIdleMachineMs = config.deepIdleMachineMs;
  const devIdleMachineMs = config.devIdleMachineMs;
  const SANDBOX_MAINTENANCE_INTERVAL_MS = 5 * 60_000;
  const deepIdleReapEnabled = Boolean(sandbox.reapDeepIdle && (deepIdleMachineMs > 0 || devIdleMachineMs > 0));
  const deepIdleSweeper = deepIdleReapEnabled
    ? createSweeper(
        () =>
          leaderLease.hold("sandbox:deep-idle-reaper", () =>
            sandbox.reapDeepIdle!(deepIdleMachineMs, devIdleMachineMs),
          ),
        SANDBOX_MAINTENANCE_INTERVAL_MS,
        { immediate: true },
      )
    : null;
  let backgroundRunning = false;
  let backgroundStopping: Promise<void> | null = null;
  let backgroundClaimsStopping: Promise<void> = Promise.resolve();
  let monitorDrained: Promise<void> = Promise.resolve();
  let backgroundGeneration = 0;
  function startBackground(): void {
    if (backgroundRunning) return;
    backgroundRunning = true;
    admittedWork.resume();
    drain.start();
    const generation = ++backgroundGeneration;
    for (const worker of workers) {
      const drained = worker.drained();
      worker.start();
      void drained
        .then(() => {
          if (backgroundRunning && generation === backgroundGeneration) worker.start();
        })
        .catch(swallowAs("wiring: worker resume failed", undefined));
    }
    preemptionSweeper.start();
    const startPeriodic = () => {
      if (!backgroundRunning || generation !== backgroundGeneration) return;
      reaper.start();
      processReaper?.start();
      monitorPoller?.start(config.monitorPollMs);
      void monitorDrained
        .then(() => {
          if (backgroundRunning && generation === backgroundGeneration) monitorPoller?.start(config.monitorPollMs);
        })
        .catch(swallowAs("wiring: monitor resume failed", undefined));
      monitorRetentionSweeper.start();
      spendSweeper?.start();
      llmCaptureSweeper?.start();
      semanticMemory.start();
      if (config.skillSyncPollMs > 0) skillSyncEngine.start(config.skillSyncPollMs);
      blobSweeper.start();
      composioReturnSweeper.start();
      fileUploads?.start();
      idleSweeper?.start();
      deployMaintenanceSweeper.start();
      deepIdleSweeper?.start();
      wakeSweep.start();
      swarms?.start();
      orphanedSignalSweeper.start();
      sessionReturnSweeper.start();
      runResultSweeper.start();
      approvalDeliverySweeper.start();
    };
    if (backgroundStopping)
      void backgroundClaimsStopping.then(startPeriodic).catch(swallowAs("wiring: periodic resume failed", undefined));
    else startPeriodic();
  }
  function stopBackground(): Promise<void> {
    admittedWork.pause();
    backgroundRunning = false;
    const previous = backgroundStopping;
    backgroundGeneration++;
    const monitorStopping = monitorPoller?.stop();
    monitorDrained = monitorStopping ?? Promise.resolve();
    const stopping = [
      reaper.stop(),
      processReaper?.stop(),
      monitorRetentionSweeper.stop(),
      spendSweeper?.stop(),
      llmCaptureSweeper?.stop(),
      semanticMemory.stop(),
      skillSyncEngine.stop(),
      idleSweeper?.stop(),
      deployMaintenanceSweeper.stop(),
      deepIdleSweeper?.stop(),
      blobSweeper.stop(),
      composioReturnSweeper.stop(),
      fileUploads?.stop(),
      wakeSweep.stop(),
      swarms?.stop(),
      orphanedSignalSweeper.stop(),
      sessionReturnSweeper.stop(),
      runResultSweeper.stop(),
      approvalDeliverySweeper.stop(),
      preemptionSweeper.stop(),
      ...workers.map((worker) => worker.stopClaims()),
    ];
    backgroundClaimsStopping = Promise.all(stopping).then(() => {});
    const draining = Promise.all([previous, backgroundClaimsStopping, monitorStopping])
      .then(() => {})
      .finally(() => {
        if (backgroundStopping === draining) backgroundStopping = null;
      });
    backgroundStopping = draining;
    return draining;
  }
  async function releaseInFlightRuns(): Promise<void> {
    inlineShutdown.abort();
    await Promise.all([
      withTimeout(() => admittedWork.drained(), 3_000, "inline turn handback").catch(
        swallowAs("wiring: inline turn handback failed", undefined),
      ),
      ...workers.map((w) => w.releaseInFlight()),
    ]);
  }
  const runtime: Runtime = {
    start() {
      if (inlineShutdown.signal.aborted) inlineShutdown = new AbortController();
      flyTunnel?.monitor();
      drain.start();
      if (config.backgroundWorkEnabled && !config.backgroundDeploymentId) startBackground();
    },
    startBackground,
    setBackgroundAdmission(canClaim, active) {
      backgroundAdmission = canClaim;
      backgroundActive = active;
    },
    async stopBackgroundClaims() {
      void stopBackground().catch(swallowAs("wiring: background drain failed", undefined));
      await Promise.all([backgroundClaimsStopping, ...workers.map((worker) => worker.stopClaims())]);
    },
    stopBackground,
    async backgroundDrained() {
      await backgroundStopping;
      await Promise.all([admittedWork.drained(), ...workers.map((worker) => worker.drained())]);
    },
    releaseInFlightRuns,
    async stop() {
      await stopBackground();
      await Promise.all([
        withTimeout(() => admittedWork.drained(), config.shutdownDrainMs, "admitted work drain").catch(
          swallowAs("wiring: admitted work drain failed", undefined),
        ),
        ...workers.map((w) => w.stop(config.shutdownDrainMs)),
      ]).catch(swallowAs("wiring: worker drain failed", undefined));
      await releaseInFlightRuns();
      await drain.stop();
      stopStreamSync();
      await Promise.all(
        [
          runs.close?.(),
          runSignals.close?.(),
          sessionStateBus.close?.(),
          ledgerEventBus.close?.(),
          runActivity.close?.(),
          runStreamEvents.close?.(),
        ].map((closing) => closing?.catch(reportFailureAs("shutdown: close event stores", undefined))),
      );
      await harness.turns.close?.();
      await semanticMemory.close();
      await flyTunnel?.stop();
      await errors.flush();
    },
  };

  return {
    app,
    checkReadiness: async (signal) => {
      await pgArtifactMap?.pool.q("SELECT 1", [], { signal });
    },
    ...(screenSecurity ? { screenSecurity } : {}),
    deploymentLayer,
    deploymentLayerStore,
    brokeredTools,
    deploymentLayerReady,
    deploymentLayerRefresh,
    sessions,
    runs,
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
    browserModelGateway: gatewayTransport,
    resolveBrowserCompanyKeys,
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
    loopIngress,
    admin,
    rateLimiter,
    errors,
    crons,
    credentialUsage,
    egressAudit,
    identity,
    principalLinks,
    slackAccounts: artifactMap<SlackAccountLink>("slack_accounts"),
    composioReturns,
    workspace,
    memory,
    ...(keychain ? { keychain } : {}),
    serviceCreds,
    deliveries,
    ...(keychainApprovals ? { keychainApprovals } : {}),
    ...(askResolution ? { fireAskResolution: askResolution } : {}),
    ...(dropResolution ? { fireDropResolution: dropResolution } : {}),
    sandbox,
    sandboxResources,
    advisoryLock,
    blobTransfer,
    files,
    ...(fileUploads ? { fileUploads } : {}),
    featureFlags,
    teams,
    ...(decisions ? { decisions } : {}),
    ...(replayDedupe ? { replayDedupe } : {}),
    ...(brokerSessions ? { brokerSessions } : {}),
    directory,
    projects,
    environments,
    ...(processes ? { processes } : {}),
    ...(appPageViews ? { appPageViews } : {}),
    monitors,
    ...(browserSessionStore ? { browserSessionStore } : {}),
    ...(monitorPoller ? { monitorPoller } : {}),
    ...(ambientJudgments ? { ambientJudgments } : {}),
    ...(ackEmojiPicks ? { ackEmojiPicks } : {}),
    channelPolicy,
    ...(config.suggestedActivitiesEnabled && (config.backgroundWorkEnabled || config.backgroundDeploymentId)
      ? { suggestedActivities }
      : {}),
    ...(backgroundOwnership ? { backgroundOwnership } : {}),
    uiState,
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
    externalSlackPolicies: config.externalSlackPolicies,
    browserModelGateway: built.browserModelGateway,
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
    allowUnauthenticatedCore: config.allowUnauthenticatedCore,
    ...(config.spendExportToken ? { spendExportToken: config.spendExportToken } : {}),
    ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
    ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
    capabilityTokenCompression: config.capabilityTokenCompression,
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
    ...(config.slack ? { slackAllowFrom: config.slack.allowFrom ?? [] } : {}),
    ...(config.resendApiKey && config.emailFrom
      ? { inviteMailer: resendMailer(config.resendApiKey, config.emailFrom) }
      : {}),
    rateLimiter: built.rateLimiter,
    acl: built.acl,
    credentialUsage: built.credentialUsage,
    featureFlags: built.featureFlags,
    ...(built.decisions ? { decisions: built.decisions } : {}),
    ...(built.teams ? { teams: built.teams } : {}),
    egressAudit: built.egressAudit,
    sessions: built.sessions,
    auditLog: built.auditLog,
    errors: built.errors,
    crons: built.crons,
    loops: built.loops,
    deploymentLayer: built.deploymentLayerStore,
    deployDialTimeoutMs: config.deployDialTimeoutMs,
    ...(config.awsDeploy.appsDomain ? { deployAppsDomain: config.awsDeploy.appsDomain } : {}),
    ...(config.awsDeploy.gateSecret ? { deployGateSecret: config.awsDeploy.gateSecret } : {}),
    ...(config.deployAppsSessionSecret ? { deployAppsSessionSecret: config.deployAppsSessionSecret } : {}),
    ...(config.deployAppsLoginUrl ? { deployAppsLoginUrl: config.deployAppsLoginUrl } : {}),
    ...(config.deployAppsLoginPath ? { deployAppsLoginPath: config.deployAppsLoginPath } : {}),
    ...(built.appPageViews ? { appPageViews: built.appPageViews } : {}),
    scheduler: built.scheduler,
    webhookReceiver: built.webhookReceiver,
    loopIngress: built.loopIngress,
    identity: built.identity,
    principalLinks: built.principalLinks,
    slackAccounts: built.slackAccounts,
    composioReturns: built.composioReturns,
    ...(built.keychain ? { keychain: built.keychain } : {}),
    serviceCreds: built.serviceCreds,
    deliveries: built.deliveries,
    ...(built.keychainApprovals ? { keychainApprovals: built.keychainApprovals } : {}),
    ...(built.fireAskResolution ? { fireAskResolution: built.fireAskResolution } : {}),
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
    ...(built.suggestedActivities ? { suggestedActivities: built.suggestedActivities } : {}),
    uiState: built.uiState,
    ...(built.keychain
      ? {
          loopSourceTokens: built.keychain,
          inboxSourceRefresh: createInboxSourceRefresh({
            featureFlags: built.featureFlags,
            items: built.loops.items,
            errors: built.errors,
            enqueue: (loop, entries) => built.loopIngress.enqueueConversation(loop, entries),
            tokens: built.keychain,
            directory: built.directory,
            ...(config.slack?.apiUrl ? { slackApiUrl: config.slack.apiUrl } : {}),
          }),
        }
      : {}),
    loopSlackClient: slackUserClientFactory(config.slack?.apiUrl),
    sessionShares: built.sessionShares,
    sessionShareBytes: built.sessionShareBytes,
    environments: built.environments,
    sandboxResources: built.sandboxResources,
  };
}
