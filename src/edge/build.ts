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
export function buildEdge(config: Config, core: Core) {
  const {
    ackEmojiPicks,
    admittedWork,
    app,
    artifactMap,
    askResolution,
    auditLog,
    blobTransfer,
    configStore,
    deliveries,
    errors,
    fallback,
    featureFlags,
    identity,
    keychain,
    leaderLease,
    loopIngress,
    loopItems,
    loopStore,
    loops,
    memory,
    modelUtilities,
    monitors,
    processes,
    runs,
    sessions,
    surfaceCache,
    turnStream,
  } = core;
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
    ...(modelUtilities.pickAckEmoji ? { pickAckEmoji: (t, c) => modelUtilities.pickAckEmoji!(t, c) } : {}),
  });
  const runtime = {
    start() {
      core.start();
    },
    async stop() {
      core.releaseWaiters();
      await withTimeout(() => admittedWork.drained(), config.shutdownDrainMs, "admitted work drain").catch(
        swallowAs("edge: admitted work drain failed", undefined),
      );
      await core.close();
    },
  };
  return { slackCore, inboxRealtime, ...(keychainApprovals ? { keychainApprovals } : {}), runtime };
}

export type BuiltEdge = ReturnType<typeof buildEdge>;


export function serverDeps(
  config: Config,
  core: Core,
  edge: { keychainApprovals?: KeychainApprovals },
  slackEnvironmentState: "absent" | "configured" | "partial" = "absent",
  slackEnvBotToken?: string,
): Omit<ServerDeps, "control"> {
  const configuredModel = configuredModelForHarness(config, config.harness);
  const carriedModelAuth = harnessCarriedModelAuth(config);
  return {
    externalSlackPolicies: config.externalSlackPolicies,
    modelGatewayTransport: core.modelGatewayTransport,
    resolveBrowserCompanyKeys: core.resolveBrowserCompanyKeys,
    production: config.production,
    checkReadiness: core.checkReadiness,
    ...(core.backgroundOwnership
      ? {
          backgroundOwnership: core.backgroundOwnership,
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
    replayDedupe: core.replayDedupe,
    ...(core.brokerSessions ? { brokerSessions: core.brokerSessions } : {}),
    config: core.config,
    ...(core.screenSecurity ? { screenSecurity: core.screenSecurity } : {}),
    ...(configuredModel ? { baseModelDefault: configuredModel } : {}),
    modelProviders: modelProviderAvailabilityFor(config.harness, providerKeysPresent(config)),
    providerKeys: providerKeysPresent(config),
    modelCredentials: core.modelCredentials,
    userModelCredentials: core.userModelCredentials,
    modelRegistry: core.modelRegistry,
    modelVerifier: core.modelVerifier,
    refreshModels: core.refreshModels,
    customProviders: core.customProviders,
    refreshCustomProviders: core.refreshCustomProviders,
    mcpServers: core.mcpServers,
    mcpToolService: core.mcpToolService,
    ...(config.brandingDefault ? { brandingDefault: config.brandingDefault } : {}),
    ...(carriedModelAuth ? { harnessCarriedModelAuth: carriedModelAuth } : {}),
    harnessId: config.harness,
    connectorTokens: core.connectorTokens,
    slackInstallation: core.slackInstallation,
    slackEnvironmentState,
    ...(config.slackEventsPort ? { slackEventsPort: config.slackEventsPort } : {}),
    ...(slackEnvBotToken ? { slackEnvBotToken } : {}),
    resolveClient: core.resolveClient,
    consentLinks: core.consentLinks,
    oauthFlows: core.oauthFlows,
    secretDrops: core.secretDrops,
    ...(core.fireDropResolution ? { fireDropResolution: core.fireDropResolution } : {}),
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
    ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
    ...(config.publicWebUrl ? { portalUrl: config.publicWebUrl } : {}),
    admin: core.admin,
    ...(config.emailAuthPrincipals ? { emailAuthPrincipals: config.emailAuthPrincipals } : {}),
    ...(config.emailAuthDomain ? { emailAuthDomain: config.emailAuthDomain } : {}),
    ...(config.slack ? { slackAllowFrom: config.slack.allowFrom ?? [] } : {}),
    ...(config.resendApiKey && config.emailFrom
      ? { inviteMailer: resendMailer(config.resendApiKey, config.emailFrom) }
      : {}),
    rateLimiter: core.rateLimiter,
    budget: core.budget,
    acl: core.acl,
    credentialUsage: core.credentialUsage,
    featureFlags: core.featureFlags,
    ...(core.decisions ? { decisions: core.decisions } : {}),
    ...(core.teams ? { teams: core.teams } : {}),
    egressAudit: core.egressAudit,
    sessions: core.sessions,
    auditLog: core.auditLog,
    errors: core.errors,
    crons: core.crons,
    loops: core.loops,
    deploymentLayer: core.deploymentLayerStore,
    deployDialTimeoutMs: config.deployDialTimeoutMs,
    ...(config.awsDeploy.appsDomain ? { deployAppsDomain: config.awsDeploy.appsDomain } : {}),
    ...(config.awsDeploy.gateSecret ? { deployGateSecret: config.awsDeploy.gateSecret } : {}),
    ...(config.deployAppsSessionSecret ? { deployAppsSessionSecret: config.deployAppsSessionSecret } : {}),
    ...(config.deployAppsLoginUrl ? { deployAppsLoginUrl: config.deployAppsLoginUrl } : {}),
    ...(config.deployAppsLoginPath ? { deployAppsLoginPath: config.deployAppsLoginPath } : {}),
    ...(core.appPageViews ? { appPageViews: core.appPageViews } : {}),
    cronRuns: core.cronRuns,
    webhookReceiver: core.webhookReceiver,
    loopIngress: core.loopIngress,
    identity: core.identity,
    principalLinks: core.principalLinks,
    slackAccounts: core.slackAccounts,
    composioReturns: core.composioReturns,
    ...(core.keychain ? { keychain: core.keychain } : {}),
    serviceCreds: core.serviceCreds,
    deliveries: core.deliveries,
    ...(edge.keychainApprovals ? { keychainApprovals: edge.keychainApprovals } : {}),
    ...(core.fireAskResolution ? { fireAskResolution: core.fireAskResolution } : {}),
    runs: core.runs,
    signals: core.signals,
    sessionStateBus: core.sessionStateBus,
    workspace: core.workspace,
    files: core.files,
    ...(core.fileUploads ? { fileUploads: core.fileUploads } : {}),
    memory: core.memory,
    blobTransfer: core.blobTransfer,
    sandboxBackend: core.sandbox.profile.backend,
    egressDeclaredEnforcement: core.sandbox.profile.egressEnforcement ?? "none",
    egressEnforcement: effectiveEgressEnforcement(core.sandbox.profile, {
      signingSecret: config.signingSecret,
      apiBaseUrl: config.apiBaseUrl,
    }),
    egressControlPlaneConfigured: Boolean(config.signingSecret && config.apiBaseUrl),
    sandbox: core.sandbox,
    advisoryLock: core.advisoryLock,
    ...(core.processes ? { processes: core.processes } : {}),
    ...(core.browserSessionStore ? { browserSessionStore: core.browserSessionStore } : {}),
    directory: core.directory,
    ...(core.ambientJudgments ? { ambientJudgments: core.ambientJudgments } : {}),
    ...(core.ackEmojiPicks ? { ackEmojiPicks: core.ackEmojiPicks } : {}),
    channelPolicy: core.channelPolicy,
    ...(core.suggestedActivities ? { suggestedActivities: core.suggestedActivities } : {}),
    uiState: core.uiState,
    ...(core.keychain
      ? {
          loopSourceTokens: core.keychain,
          inboxSourceRefresh: createInboxSourceRefresh({
            featureFlags: core.featureFlags,
            items: core.loops.items,
            errors: core.errors,
            enqueue: (loop, entries) => core.loopIngress.enqueueConversation(loop, entries),
            tokens: core.keychain,
            directory: core.directory,
            ...(config.slack?.apiUrl ? { slackApiUrl: config.slack.apiUrl } : {}),
          }),
        }
      : {}),
    loopSlackClient: slackUserClientFactory(config.slack?.apiUrl),
    sessionShares: core.sessionShares,
    sessionShareBytes: core.sessionShareBytes,
    environments: core.environments,
    sandboxResources: core.sandboxResources,
  };
}
