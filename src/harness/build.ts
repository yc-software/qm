import type { MemoryEmbedder } from "../model/embeddings.ts";
import { nonDeploymentCredential, withDeploymentCredentials } from "../credentials/deployment-credentials.ts";
import { resolveEmbeddingModel } from "../model/pi-models.ts";
import { createPostgresTeamStore, type TeamStore } from "../teams/teams.ts";
import type { DecisionBackend } from "../decisions/decisions.ts";
import { createDecisionHooks, routeTurnRuntime, turnStartState } from "../decisions/hooks.ts";
import { createDecisionBackend } from "../decisions/providers.ts";
import { createPostgresDecisionStore, type DecisionStore } from "../decisions/store.ts";
import type { SlackSessionStatusState } from "../slack/session-status.ts";
import { availableRuntimeError, requestedRuntimeError, type RuntimeDeps } from "../api/runtime-config.ts";
import { createApprovalStore } from "../core/approval-store.ts";
import { createRenderDeployProvider, type StoredRenderDeploy } from "../deploy/render-deploy-provider.ts";
import { createRenderDeployArtifacts, type StoredRenderDeployCredential } from "../deploy/render-deploy-artifacts.ts";
import { createRenderAppStorage, type StoredRenderAppStorage } from "../deploy/render-app-storage.ts";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createRenderWorkspaceStore } from "../workspace/render-workspace-store.ts";
import {
  createRenderSandbox,
  type StoredRenderCleanup,
  type StoredRenderSandbox,
  type StoredRenderScratch,
} from "../sandbox/render-sandbox.ts";
import { createSdkRenderClient } from "../sandbox/render-client.ts";
import { createKeychainApprovals, type KeychainApprovals } from "../credentials/keychain-approval.ts";
import { flushErrorReporting, tracePhase } from "../../plugins/chassis/src/error-reporting.ts";
import { createProductAnalytics } from "../util/product-analytics.ts";
import { createAdmittedWork } from "../util/admitted-work.ts";
import { runSessionSmoke } from "../deployment/postdeploy-smoke.ts";
import {
  createBackgroundOwnershipStore,
  type BackgroundOwnershipControl,
  type BackgroundOwnership,
} from "../runs/background-ownership.ts";
import { loadConnectorSdk } from "../sandbox/connector-sdk.ts";
import { createFlyTunnelManager, parseFlyWireguardPeers } from "../deploy/fly-tunnel-manager.ts";
import type { FlyPeerClaim } from "../deploy/fly-peer-claims.ts";
import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";
import { emitRunReasoning, emitRunText, reasoningKey, type RunStreamEvent } from "../runs/run-stream-events.ts";
import { createPostgresResourceSearch } from "../search/resource-search.ts";
import { createSessionMailbox, type SessionMessage } from "../sessions/session-mailbox.ts";
import type { TaskAckState } from "../slack/task-ack.ts";
import { createLoopIngress, type LoopIngressService, type LoopIngress, type IngressDelivery } from "../loops/ingress.ts";
import { createGmailPushClient } from "../loops/gmail-push.ts";
import { createGatewayCatalog } from "../model/gateway-catalog.ts";
import { createSuggestedActivityService, type SuggestedActivityProfile } from "../suggestions/activities.ts";
import { createMemoryTidyService, withMemoryTidy, type MemoryTidyProfile } from "../memory/tidy.ts";
import { createRuntimeService } from "../harness/runtime-control.ts";
import {
  createSessionSyscalls,
  type SessionSyscallsFactory,
  deliverSubagentMail,
  sessionTreeRoot,
  sessionTreeRunCount,
  sessionTreeWorking,
  stoppableAncestors,
  SUBAGENT_TREE_RUN_CAP,
} from "../sessions/session-syscalls.ts";
import { createMemoryEmbedder } from "../model/embeddings.ts";
import { createSemanticMemory } from "../memory/semantic-memory.ts";
import { createPostgresBrokerSessions, type BrokerSessionStore } from "../auth/broker-sessions.ts";
import { createDirectFileUploads, type DirectFileUploads } from "../files/direct-file-upload.ts";
import { createPostgresFileUploadStore } from "../files/file-upload-store.ts";
import {
  createSandboxResources,
  type SandboxResource,
  type SandboxDefault,
  type SandboxResources,
} from "../sandbox/sandbox-resources.ts";
import { createModelVerifier, type ModelVerifier } from "../model/model-verification.ts";
import type { probeModel } from "../model/pi-runtime.ts";
import { createAwsRoleBroker, type AwsRoleBroker } from "../auth/aws-role-broker.ts";
import type { SessionShare, SessionShareStore } from "../sessions/session-share.ts";
import { createModelOverlayStore, type ModelOverlayStore } from "../model/model-overlay-store.ts";
import { mkdirSync } from "node:fs";
import type { StagedEnvelope } from "../slack/envelope-staging.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  baseModelProviders,
  configuredModelForHarness,
  enabledSandboxBackends,
  harnessCarriedModelAuth,
  providerKeysPresent,
  type Config,
} from "../config.ts";
import type { ServerDeps } from "../api/deps.ts";
import {
  actorAssertionActive,
  createIdentityService,
  type DeactivationRecord,
  type IdentityService,
} from "../identity/identity-service.ts";
import {
  createPrincipalLinkService,
  type PrincipalLink,
  type PrincipalLinkService,
} from "../identity/principal-links.ts";
import type { SlackAccountLink, ComposioReturn } from "../api/routes/composio.ts";
import { installPrincipalLinks } from "../directory/person.ts";
import type { ExternalMember } from "../identity/external-members.ts";
import { resendMailer } from "../../plugins/chassis/src/resend.ts";
import { configStoreMaps, createConfigStore, type ScopedConfigStore } from "../resolution/config-store.ts";
import { createResolutionService } from "../resolution/resolution-service.ts";
import { createAclStore, type AclStore } from "../acl/acl-store.ts";
import { createPostgresGrantStore } from "../acl/postgres-grant-store.ts";
import { createSkillStore, type SkillStore, type Skill } from "../skills/skill-store.ts";
import { createSkillPackStore, type SkillPack } from "../skills/skill-pack-store.ts";
import { createSkillBundleStore, type SkillBundle, type SkillBundleStore } from "../skills/skill-bundle-store.ts";
import { createGitFetcher, resolvePackAuth, type SkillPackFetcher } from "../skills/pack-fetcher.ts";
import { installSeedSkills } from "../skills/seed.ts";
import { createPostgresMapFactory, type DurableMap } from "../persistence/durable-map.ts";
import type { PersistedUiState, UiStateStore } from "../surfaces/ui-state.ts";
import { installSharedCanvas } from "../surfaces/ui-canvas.ts";
import { slackUserClientFactory } from "../loops/sources/slack.ts";
import { configurePgCaTrust, configurePgPooling } from "../persistence/pg-pool.ts";
import { createPostgresLeaderLease, type LeaderLease } from "../persistence/leader-lease.ts";
import { createPostgresAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
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
} from "../types.ts";
import { personalScope, scopeId } from "../types.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { createPostgresAuditLog } from "../admin/postgres-audit-log.ts";
import { createPostgresAppPageViewLog, type AppPageViewLog } from "../deploy/page-views.ts";
import type { RateLimiter } from "../ratelimit/rate-limiter.ts";
import { createPostgresRateLimiter } from "../ratelimit/postgres-rate-limiter.ts";
import { estimateCostUsd, type BudgetTracker } from "../ratelimit/budget.ts";
import type { SecurityScreenProbe } from "../security/security-screener.ts";
import { createPostgresBudgetTracker } from "../ratelimit/postgres-budget.ts";
import { createCronStore, DROP_RUN_AS_MIGRATION, type CronStore } from "../cron/cron-store.ts";
import { DROP_RECIPIENT_CONSENT_MIGRATION } from "../triggers/trigger-store.ts";
import { LEGACY_HARNESS_MIGRATION } from "../model/legacy-harness-migration.ts";
import { createPostgresCronFireStore } from "../cron/fire-store.ts";
import { createLoopStore } from "../loops/loop-store.ts";
import { createLoopItemLedger } from "../loops/item-ledger.ts";
import { createPostgresLedgerEventBus, type LedgerEventBus } from "../loops/ledger-events.ts";
import { createInboxSourceRefresh } from "../loops/inbox-source-refresh.ts";
import { createInboxRealtime } from "../loops/inbox-realtime.ts";
import { createLoopOutputStore } from "../loops/output-store.ts";
import { createShipGrantStore } from "../loops/ship-grant-store.ts";
import { createLoopFireService, type LoopFireService } from "../loops/loop-fire.ts";
import type { LoopServiceDeps } from "../api/routes/loops.ts";
import { createDeliveryStore, type DeliveryStore } from "../delivery/delivery-store.ts";
import { createPostgresDeliveryStore } from "../delivery/postgres-delivery-store.ts";
import { wireRunResultDeliveries } from "../delivery/run-result-delivery.ts";
import { adminSessionUrl } from "../util/admin-links.ts";
import { uuidSchema } from "../util/ids.ts";
import { withWebTranscriptDeliveries } from "../delivery/web-transcript-delivery.ts";
import type { DirectoryStore } from "../directory/directory-store.ts";
import { createPostgresDirectoryStore } from "../directory/postgres-directory-store.ts";
import { createPostgresEnvironmentStore, type EnvironmentStore } from "../environments/environment-store.ts";
import { createIdempotencyStore, type IdempotencyRecord } from "../idempotency/idempotency-store.ts";
import { createScheduler, type Scheduler } from "../cron/scheduler.ts";
import { createPgBossCronQueue } from "../cron/job-queue.ts";
import { createWebhookStore, type WebhookHistory } from "../webhooks/webhook-store.ts";
import { createWebhookReceiver, type WebhookReceiver } from "../webhooks/webhook-receiver.ts";
import { createDeployStore, deployTouchDebounceMs, type Deployment } from "../deploy/deploy-store.ts";
import { viewerIdentityKey } from "../deploy/access-token.ts";
import { deploymentCredentialSlugs } from "../deploy/deployment-credentials.ts";
import { createDockerDeployProvider } from "../deploy/docker-deploy-provider.ts";
import { createAwsDeployProvider, type StoredDeployBody } from "../deploy/aws-deploy-provider.ts";
import { createFlyDeployProvider, type FlyMachineConfig } from "../deploy/fly-deploy-provider.ts";
import { createPorterDeployProvider, type StoredPorterDeployBody } from "../deploy/porter-deploy-provider.ts";
import {
  createE2bDeployProvider,
  E2B_DEPLOY_IDLE_TIMEOUT_SEC,
  type StoredE2bDeployBody,
} from "../deploy/e2b-deploy-provider.ts";
import type { DeployProvider } from "../deploy/deploy-provider.ts";
import { createDeployService } from "../deploy/deploy-service.ts";
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
} from "../resolution/scope-membership.ts";
import type { DeployGitArchive } from "../deploy/deploy-git-store.ts";
import { createLocalWorkspaceStore, type WorkspaceStore } from "../workspace/workspace-store.ts";
import type { MemoryService } from "../memory/memory-service.ts";
import { createConfiguredMemoryService } from "../memory/provider-factory.ts";
import { createPostgresMemoryService } from "../memory/postgres-memory-service.ts";
import { createMcpServerStore, type McpServer, type McpServerStore } from "../mcp/mcp-server-store.ts";
import { createMcpToolService, type McpToolService } from "../mcp/mcp-tool-service.ts";
import {
  createLocalBlobTransferStore,
  createS3BlobTransferStore,
  type BlobTransferStore,
} from "../persistence/blob-transfer.ts";
import {
  createLocalDurableByteStore,
  createS3DurableByteStore,
  type DurableByteStore,
} from "../files/durable-byte-store.ts";
import type { FileArtifactStore } from "../files/file-artifact-store.ts";
import { createPostgresFileArtifactStore } from "../files/postgres-file-artifact-store.ts";
import { createAwsSandbox, type StoredMicrovm } from "../sandbox/aws-sandbox.ts";
import { createLocalSandbox } from "../sandbox/local-sandbox.ts";
import { createSpritesSandbox } from "../sandbox/sprites-sandbox.ts";
import { createSmolmachinesSandbox, type StoredSmolmachinesSandbox } from "../sandbox/smolmachines-sandbox.ts";
import { createAgent37Sandbox } from "../sandbox/agent37-sandbox.ts";
import {
  createConfigEpochResolver,
  createSuperserveSandbox,
  type StoredConfigEpoch,
  type StoredSuperserveSandbox,
} from "../sandbox/superserve-sandbox.ts";
import { createSdkSuperserveClient } from "../sandbox/superserve-client.ts";
import { createE2bSandbox, E2B_TEMPLATE_TOOLS, type StoredE2bSandbox } from "../sandbox/e2b-sandbox.ts";
import { createSdkE2bClient, type E2bClient } from "../sandbox/e2b-client.ts";
import {
  createManagedAgentsSandbox,
  QM_TEMPLATE_TOOLS,
  type StoredManagedAgentsSandbox,
} from "../sandbox/managed-agents-sandbox.ts";
import { createSdkManagedAgentsClient } from "../sandbox/managed-agents-client.ts";
import { s3Client } from "../persistence/s3.ts";
import { createS3SnapshotStore } from "../sandbox/home-snapshot.ts";
import { createModalSandbox, type StoredModalSandbox } from "../sandbox/modal-sandbox.ts";
import { createSdkModalClient } from "../sandbox/modal-client.ts";
import { createPorterSandbox } from "../sandbox/porter-sandbox.ts";
import { createSandboxRouter, type SandboxBackendName } from "../sandbox/sandbox-routing.ts";
import {
  upgradeLegacySandboxes,
  legacySandboxBackendForScope,
  type LegacyRoute,
} from "../sandbox/sandbox-resource-upgrade.ts";
import { effectiveEgressEnforcement, type Sandbox } from "../sandbox/sandbox.ts";
import { withOperatorTokenFallback } from "../credentials/connector-token.ts";
import {
  createAwsSecretsManagerSource,
  createEnvSecretSource,
  createLayeredSecretSource,
} from "../credentials/secret-source.ts";
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
} from "../credentials/keychain.ts";
import {
  fireAskResolution,
  fireDropResolution,
  createAskExpirySweep,
  type DropResolution,
} from "../triggers/keychain-ask.ts";
import { createSecretDropStore, type SecretDropStore, type SecretDropRecord } from "../credentials/secret-drop.ts";
import {
  createFeatureFlagStore,
  externalAppSharingAllowed,
  type FeatureFlagRecord,
  type FeatureFlagStore,
} from "../feature-flags.ts";
import { makeRefresh, withPublicOAuthClients, type OAuthClientResolver, type OAuthState } from "../connectors/oauth.ts";
import {
  createConnectorClientResolver,
  deriveConnectorKey,
  type SecretKey,
} from "../connectors/connector-client-store.ts";
import {
  createBrowserSessionStore,
  type BrowserSessionStore,
  type StoredBrowserSession,
} from "../connectors/browser-session-store.ts";
import type { CredentialUsageSink } from "../admin/credential-usage-sink.ts";
import { createPostgresCredentialUsageSink } from "../admin/postgres-credential-usage-sink.ts";
import type { EgressAuditSink } from "../admin/egress-audit-sink.ts";
import { createPostgresEgressAuditSink } from "../admin/postgres-egress-audit-sink.ts";
import { createConsentLinkStore, type ConsentLinkStore, type ConsentLinkRecord } from "../connectors/consent-link.ts";
import { createOAuthFlowStore, type OAuthFlowStore } from "../connectors/oauth-flow-store.ts";
import { createModelGateway, type ModelGateway } from "../model/model-gateway.ts";
import { createModelCredentialStore, type ModelCredentialStore } from "../model/model-credential-store.ts";
import { refreshChatGPTTokens, refreshClaudeTokens } from "../model/subscription-oauth.ts";
import { createUserModelCredentialStore, type UserModelCredentialStore } from "../model/user-model-credential-store.ts";
import { type ModelGatewayTransportConfig, setProviderBaseUrls } from "../model/provider-endpoints.ts";
import { setCustomProviders } from "../model/custom-providers.ts";
import { createCustomProviderStore, type CustomProviderStore } from "../model/custom-provider-store.ts";
import { createPostgresSessionStore } from "../sessions/postgres-session-store.ts";
import { createPostgresToolOutputStore } from "../sessions/tool-output.ts";
import { LLM_CAPTURE_RETENTION_MS, type SessionStore } from "../sessions/session-store.ts";
import {
  fileCompanyChatGPTAuth,
  keychainCompanyChatGPTAuth,
  type CompanyChatGPTAuth,
} from "../model/company-chatgpt-auth.ts";
import { keychainHarnessAuthEnv } from "../credentials/harness-auth-env.ts";
import { createClaudeHarness, claudeHarnessConfigOptions } from "../harness/claude-harness.ts";
import { createPiHarness, piHarnessConfigOptions } from "../harness/pi-harness.ts";
import { type ProviderKeys } from "../model/pi-runtime.ts";
import { createHarnessRouter } from "../harness/harness-router.ts";
import { resolveRuntimeChoiceDurable } from "../model/runtime-choice.ts";
import { selectableModelCatalog } from "../model/model-catalog.ts";
import type { Harness } from "../agent/harness.ts";
import { createSecurityScreenProxy, type SecurityScreener } from "../security/security-screener.ts";
import { createMemoryStrategy } from "../memory/strategy.ts";
import { createOrchestrator, egressClaimAllowingControlPlane, type OrchestratorDeps } from "../harness/orchestrator.ts";
import {
  mintCapabilityToken,
  CAPABILITY_TTL_MS,
  CREDENTIAL_BROKER_AUD,
  DEPLOYMENT_CREDENTIAL_TTL_MS,
  EGRESS_PROXY_AUD,
} from "../auth/capability-token.ts";
import { createPostgresRunStore } from "../runs/postgres-run-store.ts";
import type { RunSignalStore } from "../runs/run-signal-store.ts";
import { createPostgresRunSignalStore } from "../runs/postgres-run-signal-store.ts";
import { isTerminal, type Run, type RunStore } from "../runs/run-store.ts";
import { createRunPreemption, createWorker, type Worker } from "../runs/worker.ts";
import {
  createNoopInstanceRegistry,
  createPostgresInstanceRegistry,
  type InstanceRegistry,
} from "../runs/instance-registry.ts";
import { createDrainController, type DrainController } from "../runs/drain.ts";
import { createReaper, REAPER_LEASE_KEY, type Reaper } from "../runs/reaper.ts";
import { createSweeper as createUntrackedSweeper, type Sweeper } from "../util/sweeper.ts";
import { createPostgresProcessRegistry, type ProcessRegistry } from "../processes/process-registry.ts";
import { createProcessReaper, createReaperKillHook, type ProcessReaper } from "../processes/process-reaper.ts";
import { createJobComputerSweep } from "../processes/job-computers.ts";
import { createMonitorStore, type MonitorStore } from "../monitors/monitor-store.ts";
import { createMonitorPoller, type MonitorPoller } from "../monitors/monitor-poller.ts";
import { createSkillSyncEngine, type SkillSyncEngine } from "../skills/skill-sync-engine.ts";
import { supportsProcessSessions, type SandboxHandle } from "../sandbox/sandbox.ts";
import { finishProcessCredentials } from "../credentials/execute-files.ts";
import { createTurnStream } from "../runs/turn-stream.ts";
import type { SessionStateBus } from "../runs/session-state-bus.ts";
import { createPostgresSessionStateBus } from "../runs/postgres-session-state-bus.ts";
import type { RunActivityStore } from "../runs/run-activity-store.ts";
import { createPostgresRunActivityStore } from "../runs/postgres-run-activity-store.ts";
import { createApp, type App } from "../api/app.ts";
import { startSession } from "../api/start-session.ts";
import { createSwarmStore, type SwarmStorage } from "../swarms/swarm-store.ts";
import { createSwarmService } from "../swarms/swarm-service.ts";
import { createSlackCoreClient, type SlackCoreClient } from "../api/slack-core-client.ts";
import { createSurfaceContextPuller } from "../api/surface-context-puller.ts";
import { createEngagedRegistry } from "../wake/engaged-registry.ts";
import { createWakeSweep, type WakeSweep } from "../wake/sweep.ts";
import { createPostgresSurfaceCache, type SurfaceCache } from "../surface-cache/surface-cache.ts";
import { createPostgresChannelPolicyStore, type ChannelPolicyStore } from "../surface-cache/channel-policy-store.ts";
import {
  createPostgresAmbientJudgmentStore,
  type AmbientJudgmentStore,
} from "../surface-cache/ambient-judgment-store.ts";
import { createPostgresAckEmojiPickStore, type AckEmojiPickStore } from "../surface-cache/ack-emoji-pick-store.ts";
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
} from "../model/pi-models.ts";
import { createAdminService, parseAdminGrants, type AdminService } from "../admin/admin-service.ts";
import { createAdminGrantStore } from "../admin/admin-grant-store.ts";
import { createPostgresAdminGrantStore } from "../admin/postgres-admin-grant-store.ts";
import { createProjectStore, type Project, type ProjectStore } from "../projects/project-store.ts";
import { withErrorReporting, type ErrorLog } from "../admin/error-log.ts";
import { createPostgresReplayDedupe, type ReplayDedupe } from "../auth/replay-dedupe.ts";
import {
  emptyDeploymentLayer,
  loadDeploymentLayer,
  type BrokeredLayerTool,
  type DeploymentLayerRuntime,
} from "../deployment/load-layer.ts";
import {
  createDeploymentLayerStore,
  LAYER_CREATED_BY,
  LAYER_REVIEWER,
  type DeploymentLayerStore,
  type StoredDeploymentLayer,
} from "../deployment/deployment-layer-store.ts";
import { createPostgresErrorLog } from "../admin/postgres-error-log.ts";
import { errMessage, reportFailureAs, swallowAs } from "../util/errors.ts";
import { sleep, withTimeout } from "../util/async.ts";
import { createSlackInstallationStore, type SlackInstallationStore } from "../surfaces/slack-installation.ts";

