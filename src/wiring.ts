import type { MemoryEmbedder } from "./model/embeddings.ts";
import {
  resolveEmbeddingModel,
  auxiliaryModelFor,
  codexSubscriptionModelId,
  isOverlayModel,
  modelRequestOverrides,
  auxiliaryModelForProvider,
  resolveModel,
  type HarnessId,
  modelSupportedByHarness,
} from "./model/pi-models.ts";
import { createPostgresTeamStore, type TeamStore } from "./teams/teams.ts";
import type { DecisionBackend } from "./decisions/decisions.ts";
import { createDecisionHooks, routeTurnRuntime, turnStartState } from "./decisions/hooks.ts";
import { createDecisionBackend } from "./decisions/providers.ts";
import { createPostgresDecisionStore, type DecisionStore } from "./decisions/store.ts";
import { createSlackTables, memorySlackRows, type SlackTables } from "./slack/slack-tables.ts";
import { availableRuntimeError } from "./api/runtime-config.ts";
import { createApprovalStore, createPostgresApprovalStore } from "./core/approval-store.ts";
import { createApprovalGrantStore, createPostgresApprovalGrantStore } from "./core/approval-grant-store.ts";
import { createContextRequestStore, createPostgresContextRequestStore } from "./api/context-request-store.ts";
import { createAmbientCursorStore, createPostgresAmbientCursorStore } from "./api/ambient-cursor-store.ts";
import { createRenderDeployProvider, RENDER_DEPLOY_BODIES } from "./deploy/render-deploy-provider.ts";
import { createRenderDeployArtifacts, RENDER_DEPLOY_CREDENTIALS } from "./deploy/render-deploy-artifacts.ts";
import { createRenderAppStorage, RENDER_APP_STORAGE } from "./deploy/render-app-storage.ts";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createRenderWorkspaceStore } from "./workspace/render-workspace-store.ts";
import {
  createRenderSandbox,
  RENDER_SANDBOX_CLEANUP,
  RENDER_SANDBOX_BODIES,
  RENDER_SCRATCH_BODIES,
} from "./sandbox/render-sandbox.ts";
import { createSdkRenderClient } from "./sandbox/render-client.ts";
import { renderSandboxProblem } from "./sandbox/render-limits.ts";
import { createKeychainApprovals, type KeychainApprovals } from "./credentials/keychain-approval.ts";
import { flushErrorReporting, tracePhase } from "../plugins/chassis/src/error-reporting.ts";
import { createProductAnalytics } from "./util/product-analytics.ts";
import { createAdmittedWork } from "./util/admitted-work.ts";
import { runSessionSmoke } from "./deployment/postdeploy-smoke.ts";
import {
  createBackgroundOwnershipStore,
  type BackgroundOwnershipControl,
  createBackgroundOwnershipRows,
} from "./runs/background-ownership.ts";
import { loadConnectorSdk } from "./sandbox/connector-sdk.ts";
import { createFlyTunnelManager, parseFlyWireguardPeers } from "./deploy/fly-tunnel-manager.ts";
import { FLY_PEER_CLAIMS } from "./deploy/fly-peer-claims.ts";
import { emitRunReasoning, emitRunText, createRunStreamBus, serveRunStreamSync } from "./runs/run-stream-events.ts";
import { perTenant, currentTenant, tenantKey, tenantRootScope, withoutTenant } from "./tenants/context.ts";
import { createPostgresResourceSearch } from "./search/resource-search.ts";
import { createPostgresSessionMailbox, createSessionMailbox } from "./sessions/session-mailbox.ts";
import { createLoopIngress, type LoopIngressService } from "./loops/ingress.ts";
import { createLoopTables } from "./loops/tables.ts";
import { createGmailPushClient } from "./loops/gmail-push.ts";
import { createSuggestedActivityService } from "./suggestions/activities.ts";
import { createMemoryTidyService, withMemoryTidy } from "./memory/tidy.ts";
import {
  createMemorySuggestedActivityProfiles,
  createPostgresSuggestedActivityProfiles,
} from "./suggestions/activity-profiles.ts";
import { createMemoryTidyProfiles, createPostgresMemoryTidyProfiles } from "./memory/tidy-profiles.ts";
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
import { createSandboxResources, type SandboxResources } from "./sandbox/sandbox-resources.ts";
import { createModelVerifier, type ModelVerifier } from "./model/model-verification.ts";
import type { probeModel } from "./harness/pi-harness.ts";
import { createAwsRoleBroker, type AwsRoleBroker } from "./auth/aws-role-broker.ts";
import {
  createPostgresSessionShareStore,
  createSessionShareStore,
  type SessionShareStore,
} from "./sessions/session-share.ts";
import { createModelOverlayStore, type ModelOverlayStore } from "./model/model-overlay-store.ts";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { Config } from "./config.ts";
import { createTenantModels, harnessCarriedModelAuthFor } from "./model/tenant-models.ts";
import type { ServerDeps } from "./api/deps.ts";
import {
  actorAssertionActive,
  createDeactivationStore,
  createIdentityService,
  createPostgresDeactivationStore,
  type IdentityService,
} from "./identity/identity-service.ts";
import {
  createPostgresPrincipalLinkStore,
  createPrincipalLinkService,
  createPrincipalLinkStore,
  type PrincipalLinkService,
} from "./identity/principal-links.ts";
import type { SlackAccountRows } from "./api/routes/composio.ts";
import { installPrincipalLinks } from "./directory/person.ts";
import { createExternalMemberStore, createPostgresExternalMemberStore } from "./identity/external-members.ts";
import { resendMailer } from "../plugins/chassis/src/resend.ts";
import { createMemoryConfigStore, type ScopedConfigStore } from "./resolution/config-store.ts";
import { createPostgresConfigTables } from "./resolution/config-tables-pg.ts";
import { createResolutionService } from "./resolution/resolution-service.ts";
import { createAclStore, type AclStore } from "./acl/acl-store.ts";
import { createPostgresGrantStore } from "./acl/postgres-grant-store.ts";
import type { SkillStore } from "./skills/skill-store.ts";
import { createSkillStores } from "./skills/postgres-skill-store.ts";
import type { SkillBundleStore } from "./skills/skill-bundle-store.ts";
import { createGitFetcher, resolvePackAuth, type SkillPackFetcher } from "./skills/pack-fetcher.ts";
import { installSeedSkills, lazySkillBoot } from "./skills/seed.ts";
import { eachTenant, inTenantOf, type EachTenant } from "./tenants/claim.ts";
import { memoryTenants, pgTenants } from "./tenants/resolver.ts";
import { createMemoryMap, createPostgresMapFactory } from "./persistence/durable-map.ts";
import { createPostgresModelTables, memoryModelTables } from "./model/model-tables.ts";
import { createPostgresLinkTables, memoryLinkTables, type ComposioReturnRows } from "./connectors/link-tables.ts";
import { createPostgresKeychainRows } from "./credentials/keychain-pg.ts";
import { memoryKeychainRows } from "./credentials/keychain-rows.ts";
import { createPostgresUiStateStore, createUiStateStore, type UiStateStore } from "./surfaces/ui-state.ts";
import { installSharedCanvas } from "./surfaces/ui-canvas.ts";
import { slackUserClientFactory } from "./loops/sources/slack.ts";
import { configurePgCaTrust, configurePgPooling, createPgPool } from "./persistence/pg-pool.ts";
import { memoryRowTenants, ownerRowTenants, type RowTenants } from "./tenants/row-tenant.ts";
import { ensureInstallTenant } from "./tenants/install.ts";
import { createPostgresLeaderLease, createNoopLeaderLease, type LeaderLease } from "./persistence/leader-lease.ts";
import {
  createMemoryAdvisoryLock,
  createPostgresAdvisoryLock,
  type AdvisoryLock,
} from "./persistence/advisory-lock.ts";
import type { ScopeId, Session, TurnRequest, TurnResult } from "./types.ts";
import { personalScope, scopeId } from "./types.ts";
import { createAuditLog, type AuditLog } from "./audit/audit-log.ts";
import { createPostgresAuditLog } from "./admin/postgres-audit-log.ts";
import { createPostgresAppPageViewLog, type AppPageViewLog } from "./deploy/page-views.ts";
import { createRateLimiter, type RateLimiter } from "./ratelimit/rate-limiter.ts";
import { createPostgresRateLimiter } from "./ratelimit/postgres-rate-limiter.ts";
import { createBudgetTracker, estimateCostUsd, type BudgetTracker } from "./ratelimit/budget.ts";
import type { SecurityScreenProbe } from "./security/security-screener.ts";
import { createPostgresBudgetTracker } from "./ratelimit/postgres-budget.ts";
import { createCronStore, type CronStore } from "./cron/cron-store.ts";
import { createMemoryCronRows, createPostgresCronRows } from "./cron/cron-table.ts";
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
import { uuidSchema } from "./util/ids.ts";
import { withWebTranscriptDeliveries } from "./delivery/web-transcript-delivery.ts";
import { createDirectoryStore, type DirectoryStore } from "./directory/directory-store.ts";
import { createPostgresDirectoryStore } from "./directory/postgres-directory-store.ts";
import {
  createMemoryEnvironmentStore,
  createPostgresEnvironmentStore,
  type EnvironmentStore,
} from "./environments/environment-store.ts";
import { createIdempotencyStore, createPostgresIdempotencyStore } from "./idempotency/idempotency-store.ts";
import { createScheduler, type Scheduler } from "./cron/scheduler.ts";
import { createPgBossCronQueue } from "./cron/job-queue.ts";
import { createWebhookStore } from "./webhooks/webhook-store.ts";
import { createMemoryWebhookRows, createPostgresWebhookRows } from "./webhooks/webhook-table.ts";
import { createWebhookReceiver, type WebhookReceiver } from "./webhooks/webhook-receiver.ts";
import {
  createDeployStore,
  createPostgresDeploymentRows,
  deployTouchDebounceMs,
  type Deployment,
} from "./deploy/deploy-store.ts";
import { viewerIdentityKey } from "./deploy/access-token.ts";
import { deploymentCredentialSlugs } from "./deploy/deployment-credentials.ts";
import { createDockerDeployProvider } from "./deploy/docker-deploy-provider.ts";
import { AWS_DEPLOY_BODIES, createAwsDeployProvider } from "./deploy/aws-deploy-provider.ts";
import { createFlyDeployProvider } from "./deploy/fly-deploy-provider.ts";
import { createFlyPortClaims, FLY_DEPLOY_CONFIGS } from "./deploy/fly-deploy-stores.ts";
import { createPorterDeployProvider, PORTER_DEPLOY_BODIES } from "./deploy/porter-deploy-provider.ts";
import {
  createE2bDeployProvider,
  E2B_DEPLOY_IDLE_TIMEOUT_SEC,
  E2B_DEPLOY_BODIES,
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
import { createPostgresDeployGitArchives } from "./deploy/deploy-git-store.ts";
import { createLocalWorkspaceStore, type WorkspaceStore } from "./workspace/workspace-store.ts";
import { createMemoryService, type MemoryService } from "./memory/memory-service.ts";
import { createConfiguredMemoryService } from "./memory/provider-factory.ts";
import { createPostgresMemoryService } from "./memory/postgres-memory-service.ts";
import { createMcpServerStore, type McpServerStore } from "./mcp/mcp-server-store.ts";
import { createMcpToolService, type McpToolService } from "./mcp/mcp-tool-service.ts";
import {
  createLocalBlobTransferStore,
  createS3BlobTransferStore,
  type BlobTransferStore,
} from "./persistence/blob-transfer.ts";
import {
  createLocalDurableByteStore,
  createS3DurableByteStore,
  FILES_AREA,
  type DurableByteStore,
} from "./files/durable-byte-store.ts";
import { createMemoryFileArtifactStore, type FileArtifactStore } from "./files/file-artifact-store.ts";
import { createPostgresFileArtifactStore } from "./files/postgres-file-artifact-store.ts";
import { createLocalSandbox } from "./sandbox/local-sandbox.ts";
import { createSpritesSandbox, SPRITES_INITIALIZATION } from "./sandbox/sprites-sandbox.ts";
import { createSmolmachinesSandbox, SMOLMACHINES_SANDBOX_BODIES } from "./sandbox/smolmachines-sandbox.ts";
import { createE2bSandbox, E2B_SANDBOX_BODIES, E2B_TEMPLATE_TOOLS } from "./sandbox/e2b-sandbox.ts";
import { createSdkE2bClient, type E2bClient } from "./sandbox/e2b-client.ts";
import {
  createManagedAgentsSandbox,
  QM_TEMPLATE_TOOLS,
  MANAGED_AGENTS_SANDBOX_BODIES,
} from "./sandbox/managed-agents-sandbox.ts";
import { createSdkManagedAgentsClient } from "./sandbox/managed-agents-client.ts";
import { s3Client } from "./persistence/s3.ts";
import { createS3SnapshotStore, HOME_SNAPSHOT_AREAS } from "./sandbox/home-snapshot.ts";
import { createModalSandbox, MODAL_SANDBOX_BODIES } from "./sandbox/modal-sandbox.ts";
import { createSdkModalClient } from "./sandbox/modal-client.ts";
import { createSandboxRouter, type SandboxBackendName } from "./sandbox/sandbox-routing.ts";
import type { Sandbox } from "./sandbox/sandbox.ts";
import { createTenantSettingsStore, type TenantSettingsStore } from "./tenants/settings.ts";
import { tenantSandboxClients, tenantSandboxRouting } from "./sandbox/tenant-credentials.ts";
import { createMemorySandboxResourceStores, createSandboxResourceStores } from "./sandbox/sandbox-resource-store.ts";
import {
  credentialRequestHeaders,
  createKeychain,
  type ConnectorTokenStore,
  type OAuthToken,
  type Keychain,
  type KeychainAsk,
  type KeychainGrant,
  type ServiceCredentialStore,
} from "./credentials/keychain.ts";
import {
  fireAskResolution,
  fireDropResolution,
  createAskExpirySweep,
  type DropResolution,
} from "./triggers/keychain-ask.ts";
import { createSecretDropStore, type SecretDropStore } from "./credentials/secret-drop.ts";
import {
  createFeatureFlagStore,
  createPostgresFeatureFlagStore,
  externalAppSharingAllowed,
  type FeatureFlagStore,
} from "./feature-flags.ts";
import { makeRefresh, withPublicOAuthClients, type OAuthClientResolver } from "./connectors/oauth.ts";
import {
  createConnectorClientResolver,
  deriveConnectorKey,
  type SecretKey,
} from "./connectors/connector-client-store.ts";
import { createBrowserSessionStore, type BrowserSessionStore } from "./connectors/browser-session-store.ts";
import { createCredentialUsageSink, type CredentialUsageSink } from "./admin/credential-usage-sink.ts";
import { createPostgresCredentialUsageSink } from "./admin/postgres-credential-usage-sink.ts";
import { createEgressAuditSink, type EgressAuditSink } from "./admin/egress-audit-sink.ts";
import { createPostgresEgressAuditSink } from "./admin/postgres-egress-audit-sink.ts";
import { createConsentLinkStore, type ConsentLinkStore } from "./connectors/consent-link.ts";
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
import {
  createMemoryToolOutputStore,
  createPostgresToolOutputStore,
  TOOL_OUTPUT_AREA,
} from "./sessions/tool-output.ts";
import { LLM_CAPTURE_RETENTION_MS, type SessionStore } from "./sessions/session-store.ts";
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
import { createMemoryMonitorRows, createPostgresMonitorRows } from "./monitors/monitor-table.ts";
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
import { createSwarmStore } from "./swarms/swarm-store.ts";
import { createMemorySwarmRows, createPostgresSwarmRows } from "./swarms/swarm-table.ts";
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
import { createAdminService, adminGrantSeed, type AdminService } from "./admin/admin-service.ts";
import { composioNamespaceReader } from "./tenants/composio-namespace.ts";
import { createAdminGrantStore, createMapAdminGrantPersistence, type AdminGrant } from "./admin/admin-grant-store.ts";
import { createPostgresAdminGrantStore } from "./admin/postgres-admin-grant-store.ts";
import { createPostgresProjectStore, createProjectStore, type ProjectStore } from "./projects/project-store.ts";
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
  createPostgresDeploymentLayerRows,
  LAYER_CREATED_BY,
  LAYER_REVIEWER,
  type DeploymentLayerStore,
} from "./deployment/deployment-layer-store.ts";
import { keyedRows, memoryRows } from "./persistence/typed-table.ts";
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
  tenantSettings: TenantSettingsStore;
  baseModelDefault: () => string;
  rowTenants: RowTenants;
  checkReadiness: (signal: AbortSignal) => Promise<void>;
  backgroundOwnership?: BackgroundOwnershipControl;
  suggestedActivities?: ReturnType<typeof createSuggestedActivityService>;
  app: App;
  screenSecurity?: SecurityScreenProbe;
  deploymentLayer: DeploymentLayerRuntime;
  brokeredTools: readonly BrokeredLayerTool[];
  deploymentLayerStore: DeploymentLayerStore;
  deploymentLayerReady: () => Promise<unknown>;
  eachTenant: EachTenant;
  boot(): Promise<void>;
  skillsReady: () => Promise<void>;
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
  slackTables?: SlackTables;
  slackInstallation: SlackInstallationStore;
  composioNamespace: () => Promise<string>;
  resolveClient: OAuthClientResolver;
  consentLinks: ConsentLinkStore;
  oauthFlows: OAuthFlowStore;
  secretDrops: SecretDropStore;
  modelGatewayTransport: () => Promise<ModelGatewayTransportConfig | undefined>;
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
  budget: BudgetTracker;
  errors: ErrorLog;
  crons: CronStore;
  credentialUsage: CredentialUsageSink;
  egressAudit: EgressAuditSink;
  identity: IdentityService;
  principalLinks: PrincipalLinkService;
  slackAccounts: SlackAccountRows;
  composioReturns: ComposioReturnRows;
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
    tenantSettings?: TenantSettingsStore;
  } = {},
): BuiltApp {
  const rowTenants = config.databaseUrl ? ownerRowTenants(createPgPool(config.databaseUrl)) : memoryRowTenants;
  let backgroundAdmission = () => !config.backgroundDeploymentId;
  let backgroundActive = () => false;
  const admittedWork = createAdmittedWork({
    canStart: () => !config.backgroundDeploymentId || backgroundAdmission(),
  });
  let inlineShutdown = new AbortController();
  const createSweeper: typeof createUntrackedSweeper = (work, interval, options) =>
    createUntrackedSweeper(() => admittedWork.run(work), interval, options);
  const connectorSecretKey = config.connectorSecretKey;
  if (!connectorSecretKey) throw new Error("CONNECTOR_SECRET_KEY is required");
  configurePgPooling({
    ...(config.databaseUrl ? { databaseUrl: config.databaseUrl } : {}),
    ...(config.databaseOwnerUrl ? { ownerUrl: config.databaseOwnerUrl } : {}),
    ...(config.databaseReaderUrl ? { readerUrl: config.databaseReaderUrl } : {}),
    ...(config.databasePoolUrl ? { poolUrl: config.databasePoolUrl } : {}),
    ...(config.databaseOwnerUrl ? { ownerUrl: config.databaseOwnerUrl } : {}),
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
  const { databaseUrl } = config;
  const pgArtifactMap = databaseUrl ? createPostgresMapFactory(databaseUrl) : null;
  const modelTables = config.databaseUrl ? createPostgresModelTables(config.databaseUrl) : memoryModelTables();
  const linkTables = config.databaseUrl ? createPostgresLinkTables(config.databaseUrl) : memoryLinkTables();
  const tenantSettings =
    overrides.tenantSettings ??
    createTenantSettingsStore({
      ...(pgArtifactMap ? { db: pgArtifactMap.pool, keyMaterial: connectorSecretKey } : {}),
      harness: config.harness,
      onLoad: (tenant, settings) => {
        setProviderBaseUrls(tenant, settings.providerBaseUrls);
        void directModelCredentials
          .availability()
          .then(
            (direct) => tenantModels.noteDirectKeys(tenant, direct),
            reportFailureAs("model keys: load", undefined),
          );
      },
    });
  const directModelCredentials = createModelCredentialStore({
    backing: modelTables.credentials,
    keyMaterial: connectorSecretKey,
  });
  const tenantModels = createTenantModels({
    settings: tenantSettings,
    ...(overrides.modelCredentialFetch ? { fetch: overrides.modelCredentialFetch } : {}),
    anthropicKey: () => directModelCredentials.resolve("anthropic"),
    keychain: () => keychain,
  });
  const modelCredentials: ModelCredentialStore = {
    ...directModelCredentials,
    async availability() {
      const [settings, gateway] = await Promise.all([tenantSettings.get(), tenantModels.gateway()]);
      await gateway?.refresh?.();
      const direct = await directModelCredentials.availability();
      tenantModels.noteDirectKeys(currentTenant(), direct);
      return {
        ...direct,
        ...(settings.codexAuthCredential ? { codexOAuth: true } : {}),
        modelIds: new Set(Object.keys(gateway?.models ?? {})),
      };
    },
  };
  const advisoryLock: AdvisoryLock = pgArtifactMap
    ? createPostgresAdvisoryLock(pgArtifactMap.pool)
    : createMemoryAdvisoryLock();
  const principalLinks = createPrincipalLinkService(
    databaseUrl ? createPostgresPrincipalLinkStore(databaseUrl) : createPrincipalLinkStore(),
    advisoryLock,
  );
  installPrincipalLinks(principalLinks);
  const identity = createIdentityService({
    deactivations: databaseUrl ? createPostgresDeactivationStore(databaseUrl) : createDeactivationStore(),
    directorySyncProtected: async () => (await tenantSettings.get()).emailAuthPrincipals,
    externalMembers: databaseUrl ? createPostgresExternalMemberStore(databaseUrl) : createExternalMemberStore(),
    principalLinks,
  });
  const leaderLease: LeaderLease = pgArtifactMap
    ? createPostgresLeaderLease(pgArtifactMap.pool)
    : createNoopLeaderLease();
  const tenants = eachTenant(pgArtifactMap ? pgTenants(pgArtifactMap.pool) : memoryTenants);
  const tenantLease: LeaderLease = {
    async hold(key, fn) {
      await leaderLease.hold(key, (lost) => {
        let held = true;
        void lost.then(() => (held = false));
        return tenants(async () => held && fn(lost));
      });
      return null;
    },
  };
  const configStore = createMemoryConfigStore({
    ...(config.databaseUrl ? { tables: createPostgresConfigTables(config.databaseUrl) } : {}),
    connectorSecretKey,
  });
  const { skills, skillPacks, skillBundles } = createSkillStores(databaseUrl, {
    advisoryLock,
    ...(config.skillSigningSecret ? { signingSecret: config.skillSigningSecret } : {}),
  });
  const featureFlags = databaseUrl ? createPostgresFeatureFlagStore(databaseUrl) : createFeatureFlagStore();
  const teams = config.databaseUrl ? createPostgresTeamStore(config.databaseUrl, featureFlags) : undefined;
  const decisions = config.databaseUrl ? createPostgresDecisionStore(config.databaseUrl) : undefined;
  const slackTables = config.databaseUrl ? createSlackTables(config.databaseUrl) : undefined;
  const slackInstallation = createSlackInstallationStore(
    (slackTables ?? memorySlackRows()).installation,
    connectorSecretKey,
  );
  const deploymentLayer = config.deploymentLayerDir
    ? loadDeploymentLayer(config.deploymentLayerDir)
    : emptyDeploymentLayer();
  const layerSkillsDir = config.deploymentLayerDir ? resolve(deploymentLayer.dir, "skills") : undefined;
  const brokeredTools = deploymentLayer.brokeredTools;
  const auditLog = config.databaseUrl ? createPostgresAuditLog(config.databaseUrl) : createAuditLog();
  const deploymentLayerStore = createDeploymentLayerStore({
    backing: config.databaseUrl ? createPostgresDeploymentLayerRows(config.databaseUrl) : memoryRows(),
    runtime: deploymentLayer,
    skills,
    skillBundles,
    durable: config.databaseUrl !== undefined,
    advisoryLock,
    auditPersisted: (record) =>
      auditLog.recordOnce!(`deployment-layer:${tenantRootScope()}:${record.version}`, {
        at: record.updatedAt,
        principalId: record.updatedBy,
        action: "deployment_layer.updated",
        resource: record.contentHash,
        scopeLabel: tenantRootScope(),
      }),
    ...(config.seedSkills && layerSkillsDir
      ? {
          seedFallback: () =>
            installSeedSkills(skills, {
              dir: layerSkillsDir,
              scopeId: tenantRootScope(),
              createdBy: LAYER_CREATED_BY,
              reviewer: LAYER_REVIEWER,
            }),
        }
      : {}),
  });
  const deploymentLayerRefresh = createUntrackedSweeper(() => tenants(() => deploymentLayerStore.hydrate()), 30_000, {
    label: "deployment layer refresh",
  });
  const installCatalogs = async (): Promise<void> => {
    await installSeedSkills(skills, { dir: config.skillsSeedDir, scopeId: tenantRootScope(), respectArchived: true });
    for (const dir of config.pluginSkillDirs) {
      if (layerSkillsDir && resolve(dir) === layerSkillsDir) continue;
      await installSeedSkills(skills, {
        dir,
        scopeId: tenantRootScope(),
        createdBy: "system:plugin-skills",
        reviewer: "system:plugin-skills-reviewer",
        respectArchived: true,
      });
    }
  };
  const { layerReady: deploymentLayerReady, skillsReady } = lazySkillBoot(
    () => deploymentLayerStore.hydrate(),
    config.seedSkills ? installCatalogs : undefined,
  );
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
  const resolution = createResolutionService(configStore, acl, async () => {
    const mode = (await tenantSettings.get()).securityScreen;
    return mode === "off" && overrides.securityScreener ? "enforce" : mode;
  });

  const requireDbUrl = (kind: string): string => {
    if (!config.databaseUrl) throw new Error(`${kind}=postgres requires DATABASE_URL`);
    return config.databaseUrl;
  };
  const s3 = config.s3Endpoint ? s3Client(config.s3Region, { endpoint: config.s3Endpoint }) : undefined;
  const s3Override = s3 ? { _client: s3 } : {};
  const workspace =
    config.workspaceStore === "postgres"
      ? createRenderWorkspaceStore(config.dataDir, requireDbUrl("WORKSPACE_STORE"))
      : createLocalWorkspaceStore(config.dataDir);
  const blobTransfer: BlobTransferStore =
    config.transferStore === "s3" && config.s3Bucket
      ? createS3BlobTransferStore({
          ...s3Override,
          bucket: config.s3Bucket,
          ...(config.s3Region ? { region: config.s3Region } : {}),
          ...(config.s3Prefix ? { prefix: config.s3Prefix } : {}),
        })
      : createLocalBlobTransferStore(join(config.dataDir, "transfer"));
  const s3Bytes = config.snapshotStore === "s3" && config.s3Bucket ? config.s3Bucket : undefined;
  const durableBytes = (area: string): DurableByteStore =>
    s3Bytes
      ? createS3DurableByteStore({
          ...s3Override,
          bucket: s3Bytes,
          area,
          ...(config.s3Region ? { region: config.s3Region } : {}),
          ...(config.s3Prefix ? { prefix: config.s3Prefix } : {}),
        })
      : createLocalDurableByteStore(join(config.dataDir, area));
  const fileBytes = durableBytes(FILES_AREA);
  const files: FileArtifactStore = config.databaseUrl
    ? createPostgresFileArtifactStore(config.databaseUrl, fileBytes)
    : createMemoryFileArtifactStore(fileBytes);
  const fileUploads =
    config.databaseUrl && config.snapshotStore === "s3" && config.s3Bucket
      ? createDirectFileUploads({
          ...(s3 ? { client: s3, presign: (command, expiresIn) => getSignedUrl(s3, command, { expiresIn }) } : {}),
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
    leaderLease: tenantLease,
    createSweeper,
  });
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
  const mcpServers = createMcpServerStore(linkTables.mcpServers);
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
      tenants: pgArtifactMap?.pool,
    });
  const tenantClients = tenantSandboxClients(() => tenantSettings.get());
  const buildSprites = (): Sandbox => {
    const { snapshotS3Bucket, ...sprites } = config.spritesSandbox;
    return createSpritesSandbox(workspace, {
      ...sprites,
      token: tenantClients.sprites,
      initializationStore: keyedRows(config.databaseUrl, SPRITES_INITIALIZATION),
      advisoryLock,
      ...(snapshotS3Bucket
        ? { snapshots: createS3SnapshotStore({ bucket: snapshotS3Bucket, prefix: HOME_SNAPSHOT_AREAS.sprites }) }
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
  const smolmachinesBodies = keyedRows(config.databaseUrl, SMOLMACHINES_SANDBOX_BODIES);
  const buildSmolmachines = (): Sandbox => {
    const { snapshotS3Bucket, snapshotIntervalSec, ...smol } = config.smolmachinesSandbox;
    return createSmolmachinesSandbox(workspace, {
      ...smol,
      token: tenantClients.smolmachines,
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
        ? { snapshots: createS3SnapshotStore({ bucket: snapshotS3Bucket, prefix: HOME_SNAPSHOT_AREAS.smolmachines }) }
        : {}),
      onError: sandboxOnError,
    });
  };
  const e2bBodies = keyedRows(config.databaseUrl, E2B_SANDBOX_BODIES);
  const modalBodies = keyedRows(config.databaseUrl, MODAL_SANDBOX_BODIES);
  const renderBodies = keyedRows(config.databaseUrl, RENDER_SANDBOX_BODIES);
  const renderScratch = keyedRows(config.databaseUrl, RENDER_SCRATCH_BODIES);
  const renderCleanup = keyedRows(config.databaseUrl, RENDER_SANDBOX_CLEANUP);
  const e2bClient = (use: "computers" | "apps", apiKey: string): E2bClient => {
    const e2b = config.e2bSandbox;
    const ttlSec = use === "apps" ? E2B_DEPLOY_IDLE_TIMEOUT_SEC : e2b.sandboxTtlSec;
    return createSdkE2bClient({
      apiKey,
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
      client: tenantClients.e2b((apiKey) => e2bClient("computers", apiKey)),
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
        ? { snapshots: createS3SnapshotStore({ bucket: e2b.snapshotS3Bucket, prefix: HOME_SNAPSHOT_AREAS.e2b }) }
        : {}),
      onError: sandboxOnError,
    });
  };
  const managedAgentsBodies = keyedRows(config.databaseUrl, MANAGED_AGENTS_SANDBOX_BODIES);
  const buildManagedAgents = (): Sandbox => {
    const managedAgents = config.managedAgentsSandbox;
    return createManagedAgentsSandbox(workspace, {
      client: tenantClients.managedAgents((apiToken) =>
        createSdkManagedAgentsClient({
          apiToken,
          ...(managedAgents.apiBaseUrl ? { apiBaseUrl: managedAgents.apiBaseUrl } : {}),
          ...(managedAgents.template ? { template: managedAgents.template } : {}),
          ...(managedAgents.sizeSlug ? { sizeSlug: managedAgents.sizeSlug } : {}),
          ...(managedAgents.idleTimeoutSec ? { idleTimeoutSec: managedAgents.idleTimeoutSec } : {}),
          ...(managedAgents.egressProxyUrl ? { egressProxyUrl: managedAgents.egressProxyUrl } : {}),
        }),
      ),
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
            snapshots: createS3SnapshotStore({
              bucket: managedAgents.snapshotS3Bucket,
              prefix: HOME_SNAPSHOT_AREAS.managedAgents,
            }),
          }
        : {}),
      onError: sandboxOnError,
    });
  };
  const buildModal = (): Sandbox => {
    const modal = config.modalSandbox;
    return createModalSandbox(workspace, {
      advisoryLock,
      client: tenantClients.modal(modal.sandboxTimeoutSec, (tokenId, tokenSecret) =>
        createSdkModalClient({
          tokenId,
          tokenSecret,
          appName: modal.appName ?? "qm",
          ...(modal.image ? { image: modal.image } : {}),
          ...(modal.environment ? { environment: modal.environment } : {}),
          ...(modal.cpus !== undefined ? { cpus: modal.cpus } : {}),
          ...(modal.memoryMb !== undefined ? { memoryMb: modal.memoryMb } : {}),
          ...(modal.regions?.length ? { regions: modal.regions } : {}),
          ...(modal.sandboxTimeoutSec ? { sandboxTimeoutMs: modal.sandboxTimeoutSec * 1000 } : {}),
          ...(modal.reapIdleSec ? { idleTimeoutMs: 2 * modal.reapIdleSec * 1000 } : {}),
          ...(modal.snapshotRetentionSec !== undefined
            ? { snapshotRetentionMs: modal.snapshotRetentionSec * 1000 }
            : {}),
          ...(modal.egressProxyUrl ? { egressProxyUrl: modal.egressProxyUrl } : {}),
        }),
      ),
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
        ? { snapshots: createS3SnapshotStore({ bucket: modal.snapshotS3Bucket, prefix: HOME_SNAPSHOT_AREAS.modal }) }
        : {}),
      onError: sandboxOnError,
    });
  };
  const buildRender = (): Sandbox => {
    const render = config.renderSandbox;
    return createRenderSandbox(workspace, {
      client: tenantClients.render((apiKey, workspaceId) => createSdkRenderClient({ apiKey, workspaceId })),
      ...(render.defaultTimeoutSec !== undefined ? { defaultTimeoutSec: render.defaultTimeoutSec } : {}),
      store: renderBodies,
      scratchStore: renderScratch,
      cleanupStore: renderCleanup,
      advisoryLock,
      extraTools: deploymentLayer.advertisedTools,
      credentialPaths: deploymentLayer.credentialPaths,
      layerToolFiles: () => deploymentLayer.installFiles,
      blobTransfer,
      ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
      ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
      ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
      onError: sandboxOnError,
    });
  };
  const renderProblem = renderSandboxProblem(config.workspaceStore, config.renderSandbox.defaultTimeoutSec);
  const buildBackend: Partial<Record<SandboxBackendName, () => Sandbox>> = {
    ...(config.localSandbox.image ? { local: buildLocal } : {}),
    sprites: buildSprites,
    smolmachines: buildSmolmachines,
    e2b: buildE2b,
    modal: buildModal,
    ...(renderProblem ? {} : { render: buildRender }),
    "do-managed-agents": buildManagedAgents,
  };
  const sandboxBackends: Partial<Record<SandboxBackendName, Sandbox>> = Object.fromEntries(
    Object.entries(buildBackend).map(([name, build]) => [name, build()]),
  );
  const misconfiguredSandboxes = renderProblem ? { render: renderProblem } : {};
  const tenantRouting = tenantSandboxRouting(() => tenantSettings.get(), sandboxBackends, misconfiguredSandboxes);
  const sandboxResources = createSandboxResources({
    ...(config.databaseUrl ? createSandboxResourceStores(config.databaseUrl) : createMemorySandboxResourceStores()),
    backends: sandboxBackends,
    defaultBackend: tenantRouting.defaultBackend,
    usableBackends: tenantRouting.usable,
    misconfigured: misconfiguredSandboxes,
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
    defaultBackend: tenantRouting.defaultBackend,
    onError: sandboxOnError,
  });
  const resolveClient: OAuthClientResolver = withPublicOAuthClients(
    createConnectorClientResolver({
      reader: configStore,
    }),
  );
  const keychainKeyMaterial = connectorSecretKey;
  const legacyCredentialKey =
    keychainKeyMaterial && config.signingSecret && config.signingSecret !== keychainKeyMaterial
      ? deriveConnectorKey(config.signingSecret, "keychain")
      : undefined;
  const credentialKey: SecretKey = {
    ...deriveConnectorKey(keychainKeyMaterial, "keychain"),
    ...(legacyCredentialKey ? { fallbacks: [legacyCredentialKey] } : {}),
  };
  const credentialStore: Keychain = createKeychain({
    ...(config.databaseUrl ? createPostgresKeychainRows(config.databaseUrl) : memoryKeychainRows()),
    key: credentialKey,
    lock: advisoryLock,
    refreshConnector: (() => {
      const base = makeRefresh({ resolveClient });
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
  const userModelCredentials = createUserModelCredentialStore({ keychain: credentialStore });
  const keychain: Keychain | undefined = keychainKeyMaterial ? credentialStore : undefined;
  const serviceCreds = credentialStore;
  const mcpToolService = createMcpToolService({
    servers: mcpServers,
    audit: auditLog,
    tenants,
    ...(keychain ? { userTokens: keychain } : {}),
    ...(config.publicWebUrl
      ? {
          signInUrl: (id: string) =>
            `${config.publicWebUrl!.replace(/\/$/, "")}/connect/${encodeURIComponent(id)}/self-connect`,
        }
      : {}),
  });
  const browserSessionStore: BrowserSessionStore | undefined = keychainKeyMaterial
    ? createBrowserSessionStore({ sessions: linkTables.browserSessions, key: credentialKey })
    : undefined;
  const connectorTokens = credentialStore;
  const consentLinks: ConsentLinkStore = createConsentLinkStore(linkTables.consentLinks);
  const oauthFlows: OAuthFlowStore = createOAuthFlowStore(linkTables.oauthFlows);
  const secretDrops: SecretDropStore = createSecretDropStore(linkTables.secretDrops);
  const modelGateway = createModelGateway();

  const sessions: SessionStore =
    config.sessionStore === "postgres"
      ? createPostgresSessionStore(requireDbUrl("SESSION_STORE"))
      : createMemorySessionStore();
  memorySessions.store = sessions;
  const toolOutput =
    config.sessionStore === "postgres" && pgArtifactMap
      ? createPostgresToolOutputStore({
          pool: pgArtifactMap.pool,
          bytes: durableBytes(TOOL_OUTPUT_AREA),
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
    backing: modelTables.customProviders,
    keyMaterial: connectorSecretKey,
  });
  const modelVerifier = createModelVerifier({
    credentials: modelCredentials,
    keyMaterial: connectorSecretKey,
    modelGateway: () => tenantModels.gateway(),
    probe: overrides.modelVerificationProbe,
    fetchImpl: overrides.modelCredentialFetch,
  });
  const modelRegistry = createModelOverlayStore(modelTables.registry, writeModelRegistry, modelVerifier);
  const refreshCustomProviders = async () => {
    setCustomProviders(await customProviders.enabled());
  };
  const refreshModels = async () => {
    await (await tenantModels.gateway())?.refresh?.();
    await refreshCustomProviders();
    await modelRegistry.refresh();
  };
  const resolveMemoryEmbedder = async (id: string): Promise<MemoryEmbedder> => {
    const model = resolveEmbeddingModel(id);
    if (!model) throw new Error(`Embedding model unavailable: ${id}`);
    const key = model.provider === "openai" ? await modelCredentials.resolve("openai") : null;
    return createMemoryEmbedder(model, key, await tenantModels.gateway(), overrides.modelCredentialFetch);
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
  const resolvePiProviderKeys = async (): Promise<ProviderKeys> => ({
    ...(await resolveModelProviderKeys()),
    ...(await tenantModels.subscriptionKeys()),
  });
  const resolveBrowserCompanyKeys = async (includeSubscription = true): Promise<ProviderKeys> =>
    includeSubscription ? resolvePiProviderKeys() : resolveModelProviderKeys();
  const companyModelId = (id: string): string => {
    if (!tenantSettings.peek().codexAuthCredential) return id;
    if (resolveModel(id)?.provider !== "openai" || isOverlayModel(id) || modelRequestOverrides(id)) return id;
    const subscription = codexSubscriptionModelId(id);
    return resolveModel(subscription) ? subscription : id;
  };
  const orgBaseModelId = (): string | undefined =>
    configStore.getRuntimeSelection(tenantRootScope())?.modelId ??
    configStore.getBaseModel(tenantRootScope()) ??
    undefined;
  const defaultForHarness = (harness: string) => tenantModels.defaultModel(harness);
  const adapters = new Map<HarnessId, Harness>([
    [
      "pi",
      overrides.harnesses?.pi ??
        createPiHarness({
          ...piHarnessConfigOptions(config),
          defaultModelId: () => defaultForHarness("pi"),
          detectModelId: () => tenantSettings.peek().piDetectModel,
          titleModelId: () => tenantSettings.peek().piTitleModel,
          judgeModelId: () => tenantSettings.peek().piJudgeModel,
          resolveModelGateway: () => tenantModels.gateway(),
          resolveBaseModelId: () => orgBaseModelId() ?? defaultForHarness("pi"),
          resolveFallbackRuntime: () => configStore.getPurposeRuntime("fallback"),
          resolveProviderKeys: resolvePiProviderKeys,
          companyModelId,
          signals: runSignals,
        }),
    ],
    [
      "claude",
      overrides.harnesses?.claude ??
        createClaudeHarness({
          ...claudeHarnessConfigOptions(config),
          defaultModelId: () => tenantSettings.peek().claudeModel,
          judgeModelId: () => tenantSettings.peek().piJudgeModel,
          authEnv: () => tenantModels.claudeAuthEnv(),
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
        gateway: async () => (await tenantSettings.get()).modelGateway,
        credential: async (slug) => {
          const rec = keychain ? await serviceCreds.getServiceCredentialSecret(tenantRootScope(), slug) : null;
          return rec ? { host: rec.host, enabled: rec.enabled, headers: credentialRequestHeaders(rec) } : null;
        },
      }),
    auditLog,
  );
  const judgeModelId = async (): Promise<string> =>
    (await tenantSettings.get()).piJudgeModel ?? auxiliaryModelFor(orgBaseModelId() ?? fallback.modelId);
  const hydrateModelCatalog = async (): Promise<unknown> => {
    await refreshModels();
    if (!(await modelCredentials.availability()).openrouter) return undefined;
    return selectableModelCatalog(overrides.modelCredentialFetch);
  };
  const harness = createHarnessRouter(adapters, adapters.get(fallbackHarness)!, async (input, routedBy) => {
    const resolve = (requested: typeof input.runtime) =>
      resolveRuntimeChoiceDurable(
        configStore,
        tenantRootScope(),
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

  const leaseTtlMs = config.leaseTtlMs;
  const maxAttempts = config.maxAttempts;
  const runStore =
    runStoreKind === "postgres"
      ? createPostgresRunStore(requireDbUrl("RUN_STORE"), { maxClaims: config.maxClaims })
      : createMemoryRunStore({ maxClaims: config.maxClaims });
  const blockingApprovalSessions = async (sessionIds: readonly string[]): Promise<Set<string>> => {
    return new Set(
      (await approvals.forSessions(sessionIds))
        .filter(([, r]) => r.blocksInput !== false && actorAssertionActive(identity, r.request?.actor))
        .map(([, r]) => r.sessionId),
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
      return advisoryLock.withLock(tenantKey("session-run-admission"), enqueue);
    },
  };
  const swarmStoreKind = config.databaseUrl ? "postgres" : "memory";
  const swarms =
    config.swarmsEnabled !== false && config.sessionStore === swarmStoreKind && runStoreKind === swarmStoreKind
      ? createSwarmService({
          defaults: config.swarmDefaults,
          store: createSwarmStore(
            config.databaseUrl
              ? createPostgresSwarmRows(config.databaseUrl)
              : createMemorySwarmRows({ runs, sessions }),
          ),
          sessions,
          runs,
          sandboxes: sandboxResources,
          lock: advisoryLock,
          signals: runSignals,
          tenants,
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
  const productAnalytics = createProductAnalytics(config.productAnalytics);
  runs.onTerminal((run) => void productAnalytics.responseFinished(run));

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
  const runStreamEvents = createRunStreamBus(config.databaseUrl);
  const refreshRunStream = (runId: string): void => runStreamEvents.emit({ runId, kind: "refresh" });
  const turnStream = createTurnStream({
    onDelta: (runId, text, offset, startOffset) => emitRunText(runStreamEvents, runId, text, offset, startOffset),
    onReasoning: (runId, block, text, offset) => emitRunReasoning(runStreamEvents, runId, block, text, offset),
    onChange: refreshRunStream,
  });
  const stopStreamSync = serveRunStreamSync(runStreamEvents, turnStream);
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
    ...(config.databaseUrl ? { deployments: createPostgresDeploymentRows(config.databaseUrl) } : {}),
    touchDebounceMs: deployTouchDebounceMs(config.deployIdleTtlMs),
    git: {
      repoRoot: config.deployGitDir,
      ...(config.databaseUrl ? { archiveStore: createPostgresDeployGitArchives(config.databaseUrl) } : {}),
      ...(s3Bytes ? { archiveBytes: durableBytes("deploy-git") } : {}),
    },
  });
  const renderDeployBodies = keyedRows(config.databaseUrl, RENDER_DEPLOY_BODIES);
  const renderArtifacts =
    config.deployProvider === "render"
      ? createRenderDeployArtifacts({
          baseUrl: config.apiBaseUrl ?? "",
          signingSecret: config.signingSecret ?? "",
          store: keyedRows(config.databaseUrl, RENDER_DEPLOY_CREDENTIALS),
          deployStore,
        })
      : undefined;
  const buildRenderDeploy = (): DeployProvider => {
    const render = config.renderDeploy;
    if (
      !config.databaseUrl ||
      !pgArtifactMap ||
      !config.s3Bucket ||
      !config.s3Endpoint ||
      !render.source ||
      !render.environmentId ||
      !renderArtifacts ||
      !config.connectorSecretKey
    )
      throw new Error(
        "Render app deployment requires the QM database, storage, Git source, environment, and credential keys",
      );
    const storage = createRenderAppStorage({
      apiKey: render.apiKey,
      workspaceId: render.workspaceId,
      environmentId: render.environmentId,
      minioServiceId: render.minioServiceId,
      endpoint: config.s3Endpoint,
      bucket: config.s3Bucket,
      prefix: config.s3Prefix,
      region: config.s3Region,
      store: keyedRows(config.databaseUrl, RENDER_APP_STORAGE),
      keyMaterial: config.connectorSecretKey,
    });
    return createRenderDeployProvider({
      ...render,
      source: render.source,
      environmentId: render.environmentId,
      store: renderDeployBodies,
      artifacts: renderArtifacts,
      advisoryLock,
      resources: storage,
    });
  };
  const buildAwsDeploy = (): DeployProvider =>
    createAwsDeployProvider({
      ...config.awsDeploy,
      advisoryLock,
      store: keyedRows(config.databaseUrl, AWS_DEPLOY_BODIES),
      onError: sandboxOnError,
    });
  if (config.deployProvider === "fly" && config.flyDeploy.sharedAppName && !config.flyDeploy.wireguardPeers)
    throw new Error("Fly shared apps require FLY_DEPLOY_WIREGUARD_PEERS for private connectivity");
  const flyTunnel =
    config.deployProvider === "fly" && config.flyDeploy.wireguardPeers
      ? createFlyTunnelManager({
          peers: parseFlyWireguardPeers(config.flyDeploy.wireguardPeers),
          claims: keyedRows(config.databaseUrl, FLY_PEER_CLAIMS),
          metadataUri: config.flyDeploy.metadataUri ?? "",
          executable: "wireproxy",
          port: 18096,
        })
      : undefined;
  const buildDeployProvider: Record<Config["deployProvider"], () => DeployProvider> = {
    aws: buildAwsDeploy,
    render: buildRenderDeploy,
    docker: () => createDockerDeployProvider({ onError: sandboxOnError }),
    fly: () =>
      createFlyDeployProvider({
        ...config.flyDeploy,
        ...(flyTunnel ? { privateTransport: flyTunnel } : {}),
        configStore: keyedRows(config.databaseUrl, FLY_DEPLOY_CONFIGS),
        portStore: createFlyPortClaims(config.databaseUrl),
        onError: sandboxOnError,
      }),
    porter: () =>
      createPorterDeployProvider({
        ...config.porterDeploy,
        advisoryLock,
        store: keyedRows(config.databaseUrl, PORTER_DEPLOY_BODIES),
        onError: sandboxOnError,
      }),
    e2b: () => {
      const e2b = config.e2bSandbox;
      if (!e2b.deployApiKey) throw new Error("DEPLOY_PROVIDER=e2b requires E2B_API_KEY");
      return createE2bDeployProvider({
        client: e2bClient("apps", e2b.deployApiKey),
        ...(e2b.namePrefix ? { namePrefix: e2b.namePrefix } : {}),
        advisoryLock,
        store: keyedRows(config.databaseUrl, E2B_DEPLOY_BODIES),
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
  if (config.deployProvider === "aws" && !config.awsDeploy.dataBucket) {
    console.warn("[wiring] aws deploy: AWS_DEPLOY_DATA_BUCKET is unset — deployed apps have NO durable /data");
  }
  const adminGrantPersist = config.databaseUrl
    ? createPostgresAdminGrantStore(config.databaseUrl)
    : createMapAdminGrantPersistence(createMemoryMap<AdminGrant>());
  const adminGrantStore = createAdminGrantStore(adminGrantPersist, {
    seed: async () => adminGrantSeed((await tenantSettings.get()).values.ADMIN_GRANTS, !!config.databaseUrl),
  });
  const admin = createAdminService(adminGrantStore, {
    trustedOidcAdminIssuer: async () => (await tenantSettings.get()).trustedOidcAdminIssuer,
  });
  const { strategy: memoryStrategy, memory } = createMemoryStrategy(config.memoryStrategy, {
    harness: harness.models,
    memory: baseMemory,
    captureQuietMs: config.memoryCaptureQuietMs,
    ...(config.memoryCaptureMaxTurns !== undefined ? { captureMaxTurns: config.memoryCaptureMaxTurns } : {}),
    onCaptureError: (e, scope) =>
      errors.record({ category: "memory", code: "capture_failed", message: errMessage(e), scopeLabel: scope }, e),
  });
  const directory = config.databaseUrl ? createPostgresDirectoryStore(config.databaseUrl) : createDirectoryStore();
  const projectOpts = {
    isActiveMember: (principalId: string) => identity.isInternal(identity.classify(principalId)),
    advisoryLock,
  };
  const projects = databaseUrl ? createPostgresProjectStore(databaseUrl, projectOpts) : createProjectStore(projectOpts);
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
      const { emailAuthPrincipals, emailAuthDomain } = await tenantSettings.get();
      return (
        identity.isInternal(identity.classify(email)) &&
        ((await directory.get(email))?.type === "internal" ||
          emailAuthPrincipals.includes(email) ||
          Boolean(emailAuthDomain && email.endsWith(`@${emailAuthDomain}`)) ||
          identity.externalMember(email) !== undefined)
      );
    },
    managesArtifactHome,
    ...(deployGitSecret && deployGitBase
      ? {
          deploymentEnv: async (deployment: Deployment): Promise<Record<string, string>> => {
            const orgScope = tenantRootScope();
            const credentials = await deploymentCredentialSlugs(
              await serviceCreds.listServiceCredentials(orgScope),
              orgScope,
              acl,
            );
            return {
              VIEWER_IDENTITY_KEY: viewerIdentityKey(deployGitSecret, deployment.id),
              AGENT_API_URL: deployGitBase,
              AGENT_CREDENTIAL_TOKEN: await mintCapabilityToken(
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
              ),
            };
          },
        }
      : {}),
  });
  const environments = config.databaseUrl
    ? createPostgresEnvironmentStore(config.databaseUrl)
    : createMemoryEnvironmentStore();
  const monitors = createMonitorStore(
    config.databaseUrl ? createPostgresMonitorRows(config.databaseUrl) : createMemoryMonitorRows(),
  );
  const loopTables = createLoopTables(config.databaseUrl);
  const loopStore = createLoopStore(loopTables.loops);
  const loopOwnerCache = perTenant(() => new Map<string, string>());
  const publishLoopEvent = (event: import("./loops/ledger-events.ts").LedgerEvent): void => {
    void (async () => {
      let owner = loopOwnerCache().get(event.loopId);
      if (owner === undefined) {
        owner = (await loopStore.get(event.loopId))?.owner ?? "";
        loopOwnerCache().set(event.loopId, owner);
      }
      if (owner) ledgerEventBus.emit({ ...event, owner });
    })().catch(() => {});
  };
  const loopItems = createLoopItemLedger(loopTables.items, publishLoopEvent, {
    lock: advisoryLock,
    accepts: async (id) => {
      const loop = await loopStore.get(id);
      return Boolean(loop && (loop.surface !== "inbox" || loop.state === "enabled"));
    },
  });
  const loopOutputs = createLoopOutputStore(loopTables.outputs, (output) =>
    publishLoopEvent({ loopId: output.loopId, itemId: output.itemId, op: "ready", at: Date.now() }),
  );
  const loopGrants = createShipGrantStore(loopTables.grants);
  const cronChanged: { notify?: (id: string) => void } = {};
  const cronFires = config.databaseUrl ? createPostgresCronFireStore(config.databaseUrl) : createMemoryCronFireStore();
  const cronsBase = createCronStore(
    config.databaseUrl ? createPostgresCronRows(config.databaseUrl) : createMemoryCronRows(),
    {
      staleRunningMs: config.runMaxAgeMs,
      fires: cronFires,
    },
  );
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
  pgArtifactMap?.pool.registerMigration({
    id: "durable-map/0000-versions",
    statements: ["CREATE TABLE IF NOT EXISTS durable_map_versions (tbl TEXT PRIMARY KEY, v BIGINT NOT NULL)"],
  });
  pgArtifactMap?.pool.registerMigration({
    id: "durable-map/turn_wall_clock_configs/0002-drop",
    statements: [
      "DROP TABLE IF EXISTS turn_wall_clock_configs",
      "DELETE FROM durable_map_versions WHERE tbl = 'turn_wall_clock_configs'",
    ],
  });
  pgArtifactMap?.pool.registerMigration({
    id: "durable-map/connector_status/0002-drop",
    statements: [
      "DROP TABLE IF EXISTS connector_status",
      "DELETE FROM durable_map_versions WHERE tbl = 'connector_status'",
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
  const webhooks = createWebhookStore(
    config.databaseUrl ? createPostgresWebhookRows(config.databaseUrl) : createMemoryWebhookRows(),
  );
  const approvals = databaseUrl
    ? createPostgresApprovalStore(databaseUrl, deliveries)
    : createApprovalStore(deliveries);
  const screenProxies = new Map<string, { fingerprint: string; screener: SecurityScreener }>();
  const securityScreener = async (): Promise<SecurityScreener | undefined> => {
    if (overrides.securityScreener) return overrides.securityScreener;
    const proxy = (await tenantSettings.get()).securityScreenProxy;
    if (!proxy) return undefined;
    const tenant = currentTenant();
    const fingerprint = JSON.stringify(proxy);
    const known = screenProxies.get(tenant);
    if (known?.fingerprint === fingerprint) return known.screener;
    const screener = createSecurityScreenProxy({ ...proxy, timeoutMs: config.securityScreenTimeoutMs });
    screenProxies.set(tenant, { fingerprint, screener });
    return screener;
  };
  const layerEnv = config.layerBrokerEnv ?? {};
  const layerBrokerCache = perTenant(() => new Map<string, AwsRoleBroker>());
  const layerBrokerFor = (tool: BrokeredLayerTool): AwsRoleBroker | undefined => {
    const override = overrides.credentialBrokers?.[tool.service];
    if (override) return override;
    const roleArn = layerEnv[tool.broker.roleArnEnv];
    if (!roleArn) return undefined;
    const region = (tool.broker.regionEnv ? layerEnv[tool.broker.regionEnv] : undefined) ?? tool.broker.region;
    if (!region) return undefined;
    const key = JSON.stringify([roleArn, region, tool.broker.sessionActions]);
    let broker = layerBrokerCache().get(key);
    if (!broker) {
      broker = createAwsRoleBroker({ roleArn, region, sessionActions: tool.broker.sessionActions });
      layerBrokerCache().set(key, broker);
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
  const sessionMailbox = config.databaseUrl ? createPostgresSessionMailbox(config.databaseUrl) : createSessionMailbox();
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
        tenantRootScope(),
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
  const uiState = databaseUrl ? createPostgresUiStateStore(databaseUrl) : createUiStateStore();
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
    securityScreener,
    backgroundJobTtlMs: config.backgroundJobTtlMs,
    backgroundJobTtlMaxMs: config.backgroundJobTtlMaxMs,
    sandboxCapabilityTtlMs: config.sandboxCapabilityTtlMs,
    ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
    ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
    capabilityTokenCompression: config.capabilityTokenCompression,
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
    sandboxModels: async () => Boolean(await tenantModels.gateway()),
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
    approvalGrants: databaseUrl ? createPostgresApprovalGrantStore(databaseUrl) : createApprovalGrantStore(),
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
  const idempotency = databaseUrl ? createPostgresIdempotencyStore(databaseUrl) : createIdempotencyStore();
  const skillFetcher = createGitFetcher(
    keychain
      ? {
          allowLocalRepos: !config.production,
          resolveAuth: (pack) =>
            resolvePackAuth(
              {
                serviceCredential: async (slug) => {
                  const record = await serviceCreds.getServiceCredentialSecret(tenantRootScope(), slug);
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
    void withoutTenant(() => leaderLease.hold(REAPER_LEASE_KEY, () => reaper.sweep()))
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
    emailAuthMembers: async () => (await tenantSettings.get()).emailAuthPrincipals,
    projects,
    environments,
    deploy: deployService,
    deployAppsDomain: config.awsDeploy.appsDomain,
    ...(renderArtifacts ? { deploymentGitPrincipals: renderArtifacts } : {}),
    deploymentLayer,
    ...(processes ? { processes } : {}),
    monitors,
    sandbox,
    files,
    approvals,
    sessionStateBus,
    ledgerEventBus,
    contextRequests: databaseUrl ? createPostgresContextRequestStore(databaseUrl) : createContextRequestStore(),
    engaged,
    reaperPoke: pokeReaper,
    surfaceCache,
    channelPolicy,
    ...(harness.models.judge
      ? { ambientJudge: (s: string, pr: string, signal?: AbortSignal) => harness.models.judge!(s, pr, signal) }
      : {}),
    ...(screenSecurity ? { screenSecurity } : {}),
    ambientCursors: databaseUrl ? createPostgresAmbientCursorStore(databaseUrl) : createAmbientCursorStore(),
    ambientJudgments,
    ackEmojiPicks,
    judgeModelId,
    harnessId: config.harness,
    runtimeFallback: fallback,
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
    ...(slackTables ? { taskAcknowledgements: slackTables.taskAcknowledgements } : {}),
    ...(slackTables ? { sessionStatus: slackTables.sessionStatus } : {}),
    statusActivity: { processes, monitors, sessions, publicWebUrl: config.publicWebUrl },
    featureFlags,
    inboxEvent: (event) => inboxRealtime.onConversationEvent(event),
    app,
    leaderLease,
    ...(slackTables ? { stagedEnvelopes: slackTables.stagedEnvelopes } : {}),
    config: configStore,
    runtimeFallback: fallback,
    blobTransfer,
    deliveries,
    errors,
    runs,
    turnStream,
    ackPicks: ackEmojiPicks,
    ackModelId: () => auxiliaryModelForProvider("anthropic"),
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
      .withLock(tenantKey("session-tree-admission"), async () => {
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
      for (const run of batch)
        await inTenantOf(run.tenantId, () => returnSessionRun(run)).catch(
          swallowAs("sessions: recover return", undefined),
        );
      afterId = batch.at(-1)!.id;
    }
  };
  const approvalDeliverySweeper = createSweeper(
    () => tenants(() => advisoryLock.withLock("approval-deliveries", () => approvals.deliverPending())),
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
      for (const { runId, tenantId } of await runSignals.pendingRuns()) {
        await inTenantOf(tenantId, async () => {
          const run = await runs.get(runId);
          if (!run || isTerminal(run.status))
            await app.replayOrphanedRunSignals(runId).catch(swallowAs("sessions: recover signal", undefined));
        });
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
    sources: loopTables.sources,
    deliveries: loopTables.deliveries,
    loops: loopStore,
    items: loopItems,
    outputs: loopOutputs,
    fire: loopFire,
    lock: advisoryLock,
    ...(config.gmailPubSub && keychain
      ? { gmailConfig: config.gmailPubSub, gmailClient: createGmailPushClient(keychain, config.gmailPubSub) }
      : {}),
    rowTenants,
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
  const ingressMaintenance = new Map<string, Promise<void>>();
  const suggestedActivityProfiles = config.databaseUrl
    ? createPostgresSuggestedActivityProfiles(config.databaseUrl)
    : createMemorySuggestedActivityProfiles();
  const memoryTidy = createMemoryTidyService({
    store: config.databaseUrl ? createPostgresMemoryTidyProfiles(config.databaseUrl) : createMemoryTidyProfiles(),
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
    tenants,
    sweepAsks: async (now) => {
      const tenant = currentTenant();
      if (!ingressMaintenance.has(tenant))
        ingressMaintenance.set(
          tenant,
          admittedWork
            .run(() => loopIngress.maintain())
            .catch(swallowAs("Loop ingress maintenance", undefined))
            .finally(() => ingressMaintenance.delete(tenant)),
        );
      await Promise.all([sweepAsks?.(now), loopFire.sweepStale(now)]);
    },
  });
  const suggestedActivities = createSuggestedActivityService({
    store: suggestedActivityProfiles,
    sessions,
    crons,
    scheduler,
    enabled: config.suggestedActivitiesEnabled === true,
    context: async () => (await tenantSettings.get()).suggestedActivitiesContext,
  });
  cronChanged.notify = (id) => scheduler.notifyChanged(id);
  orchestratorDeps.control = createControlService(app, scheduler, admin);
  orchestratorDeps.validateScheduledRuntime = (scope, choice, purpose) =>
    availableRuntimeError(
      {
        deps: {
          config: configStore,
          harnessId: fallbackHarness,
          baseModelDefault: () => fallback.modelId,
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
      baseModelDefault: () => fallback.modelId,
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
          leaderLease: tenantLease,
          onProcessExit: finishCredentials,
          heartbeatMs: config.monitorHeartbeatMs,
        })
      : null;
  const skillSyncEngine = createSkillSyncEngine({
    packs: skillPacks,
    fetcher: skillFetcher,
    reconcile: (id) => app.syncSkillPack(id),
    leaderLease: tenantLease,
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
        store: createBackgroundOwnershipStore(createBackgroundOwnershipRows(config.databaseUrl)),
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
        leaderLease: tenantLease,
      })
    : null;
  const MONITOR_RETENTION_SWEEP_MS = 24 * 60 * 60_000;
  const LLM_CAPTURE_SWEEP_MS = 5 * 60_000;
  const LLM_CAPTURE_SWEEP_BUDGET_MS = 30_000;
  const spendSweeper = sessions.refreshSpendRollup
    ? createSweeper(() => tenantLease.hold("spend:refresh", () => sessions.refreshSpendRollup!()), 60_000, {
        label: "spend-refresh",
        immediate: true,
      })
    : null;
  const llmCaptureSweeper = sessions.purgeLlmCaptures
    ? createSweeper(
        () =>
          tenantLease.hold("llm-capture:retention", async (lost) => {
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
    () => tenantLease.hold("monitor:retention:sweep", () => monitors.deleteDefunct(Date.now())),
    MONITOR_RETENTION_SWEEP_MS,
    { label: "monitor-retention", immediate: true },
  );
  const deployIdleTtlMs = deployProvider.profile.managedScaleToZero ? undefined : config.deployIdleTtlMs;
  const BLOB_TTL_MS = 6 * 60 * 60_000;
  const composioReturns = linkTables.composioReturns;
  const composioReturnSweeper = createSweeper(
    () => tenants(() => composioReturns.deleteExpired(Date.now())),
    30 * 60_000,
    {
      label: "Composio consent returns",
      immediate: true,
    },
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
      ? createSweeper(
          () => tenants(() => app.reapIdleDeployments(deployIdleTtlMs)),
          Math.max(5_000, Math.floor(deployIdleTtlMs / 4)),
        )
      : null;
  const DEPLOY_MAINTENANCE_INTERVAL_MS = 5 * 60_000;
  const deployMaintenanceSweeper = createSweeper(
    () => tenants(() => app.maintainDeployments()),
    DEPLOY_MAINTENANCE_INTERVAL_MS,
  );
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
      tenantSettings.start();
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
      await tenantSettings.stop();
      await errors.flush();
    },
  };

  return {
    app,
    tenantSettings,
    baseModelDefault: () => fallback.modelId,
    checkReadiness: async (signal) => {
      await pgArtifactMap?.pool.q("SELECT 1", [], { signal });
    },
    ...(screenSecurity ? { screenSecurity } : {}),
    deploymentLayer,
    deploymentLayerStore,
    brokeredTools,
    deploymentLayerReady,
    eachTenant: tenants,
    boot: () =>
      tenants(async () => {
        await configStore.hydrate?.();
        await identity.hydrate();
        await refreshCustomProviders();
        await mcpToolService.refresh();
        await skillsReady();
      }),
    skillsReady,
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
    slackTables,
    slackInstallation,
    composioNamespace: composioNamespaceReader(pgArtifactMap?.pool ?? null),
    resolveClient,
    consentLinks,
    oauthFlows,
    secretDrops,
    rowTenants,
    modelGatewayTransport: () => tenantModels.gateway(),
    budget,
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
    slackAccounts: (slackTables ?? memorySlackRows()).accounts,
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
    sessionShares: databaseUrl ? createPostgresSessionShareStore(databaseUrl) : createSessionShareStore(),
    sessionShareBytes: durableBytes("session-shares"),
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
  return {
    externalSlackPolicies: config.externalSlackPolicies,
    composioNamespace: built.composioNamespace,
    modelGatewayTransport: built.modelGatewayTransport,
    resolveBrowserCompanyKeys: built.resolveBrowserCompanyKeys,
    production: config.production,
    checkReadiness: built.checkReadiness,
    tenantSettings: built.tenantSettings,
    ...(built.backgroundOwnership
      ? {
          backgroundOwnership: built.backgroundOwnership,
          deploymentLiveSmoke: () => runSessionSmoke(config, `http://127.0.0.1:${config.port}`, built.tenantSettings),
        }
      : {}),
    ...(config.deploymentControlSecret ? { deploymentControlSecret: config.deploymentControlSecret } : {}),
    ...(config.spendExportToken ? { spendExportToken: config.spendExportToken } : {}),
    ...(config.databaseUrl ? { installTenant: () => ensureInstallTenant(config.databaseUrl!) } : {}),
    ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
    ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
    capabilityTokenCompression: config.capabilityTokenCompression,
    ...(config.portalIdentitySecret ? { portalIdentitySecret: config.portalIdentitySecret } : {}),
    ...(built.replayDedupe ? { replayDedupe: built.replayDedupe } : {}),
    ...(built.brokerSessions ? { brokerSessions: built.brokerSessions } : {}),
    config: built.config,
    ...(built.screenSecurity ? { screenSecurity: built.screenSecurity } : {}),
    baseModelDefault: built.baseModelDefault,
    modelCredentials: built.modelCredentials,
    userModelCredentials: built.userModelCredentials,
    modelRegistry: built.modelRegistry,
    modelVerifier: built.modelVerifier,
    refreshModels: built.refreshModels,
    customProviders: built.customProviders,
    refreshCustomProviders: built.refreshCustomProviders,
    mcpServers: built.mcpServers,
    mcpToolService: built.mcpToolService,
    harnessCarriedModelAuth: async () => harnessCarriedModelAuthFor(await built.tenantSettings.get(), config.harness),
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
    rowTenants: built.rowTenants,
    ...(built.fireDropResolution ? { fireDropResolution: built.fireDropResolution } : {}),
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
    ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
    ...(config.publicWebUrl ? { portalUrl: config.publicWebUrl } : {}),
    admin: built.admin,
    ...(config.slack ? { slackAllowFrom: config.slack.allowFrom ?? [] } : {}),
    ...(config.resendApiKey && config.emailFrom
      ? { inviteMailer: resendMailer(config.resendApiKey, config.emailFrom) }
      : {}),
    rateLimiter: built.rateLimiter,
    budget: built.budget,
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