import type { Core, Runtime } from "../wiring.ts";
import { createControlService } from "../api/control-service.ts";
export interface HarnessOverrides {
  decisionBackend?: DecisionBackend;
  harnesses?: Partial<Record<HarnessId, Harness>>;
}

export function buildHarness(config: Config, core: Core, overrides: HarnessOverrides = {}) {
  const {
    acl,
    admin,
    admittedWork,
    advisoryLock,
    app,
    approvals,
    artifactMap,
    auditLog,
    backgroundOwnership,
    blobTransfer,
    blockingApprovalSessions,
    brokeredTools,
    budget,
    canClaimBackground,
    channelPolicy,
    companyModelId,
    configStore,
    connectorTokens,
    createSweeper,
    credentialUsage,
    cronChanged,
    cronQueue,
    cronRuns,
    crons,
    currentScopeMembers,
    databaseUrl,
    decisions,
    defaultForHarness,
    deliveries,
    deployProvider,
    deployService,
    deploymentLayer,
    directProviderAvailability,
    directory,
    environments,
    errors,
    fallback,
    fallbackHarness,
    featureFlags,
    fileUploads,
    files,
    gatewayTransport,
    harnessNudges,
    hydrateModelCatalog,
    idempotency,
    identity,
    isCurrentSharedScopeMember,
    keychain,
    layerBrokerFor,
    leaderLease,
    leaseTtlMs,
    loopFire,
    loopIngress,
    maxAttempts,
    mcpToolService,
    memory,
    memoryStrategy,
    memoryTidy,
    modelGateway,
    monitors,
    orgBaseModelId,
    pgArtifactMap,
    prepareSessionRequest,
    processes,
    projects,
    rateLimiter,
    refreshModels,
    releaseWaiters,
    resolution,
    resolveClient,
    resolvePiProviderKeys,
    resolveRecipient,
    runActivity,
    runSignals,
    runTriggered,
    runs,
    runtimeDeps,
    runtimeOrgScope,
    semanticMemory,
    composioReturns,
    sandbox,
    sandboxResources,
    securityScreener,
    serviceCreds,
    sessionMailbox,
    sessionStateBus,
    sessionSyscalls,
    sessions,
    setBackgroundAdmission,
    skillBundles,
    skillFetcher,
    skillPacks,
    skills,
    skillsReady,
    suggestedActivityService: suggestedActivities,
    surfaceCache,
    surfaceContext,
    swarms,
    sweepAsks,
    teams,
    toolOutput,
    turnStream,
    uiState,
    userModelCredentials,
    webhooks,
    workspace,
  } = core;
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
  const harness = createHarnessRouter(adapters, adapters.get(fallbackHarness)!, async (input, routedBy) => {
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
    const decision = await tracePhase("turn.decision", () =>
      decide("turn_start", turnStartState(input), {
        ...(input.runtimeActorId ? { actorId: input.runtimeActorId } : {}),
        scopeLabel: input.scopeLabel,
        sessionId: input.session.id,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.cancel ? { cancel: input.cancel } : {}),
      }),
    );
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
    ...(gatewayTransport ? { sandboxModels: true } : {}),
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
    signals: runSignals,
    turnStream,
    runActivity,
    runs,
    blobTransfer,
    featureFlags,
    teams,
    credentialUsage,
    resolveConnectorClient: resolveClient,
    ...(keychain ? { keychain } : {}),
    serviceCreds,
    deliveries,
    approvals,
    approvalGrants: artifactMap<CommandApprovalGrant>("approval_grants", ["actorId"]),
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

  const recoveryAdminBase = config.publicWebUrl?.replace(/\/$/, "");
  const recoveryAdminUrlFor = recoveryAdminBase
    ? (sessionId: string): string | undefined =>
        uuidSchema.safeParse(sessionId).success ? adminSessionUrl(recoveryAdminBase, sessionId) : undefined
    : undefined;
  const runResultRecovery = wireRunResultDeliveries(runs, deliveries, recoveryAdminUrlFor, sessions);
  const reaper: Reaper = createReaper(runs, sessions, {
    intervalMs: config.reaperIntervalMs,
    leaderLease,
    maxAgeMs: config.runMaxAgeMs,
    errors,
  });
  const engaged = createEngagedRegistry();
  const stopNudges = harnessNudges.subscribe({
    engage: (threadRef) => engaged.engage(threadRef),
    poke: () => pokeReaper(),
  });
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
  orchestratorDeps.surfaceContext = surfaceContext;
  orchestratorDeps.channelPolicy = channelPolicy;
  orchestratorDeps.surfaceCache = surfaceCache;
  let ingressMaintenance: Promise<void> | undefined;
  const scheduler = createScheduler({
    admittedWork,
    skipFire: async (cron) => (await memoryTidy.skipFire(cron)) ?? suggestedActivities.skipFire(cron),
    runtimeError: (scope, runtime) => availableRuntimeError({ deps: runtimeDeps }, scope, runtime, "cron"),
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
    jobQueue: cronQueue,
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
  const stopCronChanged = cronChanged.subscribe((id) => scheduler.notifyChanged(id));
  orchestratorDeps.control = createControlService(app, cronRuns, admin);
  orchestratorDeps.validateScheduledRuntime = (scope, choice, purpose) =>
    availableRuntimeError({ deps: runtimeDeps }, scope, choice, purpose);
  orchestratorDeps.runtime = createRuntimeService(runtimeDeps, app);
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
  const instanceRegistry: InstanceRegistry =
    pgArtifactMap && !backgroundOwnership && config.buildSha && config.backgroundWorkEnabled
      ? createPostgresInstanceRegistry(pgArtifactMap.pool, {
          instanceId: randomUUID(),
          buildSha: config.buildSha,
          startedAt: Date.now(),
        })
      : createNoopInstanceRegistry();
  const drain: DrainController = createDrainController({ registry: instanceRegistry });
  const canClaimRuns = () => canClaimBackground() && drain.canClaim();
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
  const deepIdleSweeper = sandbox.reapDeepIdle
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
    releaseWaiters();
    await Promise.all([
      withTimeout(() => admittedWork.drained(), 3_000, "inline turn handback").catch(
        swallowAs("wiring: inline turn handback failed", undefined),
      ),
      ...workers.map((w) => w.releaseInFlight()),
    ]);
  }
  const runtime: Runtime = {
    start() {
      core.start();
      drain.start();
      if (config.backgroundWorkEnabled && !config.backgroundDeploymentId) startBackground();
    },
    startBackground,
    setBackgroundAdmission,
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
      stopCronChanged();
      stopNudges();
      await harness.turns.close?.();
      await core.close();
    },
  };

  return { harness, orchestrator, scheduler, runtime, monitorPoller, skillSyncEngine, reaper, workers };
}

export type BuiltHarness = ReturnType<typeof buildHarness>;
