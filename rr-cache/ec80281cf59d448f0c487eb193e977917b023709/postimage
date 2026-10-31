import { type MemoryEmbedder, createMemoryEmbedder } from "./model/embeddings.ts";
import {
  resolveEmbeddingModel,
  auxiliaryModelFor,
  codexSubscriptionModelId,
  isOverlayModel,
  modelRequestOverrides,
  resolveModel,
} from "./model/pi-models.ts";
import { createPostgresTeamStore } from "./teams/teams.ts";
import { createPostgresDecisionStore } from "./decisions/store.ts";
import { createSlackTables } from "./slack/slack-tables.ts";
import { requestedRuntimeError, type RuntimeDeps } from "./api/runtime-config.ts";
import { createPostgresApprovalStore } from "./slack/approval-store.ts";
import { createPostgresContextRequestStore } from "./api/context-request-store.ts";
import { createPostgresAmbientCursorStore } from "./api/ambient-cursor-store.ts";
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
import { flushErrorReporting } from "../plugins/chassis/src/error-reporting.ts";
import { createProductAnalytics } from "./util/product-analytics.ts";
import { createAdmittedWork } from "./util/admitted-work.ts";
import {
  createBackgroundOwnershipStore,
  type BackgroundOwnershipControl,
  createBackgroundOwnershipRows,
} from "./runs/background-ownership.ts";
import { loadConnectorSdk } from "./sandbox/connector-sdk.ts";
import { createFlyTunnelManager, parseFlyWireguardPeers } from "./deploy/fly-tunnel-manager.ts";
import { FLY_PEER_CLAIMS } from "./deploy/fly-peer-claims.ts";
import { createRunStreamBus, emitRunReasoning, emitRunText, serveRunStreamSync } from "./runs/run-stream-events.ts";
import { perTenant, currentTenant, tenantKey, tenantRootScope, onFirstBind, withTenant } from "./tenants/context.ts";
import { tenantScopedBus } from "./tenants/bus.ts";
import { createPostgresNotifyBus } from "./persistence/postgres-notify-bus.ts";
import { createPostgresResourceSearch } from "./search/resource-search.ts";
import { createPostgresSessionMailbox } from "./sessions/session-mailbox.ts";
import { createLoopIngress } from "./loops/ingress.ts";
import { createLoopTables } from "./loops/tables.ts";
import { createGmailPushClient } from "./loops/gmail-push.ts";
import { createSuggestedActivityService } from "./suggestions/activities.ts";
import { createMemoryTidyService, withMemoryTidy } from "./memory/tidy.ts";
import { createPostgresSuggestedActivityProfiles } from "./suggestions/activity-profiles.ts";
import { createPostgresMemoryTidyProfiles } from "./memory/tidy-profiles.ts";
import {
  createSessionSyscalls,
  sessionTreeRoot,
  sessionTreeRunCount,
  stoppableAncestors,
  SUBAGENT_TREE_RUN_CAP,
} from "./sessions/session-syscalls.ts";
import { createSemanticMemory } from "./memory/semantic-memory.ts";
import { createPostgresBrokerSessions } from "./auth/broker-sessions.ts";
import { createDirectFileUploads } from "./files/direct-file-upload.ts";
import { createPostgresFileUploadStore } from "./files/file-upload-store.ts";
import { createSandboxResources } from "./sandbox/sandbox-resources.ts";
import { createModelVerifier } from "./model/model-verification.ts";
import type { probeModel, ProviderKeys } from "./model/model-runtime.ts";
import { createAwsRoleBroker, type AwsRoleBroker } from "./auth/aws-role-broker.ts";
import { createPostgresSessionShareStore } from "./sessions/session-share.ts";
import { createModelOverlayStore } from "./model/model-overlay-store.ts";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { Config } from "./config.ts";
import { createTenantModels } from "./model/tenant-models.ts";
import {
  actorAssertionActive,
  createIdentityService,
  createPostgresDeactivationStore,
} from "./identity/identity-service.ts";
import { createPostgresPrincipalLinkStore, createPrincipalLinkService } from "./identity/principal-links.ts";
import { installPrincipalLinks } from "./directory/person.ts";
import { createPostgresExternalMemberStore } from "./identity/external-members.ts";
import { createConfigStore } from "./resolution/config-store.ts";
import { createPostgresConfigTables } from "./resolution/config-tables-pg.ts";
import { createResolutionService } from "./resolution/resolution-service.ts";
import { createAclStore } from "./acl/acl-store.ts";
import { createPostgresGrantStore } from "./acl/postgres-grant-store.ts";
import { createSkillStores } from "./skills/postgres-skill-store.ts";
import { createGitFetcher, resolvePackAuth } from "./skills/pack-fetcher.ts";
import { installSeedSkills, lazySkillBoot } from "./skills/seed.ts";
import { eachTenant } from "./tenants/claim.ts";
import { pgTenants } from "./tenants/resolver.ts";
import { createPostgresMapFactory } from "./persistence/durable-map.ts";
import { createPostgresModelTables } from "./model/model-tables.ts";
import { createPostgresLinkTables } from "./connectors/link-tables.ts";
import { createPostgresKeychainRows } from "./credentials/keychain-pg.ts";
import { createPostgresUiStateStore } from "./surfaces/ui-state.ts";
import { configurePgCaTrust, configurePgPooling, createPgPool } from "./persistence/pg-pool.ts";
import { ownerRowTenants } from "./tenants/row-tenant.ts";
import { createPostgresLeaderLease, type LeaderLease } from "./persistence/leader-lease.ts";
import { createPostgresAdvisoryLock, type AdvisoryLock } from "./persistence/advisory-lock.ts";
import { type ScopeId, type Session, type TurnRequest, type TurnResult, personalScope, scopeId } from "./types.ts";
import { createPostgresAuditLog } from "./admin/postgres-audit-log.ts";
import { createPostgresAppPageViewLog } from "./deploy/page-views.ts";
import { createPostgresRateLimiter } from "./ratelimit/postgres-rate-limiter.ts";
import { estimateCostUsd } from "./ratelimit/budget.ts";
import {
  type SecurityScreenProbe,
  createSecurityScreenProxy,
  type SecurityScreener,
} from "./security/security-screener.ts";
import { createPostgresBudgetTracker } from "./ratelimit/postgres-budget.ts";
import { createCronStore, type CronStore } from "./cron/cron-store.ts";
import { createPostgresCronRows } from "./cron/cron-table.ts";
import { createPostgresCronFireStore } from "./cron/fire-store.ts";
import { createLoopStore } from "./loops/loop-store.ts";
import { createLoopItemLedger } from "./loops/item-ledger.ts";
import { createPostgresLedgerEventBus, type LedgerEventBus } from "./loops/ledger-events.ts";
import { createLoopOutputStore } from "./loops/output-store.ts";
import { createShipGrantStore } from "./loops/ship-grant-store.ts";
import { createLoopFireService, type LoopFireService } from "./loops/loop-fire.ts";
import type { LoopServiceDeps } from "./loops/service-deps.ts";
import { createPostgresDeliveryStore } from "./delivery/postgres-delivery-store.ts";
import { withWebTranscriptDeliveries } from "./delivery/web-transcript-delivery.ts";
import { createPostgresDirectoryStore } from "./directory/postgres-directory-store.ts";
import { createPostgresEnvironmentStore } from "./environments/environment-store.ts";
import { createPostgresIdempotencyStore } from "./idempotency/idempotency-store.ts";
import { createPgBossCronQueue } from "./cron/job-queue.ts";
import { createWebhookStore } from "./webhooks/webhook-store.ts";
import { createPostgresWebhookRows } from "./webhooks/webhook-table.ts";
import { createWebhookReceiver } from "./webhooks/webhook-receiver.ts";
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
import { createLocalWorkspaceStore } from "./workspace/workspace-store.ts";
import type { MemoryService } from "./memory/memory-service.ts";
import { createConfiguredMemoryService } from "./memory/provider-factory.ts";
import { createPostgresMemoryService } from "./memory/postgres-memory-service.ts";
import { createMcpServerStore } from "./mcp/mcp-server-store.ts";
import { createMcpToolService } from "./mcp/mcp-tool-service.ts";
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
import type { FileArtifactStore } from "./files/file-artifact-store.ts";
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
import { type Sandbox, supportsProcessSessions } from "./sandbox/sandbox.ts";
import { createTenantSettingsStore, type TenantSettingsStore } from "./tenants/settings.ts";
import { tenantSandboxClients, tenantSandboxRouting } from "./sandbox/tenant-credentials.ts";
import { createSandboxResourceStores } from "./sandbox/sandbox-resource-store.ts";
import {
  createKeychain,
  type OAuthToken,
  type Keychain,
  type KeychainAsk,
  type KeychainGrant,
} from "./credentials/keychain.ts";
import {
  fireAskResolution,
  fireDropResolution,
  createAskExpirySweep,
  type DropResolution,
} from "./triggers/keychain-ask.ts";
import { createSecretDropStore, type SecretDropStore } from "./credentials/secret-drop.ts";
import { externalAppSharingAllowed, createPostgresFeatureFlagStore } from "./feature-flags.ts";
import { makeRefresh, withPublicOAuthClients, type OAuthClientResolver } from "./connectors/oauth.ts";
import {
  createConnectorClientResolver,
  deriveConnectorKey,
  type SecretKey,
} from "./connectors/connector-client-store.ts";
import { createBrowserSessionStore, type BrowserSessionStore } from "./connectors/browser-session-store.ts";
import { createPostgresCredentialUsageSink } from "./admin/postgres-credential-usage-sink.ts";
import { createPostgresEgressAuditSink } from "./admin/postgres-egress-audit-sink.ts";
import { createConsentLinkStore, type ConsentLinkStore } from "./connectors/consent-link.ts";
import { createOAuthFlowStore, type OAuthFlowStore } from "./connectors/oauth-flow-store.ts";
import {
  createCustomProviderStore,
  createModelCredentialStore,
  type ModelCredentialStore,
} from "./model/model-credential-store.ts";
import { refreshChatGPTTokens, refreshClaudeTokens } from "./model/subscription-oauth.ts";
import { createUserModelCredentialStore } from "./model/user-model-credential-store.ts";
import { setProviderBaseUrls } from "./model/provider-endpoints.ts";
import { setCustomProviders } from "./model/custom-providers.ts";
import { createPostgresSessionStore } from "./sessions/postgres-session-store.ts";
import { createPostgresToolOutputStore, TOOL_OUTPUT_AREA } from "./sessions/tool-output.ts";
import type { SessionStore } from "./sessions/session-store.ts";
import { resolveRuntimeChoice } from "./agent/runtime-choice.ts";
import { selectableModelCatalog } from "./model/model-catalog.ts";
import { createMemoryStrategy } from "./memory/strategy.ts";
import { egressClaimAllowingControlPlane } from "./core/turn-helpers.ts";
import {
  mintCapabilityToken,
  CAPABILITY_TTL_MS,
  CREDENTIAL_BROKER_AUD,
  DEPLOYMENT_CREDENTIAL_TTL_MS,
  EGRESS_PROXY_AUD,
} from "./auth/capability-token.ts";
import { createPostgresRunStore } from "./runs/postgres-run-store.ts";
import type { RunSignalStore } from "./runs/run-signal-store.ts";
import { createPostgresRunSignalStore } from "./runs/postgres-run-signal-store.ts";
import type { RunStore } from "./runs/run-store.ts";
import { createSweeper as createUntrackedSweeper } from "./util/sweeper.ts";
import { createPostgresProcessRegistry, type ProcessRegistry } from "./processes/process-registry.ts";
import { createMonitorStore } from "./monitors/monitor-store.ts";
import { createPostgresMonitorRows } from "./monitors/monitor-table.ts";
import { createTurnStream } from "./runs/turn-stream.ts";
import type { SessionStateBus } from "./runs/session-state-bus.ts";
import { createPostgresSessionStateBus } from "./runs/postgres-session-state-bus.ts";
import type { RunActivityStore } from "./runs/run-activity-store.ts";
import { createPostgresRunActivityStore } from "./runs/postgres-run-activity-store.ts";
import { createApp } from "./api/app.ts";
import { startSession } from "./api/start-session.ts";
import { createSwarmStore } from "./swarms/swarm-store.ts";
import { createPostgresSwarmRows } from "./swarms/swarm-table.ts";
import { createSwarmService } from "./swarms/swarm-service.ts";
import { createSurfaceContextPuller } from "./api/surface-context-puller.ts";
import { createPostgresSurfaceCache, type SurfaceCache } from "./surface-cache/surface-cache.ts";
import { createPostgresChannelPolicyStore, type ChannelPolicyStore } from "./surface-cache/channel-policy-store.ts";
import {
  createPostgresAmbientJudgmentStore,
  type AmbientJudgmentStore,
} from "./surface-cache/ambient-judgment-store.ts";
import { createPostgresAckEmojiPickStore, type AckEmojiPickStore } from "./surface-cache/ack-emoji-pick-store.ts";
import { createAdminService, parseAdminGrants } from "./admin/admin-service.ts";
import { composioNamespaceReader, tenantNameReader } from "./tenants/tenant-record.ts";
import { createAdminGrantStore } from "./admin/admin-grant-store.ts";
import { createPostgresAdminGrantStore } from "./admin/postgres-admin-grant-store.ts";
import { createPostgresProjectStore } from "./projects/project-store.ts";
import { withErrorReporting } from "./admin/error-log.ts";
import { createPostgresReplayDedupe } from "./auth/replay-dedupe.ts";
import { emptyDeploymentLayer, loadDeploymentLayer, type BrokeredLayerTool } from "./deployment/load-layer.ts";
import {
  createDeploymentLayerStore,
  createPostgresDeploymentLayerRows,
  LAYER_CREATED_BY,
  LAYER_REVIEWER,
} from "./deployment/deployment-layer-store.ts";
import { pgRows } from "./persistence/keyed-rows.ts";
import { createPostgresErrorLog } from "./admin/postgres-error-log.ts";
import { errMessage, reportFailureAs } from "./util/errors.ts";
import { sleep } from "./util/async.ts";
import { createSlackInstallationStore } from "./surfaces/slack-installation.ts";
import type { AppDeps } from "./api/app-types.ts";
import { createModelUtilities } from "./model/model-utilities.ts";
import type { ModelUtilities } from "./agent/agent.ts";
import { createCronRunRequests } from "./cron/fires.ts";
import { createHarnessNudges } from "./runs/harness-nudges.ts";
import { createSteerScreen } from "./security/steer-screen.ts";
import { createSessionTitles, createTitleRegenerator } from "./core/session-title.ts";

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

const MEMORY_CAPTURE_ENTRY_WINDOW = 2_000;

export interface CoreOverrides {
  securityScreener?: SecurityScreener;
  credentialBrokers?: Record<string, AwsRoleBroker>;
  modelCredentialFetch?: typeof fetch;
  modelVerificationProbe?: typeof probeModel;
  agent?: Partial<ModelUtilities>;
  tenantSettings?: TenantSettingsStore;
}

export function buildCore(config: Config, overrides: CoreOverrides = {}) {
  let backgroundAdmission = () => !config.backgroundDeploymentId;
  let backgroundActive = () => false;
  const admittedWork = createAdmittedWork({
    canStart: () => !config.backgroundDeploymentId || backgroundAdmission(),
  });
  let inlineShutdown = new AbortController();
  const createSweeper: typeof createUntrackedSweeper = (work, interval, options) =>
    createUntrackedSweeper(() => admittedWork.run(work), interval, options);
  const databaseUrl = config.databaseUrl;
  if (!databaseUrl) throw new Error("DATABASE_URL is required: QM keeps all state in Postgres");
  const rowTenants = ownerRowTenants(createPgPool(databaseUrl));
  const connectorSecretKey = config.connectorSecretKey;
  if (!connectorSecretKey) throw new Error("CONNECTOR_SECRET_KEY is required");
  if (config.databaseUrl && !config.databaseOwnerUrl)
    throw new Error("DATABASE_OWNER_URL is required with DATABASE_URL");
  configurePgPooling({
    databaseUrl,
    ...(config.databaseOwnerUrl ? { ownerUrl: config.databaseOwnerUrl } : {}),
    ...(config.databaseReaderUrl ? { readerUrl: config.databaseReaderUrl } : {}),
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
  const acl = createAclStore(createPostgresGrantStore(databaseUrl), {
    manages: (principalId, scopeId, authoredBy) =>
      membership.managesArtifactHome!(scopeId, authoredBy ?? "", principalId),
    resolveFiles: (refs) => files.resolveByIds(refs),
  });
  const pgArtifactMap = createPostgresMapFactory(databaseUrl);
  const modelTables = createPostgresModelTables(databaseUrl);
  const linkTables = createPostgresLinkTables(databaseUrl);
  const tenantSettings =
    overrides.tenantSettings ??
    createTenantSettingsStore({
      db: pgArtifactMap.pool,
      keyMaterial: connectorSecretKey,
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
        ...(settings.claudeAuthCredential ? { anthropic: true } : {}),
        modelIds: new Set(Object.keys(gateway?.models ?? {})),
      };
    },
  };
  const advisoryLock: AdvisoryLock = createPostgresAdvisoryLock(pgArtifactMap.pool);
  const principalLinks = createPrincipalLinkService(createPostgresPrincipalLinkStore(databaseUrl), advisoryLock);
  installPrincipalLinks(principalLinks);
  const identity = createIdentityService(createPostgresDeactivationStore(databaseUrl), {
    directorySyncProtected: async () => (await tenantSettings.get()).emailAuthPrincipals,
    externalMembers: createPostgresExternalMemberStore(databaseUrl),
    principalLinks,
  });
  const leaderLease: LeaderLease = createPostgresLeaderLease(pgArtifactMap.pool);
  const tenants = eachTenant(pgTenants(pgArtifactMap.pool));
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
  const configStore = createConfigStore({
    tables: createPostgresConfigTables(databaseUrl),
    connectorSecretKey,
  });
  const { skills, skillPacks, skillBundles } = createSkillStores(databaseUrl, {
    advisoryLock,
    ...(config.skillSigningSecret ? { signingSecret: config.skillSigningSecret } : {}),
  });
  const featureFlags = createPostgresFeatureFlagStore(databaseUrl);
  const teams = createPostgresTeamStore(databaseUrl, featureFlags);
  const decisions = createPostgresDecisionStore(databaseUrl);
  const slackTables = createSlackTables(databaseUrl);
  const slackInstallation = createSlackInstallationStore(slackTables.installation, connectorSecretKey);
  const deploymentLayer = config.deploymentLayerDir
    ? loadDeploymentLayer(config.deploymentLayerDir)
    : emptyDeploymentLayer();
  const layerSkillsDir = config.deploymentLayerDir ? resolve(deploymentLayer.dir, "skills") : undefined;
  const brokeredTools = deploymentLayer.brokeredTools;
  const auditLog = createPostgresAuditLog(databaseUrl);
  const deploymentLayerStore = createDeploymentLayerStore({
    backing: createPostgresDeploymentLayerRows(databaseUrl),
    runtime: deploymentLayer,
    skills,
    skillBundles,
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
  const rateLimiter = createPostgresRateLimiter(databaseUrl, rateLimitOpts);
  const budgetOpts = {
    ...(config.budgetUsdPerWindow !== undefined ? { limitUsd: config.budgetUsdPerWindow } : {}),
    ...(config.orgBudgetUsdPerWindow !== undefined ? { orgLimitUsd: config.orgBudgetUsdPerWindow } : {}),
    windowMs: config.budgetWindowMs,
  };
  const budget =
    config.budgetUsdPerWindow !== undefined || config.orgBudgetUsdPerWindow !== undefined
      ? createPostgresBudgetTracker(databaseUrl, budgetOpts)
      : undefined;
  const resolution = createResolutionService(configStore, acl, async () => {
    const mode = (await tenantSettings.get()).securityScreen;
    return mode === "off" && overrides.securityScreener ? "enforce" : mode;
  });

  const s3 = config.s3Endpoint ? s3Client(config.s3Region, { endpoint: config.s3Endpoint }) : undefined;
  const s3Override = s3 ? { _client: s3 } : {};
  const workspace =
    config.workspaceStore === "postgres"
      ? createRenderWorkspaceStore(config.dataDir, databaseUrl)
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
  const files: FileArtifactStore = createPostgresFileArtifactStore(databaseUrl, fileBytes);
  const fileUploads =
    config.snapshotStore === "s3" && config.s3Bucket
      ? createDirectFileUploads({
          ...(s3 ? { client: s3, presign: (command, expiresIn) => getSignedUrl(s3, command, { expiresIn }) } : {}),
          bucket: config.s3Bucket,
          ...(config.s3Region ? { region: config.s3Region } : {}),
          ...(config.s3Prefix ? { prefix: config.s3Prefix } : {}),
          store: createPostgresFileUploadStore(databaseUrl),
          files,
        })
      : undefined;
  const notebookMemory: MemoryService = createPostgresMemoryService(databaseUrl);
  const semanticMemory = createSemanticMemory({
    notebook: notebookMemory,
    databaseUrl,
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
  const errors = withErrorReporting(createPostgresErrorLog(databaseUrl));
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
      initializationStore: pgRows(databaseUrl, SPRITES_INITIALIZATION),
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
  const smolmachinesBodies = pgRows(databaseUrl, SMOLMACHINES_SANDBOX_BODIES);
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
  const e2bBodies = pgRows(databaseUrl, E2B_SANDBOX_BODIES);
  const modalBodies = pgRows(databaseUrl, MODAL_SANDBOX_BODIES);
  const renderBodies = pgRows(databaseUrl, RENDER_SANDBOX_BODIES);
  const renderScratch = pgRows(databaseUrl, RENDER_SCRATCH_BODIES);
  const renderCleanup = pgRows(databaseUrl, RENDER_SANDBOX_CLEANUP);
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
  const managedAgentsBodies = pgRows(databaseUrl, MANAGED_AGENTS_SANDBOX_BODIES);
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
    ...createSandboxResourceStores(databaseUrl),
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
    ...createPostgresKeychainRows(databaseUrl),
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

  const sessions: SessionStore = createPostgresSessionStore(databaseUrl);
  memorySessions.store = sessions;
  const toolOutput = createPostgresToolOutputStore({
    pool: pgArtifactMap.pool,
    bytes: durableBytes(TOOL_OUTPUT_AREA),
  });
  const runSignals: RunSignalStore = createPostgresRunSignalStore(databaseUrl);
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
  const resolveCompanyProviderKeys = async (): Promise<ProviderKeys> => {
    const [metered, subscription] = await Promise.all([resolveModelProviderKeys(), tenantModels.subscriptionKeys()]);
    const { anthropic: claude, ...rest } = subscription;
    return { ...(claude ? { anthropic: claude } : {}), ...metered, ...rest };
  };
  const resolveBrowserCompanyKeys = async (includeSubscription = true): Promise<ProviderKeys> =>
    includeSubscription ? resolveCompanyProviderKeys() : resolveModelProviderKeys();
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
  const deploymentDefaultModel = () => tenantModels.defaultModel();
  const fallback = {
    get modelId() {
      return deploymentDefaultModel();
    },
  };
  const judgeModelId = async (): Promise<string> =>
    (await tenantSettings.get()).piJudgeModel ?? auxiliaryModelFor(orgBaseModelId() ?? fallback.modelId);
  const modelUtilities: Partial<ModelUtilities> = overrides.agent ?? {
    ...createModelUtilities({
      defaultModelId: deploymentDefaultModel,
      detectModelId: () => tenantSettings.peek().piDetectModel,
      titleModelId: () => tenantSettings.peek().piTitleModel,
      judgeModelId: () => tenantSettings.peek().piJudgeModel,
      resolveModelGateway: () => tenantModels.gateway(),
      resolveBaseModelId: () => orgBaseModelId() ?? deploymentDefaultModel(),
      resolveProviderKeys: resolveCompanyProviderKeys,
      companyModelId,
    }),
  };
  const hydrateModelCatalog = async (): Promise<unknown> => {
    await refreshModels();
    if (!(await modelCredentials.availability()).openrouter) return undefined;
    return selectableModelCatalog(overrides.modelCredentialFetch);
  };
  const leaseTtlMs = config.leaseTtlMs;
  const maxAttempts = config.maxAttempts;
  const runStore = createPostgresRunStore(databaseUrl, { maxClaims: config.maxClaims });
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
  const swarms =
    config.swarmsEnabled !== false
      ? createSwarmService({
          defaults: config.swarmDefaults,
          store: createSwarmStore(createPostgresSwarmRows(databaseUrl)),
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
  const productAnalytics = createProductAnalytics(config.productAnalytics);
  runs.onTerminal((run) => void productAnalytics.responseFinished(run));

  let processes: ProcessRegistry | undefined;
  if (supportsProcessSessions(sandbox)) {
    processes = createPostgresProcessRegistry(databaseUrl);
  }

  const appPageViews = config.awsDeploy.appsDomain ? createPostgresAppPageViewLog(databaseUrl) : undefined;
  const brokerSessions = createPostgresBrokerSessions(databaseUrl);
  const replayDedupe = createPostgresReplayDedupe(databaseUrl);
  const credentialUsage = createPostgresCredentialUsageSink(databaseUrl);
  const egressAudit = createPostgresEgressAuditSink(databaseUrl);
  const runStreamEvents = createRunStreamBus(databaseUrl);
  const refreshRunStream = (runId: string): void => runStreamEvents.emit({ runId, kind: "refresh" });
  const streamOrigin = randomUUID();
  const turnStream = createTurnStream({
    onDelta: (runId, text, offset, startOffset) =>
      emitRunText(runStreamEvents, runId, text, offset, startOffset, streamOrigin),
    onReasoning: (runId, block, text, offset) =>
      emitRunReasoning(runStreamEvents, runId, block, text, offset, streamOrigin),
    onState: (runId, change) => runStreamEvents.emit({ runId, kind: "state", origin: streamOrigin, change }),
    onChange: refreshRunStream,
  });
  const stopStreamSync = serveRunStreamSync(runStreamEvents, turnStream, streamOrigin);
  runs.onTerminal((run) => refreshRunStream(run.id));
  const sessionStateBus: SessionStateBus = createPostgresSessionStateBus(databaseUrl);
  const ledgerEventBus: LedgerEventBus = createPostgresLedgerEventBus(databaseUrl);
  const activityStore: RunActivityStore = createPostgresRunActivityStore(databaseUrl);
  const runActivity: RunActivityStore = {
    ...activityStore,
    async append(runId, entry) {
      await activityStore.append(runId, entry);
      refreshRunStream(runId);
    },
  };
  const deployStore = createDeployStore({
    deployments: createPostgresDeploymentRows(databaseUrl),
    touchDebounceMs: deployTouchDebounceMs(config.deployIdleTtlMs),
    git: {
      repoRoot: config.deployGitDir,
      archiveStore: createPostgresDeployGitArchives(databaseUrl),
      ...(s3Bytes ? { archiveBytes: durableBytes("deploy-git") } : {}),
    },
  });
  const renderDeployBodies = pgRows(databaseUrl, RENDER_DEPLOY_BODIES);
  const renderArtifacts =
    config.deployProvider === "render"
      ? createRenderDeployArtifacts({
          baseUrl: config.apiBaseUrl ?? "",
          signingSecret: config.signingSecret ?? "",
          store: pgRows(databaseUrl, RENDER_DEPLOY_CREDENTIALS),
          deployStore,
        })
      : undefined;
  const buildRenderDeploy = (): DeployProvider => {
    const render = config.renderDeploy;
    if (
      !config.databaseUrl ||
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
      store: pgRows(databaseUrl, RENDER_APP_STORAGE),
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
      store: pgRows(databaseUrl, AWS_DEPLOY_BODIES),
      onError: sandboxOnError,
    });
  if (config.deployProvider === "fly" && config.flyDeploy.sharedAppName && !config.flyDeploy.wireguardPeers)
    throw new Error("Fly shared apps require FLY_DEPLOY_WIREGUARD_PEERS for private connectivity");
  const flyTunnel =
    config.deployProvider === "fly" && config.flyDeploy.wireguardPeers
      ? createFlyTunnelManager({
          peers: parseFlyWireguardPeers(config.flyDeploy.wireguardPeers),
          claims: pgRows(databaseUrl, FLY_PEER_CLAIMS),
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
        configStore: pgRows(databaseUrl, FLY_DEPLOY_CONFIGS),
        portStore: createFlyPortClaims(databaseUrl),
        onError: sandboxOnError,
      }),
    porter: () =>
      createPorterDeployProvider({
        ...config.porterDeploy,
        advisoryLock,
        store: pgRows(databaseUrl, PORTER_DEPLOY_BODIES),
        onError: sandboxOnError,
      }),
    e2b: () => {
      const e2b = config.e2bSandbox;
      if (!e2b.deployApiKey) throw new Error("DEPLOY_PROVIDER=e2b requires E2B_API_KEY");
      return createE2bDeployProvider({
        client: e2bClient("apps", e2b.deployApiKey),
        ...(e2b.namePrefix ? { namePrefix: e2b.namePrefix } : {}),
        advisoryLock,
        store: pgRows(databaseUrl, E2B_DEPLOY_BODIES),
        onError: sandboxOnError,
      });
    },
  };
  const deployProvider: DeployProvider = buildDeployProvider[config.deployProvider]();
  if (config.deployProvider === "aws" && !config.awsDeploy.dataBucket) {
    console.warn("[wiring] aws deploy: AWS_DEPLOY_DATA_BUCKET is unset — deployed apps have NO durable /data");
  }
  const adminGrantStore = createAdminGrantStore(createPostgresAdminGrantStore(databaseUrl), {
    seed: async () => parseAdminGrants((await tenantSettings.get()).values.ADMIN_GRANTS, tenantRootScope()) ?? [],
  });
  const admin = createAdminService(adminGrantStore, {
    trustedOidcAdminIssuer: async () => (await tenantSettings.get()).trustedOidcAdminIssuer,
  });
  const { strategy: memoryStrategy, memory } = createMemoryStrategy(config.memoryStrategy, {
    agent: modelUtilities,
    memory: baseMemory,
    captureQuietMs: config.memoryCaptureQuietMs,
    ...(config.memoryCaptureMaxTurns !== undefined ? { captureMaxTurns: config.memoryCaptureMaxTurns } : {}),
    onCaptureError: (e, scope) =>
      errors.record({ category: "memory", code: "capture_failed", message: errMessage(e), scopeLabel: scope }, e),
  });
  const directory = createPostgresDirectoryStore(databaseUrl);
  const projects = createPostgresProjectStore(databaseUrl, {
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
  const deliveries = withWebTranscriptDeliveries(createPostgresDeliveryStore(databaseUrl), sessions);
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
  const environments = createPostgresEnvironmentStore(databaseUrl);
  const monitors = createMonitorStore(createPostgresMonitorRows(databaseUrl));
  const loopTables = createLoopTables(databaseUrl);
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
  const cronChanged = tenantScopedBus(
    createPostgresNotifyBus<{ cronId: string; tenant?: string }>(databaseUrl, "cron_changed", "cron-changed"),
  );
  const cronNotifier = { notifyChanged: (cronId: string) => cronChanged.emit({ cronId }) };
  const cronQueue = createPgBossCronQueue(databaseUrl, undefined, config.cronFireConcurrency);
  const cronFires = createPostgresCronFireStore(databaseUrl);
  const cronsBase = createCronStore(createPostgresCronRows(databaseUrl), {
    staleRunningMs: config.runMaxAgeMs,
    fires: cronFires,
  });
  const crons: CronStore = {
    ...cronsBase,
    async create(input) {
      const cron = await cronsBase.create(input);
      cronNotifier.notifyChanged(cron.id);
      return cron;
    },
    async update(id, patch) {
      const cron = await cronsBase.update(id, patch);
      cronNotifier.notifyChanged(id);
      return cron;
    },
    async setEnabled(id, enabled) {
      await cronsBase.setEnabled(id, enabled);
      cronNotifier.notifyChanged(id);
    },
  };
  pgArtifactMap.pool.registerMigration({
    id: "durable-map/0000-versions",
    statements: ["CREATE TABLE IF NOT EXISTS durable_map_versions (tbl TEXT PRIMARY KEY, v BIGINT NOT NULL)"],
  });
  pgArtifactMap.pool.registerMigration({
    id: "durable-map/turn_wall_clock_configs/0002-drop",
    statements: [
      "DROP TABLE IF EXISTS turn_wall_clock_configs",
      "DELETE FROM durable_map_versions WHERE tbl = 'turn_wall_clock_configs'",
    ],
  });
  pgArtifactMap.pool.registerMigration({
    id: "durable-map/connector_status/0002-drop",
    statements: [
      "DROP TABLE IF EXISTS connector_status",
      "DELETE FROM durable_map_versions WHERE tbl = 'connector_status'",
    ],
  });
  pgArtifactMap.pool.registerMigration({
    id: "durable-map/pinned_skills/0002-drop",
    statements: ["DROP TABLE IF EXISTS pinned_skills", "DELETE FROM durable_map_versions WHERE tbl = 'pinned_skills'"],
  });
  pgArtifactMap.pool.registerMigration({
    id: "durable-map/internal_member_overrides/0002-drop",
    statements: [
      "DROP TABLE IF EXISTS internal_member_overrides",
      "DELETE FROM durable_map_versions WHERE tbl = 'internal_member_overrides'",
    ],
  });
  pgArtifactMap.pool.registerMigration({
    id: "runtime/0002-drop-harness-choice",
    statements: [
      "DROP TABLE IF EXISTS approved_harness_configs",
      "DELETE FROM durable_map_versions WHERE tbl = 'approved_harness_configs'",
      `DO $$ BEGIN IF to_regclass('base_model_configs') IS NOT NULL THEN UPDATE base_model_configs SET json = (CASE WHEN json ? 'harnessId' AND NOT json ? 'orgRevision' THEN json || '{"orgRevision":0}'::jsonb ELSE json END) - 'harnessId' #- '{cronRuntime,harnessId}' #- '{subagentRuntime,harnessId}' #- '{fallbackRuntime,harnessId}' WHERE json ? 'harnessId' OR (json -> 'cronRuntime') ? 'harnessId' OR (json -> 'subagentRuntime') ? 'harnessId' OR (json -> 'fallbackRuntime') ? 'harnessId'; END IF; END $$`,
      `DO $$ BEGIN IF to_regclass('auto_flagger_configs') IS NOT NULL THEN UPDATE auto_flagger_configs SET json = json - 'harnessId' WHERE json ? 'harnessId'; END IF; END $$`,
      `DO $$ BEGIN IF to_regclass('crons') IS NOT NULL THEN UPDATE crons SET json = json #- '{runtime,harnessId}' WHERE (json -> 'runtime') ? 'harnessId'; END IF; END $$`,
      `DO $$ BEGIN IF to_regclass('swarms') IS NOT NULL THEN UPDATE swarms SET json = json #- '{template,harness}' WHERE (json -> 'template') ? 'harness'; END IF; END $$`,
    ],
  });
  const webhooks = createWebhookStore(createPostgresWebhookRows(databaseUrl));
  const approvals = createPostgresApprovalStore(databaseUrl, deliveries);
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
  const runtimeDeps: RuntimeDeps = {
    config: configStore,
    baseModelDefault: () => fallback.modelId,
    modelCredentials,
    modelCredentialFetch: overrides.modelCredentialFetch,
    refreshModels,
  };
  const sessionMailbox = createPostgresSessionMailbox(databaseUrl);
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
      const requested = {
        ...(input.model ? { modelId: input.model } : {}),
        ...(input.thinkingLevel ? { effortLevel: input.thinkingLevel } : {}),
        ...(typeof input.fastMode === "boolean" ? { fastMode: input.fastMode } : {}),
      };
      if (Object.keys(requested).length === 0) {
        await resolveRuntimeChoice(
          configStore,
          tenantRootScope(),
          scope,
          fallback,
          requested,
          hydrateModelCatalog,
          "subagent",
        );
        return;
      }
      const error = await requestedRuntimeError({ deps: runtimeDeps }, scope, requested, "subagent");
      if (error) throw new Error(error);
    },
  });
  const uiState = createPostgresUiStateStore(databaseUrl);
  const idempotency = createPostgresIdempotencyStore(databaseUrl);
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
    const puller = surfaceContext;
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
  const surfaceCache: SurfaceCache = createPostgresSurfaceCache(databaseUrl, { liveFallback });
  const channelPolicy: ChannelPolicyStore = createPostgresChannelPolicyStore(databaseUrl);
  const ambientJudgments: AmbientJudgmentStore = createPostgresAmbientJudgmentStore(databaseUrl);
  const ackEmojiPicks: AckEmojiPickStore = createPostgresAckEmojiPickStore(databaseUrl);
  const screenSecurity: SecurityScreenProbe | undefined = modelUtilities.screenSecurity
    ? ({ payload, modelId, systemPrompt, actorId, signal }) =>
        modelUtilities.screenSecurity!({
          payload,
          modelId,
          systemPrompt,
          signal,
          recordModelCall: (rec) => {
            void budget?.record(actorId, estimateCostUsd(rec.inputTokens));
          },
        })
    : undefined;
  const composioReturns = linkTables.composioReturns;
  const cronRuns = createCronRunRequests({ crons, queue: cronQueue });
  const harnessNudges = createHarnessNudges(databaseUrl);
  const screenSecuritySteer = createSteerScreen({
    securityScreener,
    agent: modelUtilities,
    securityScreenTimeoutMs: config.securityScreenTimeoutMs,
    auditLog,
    config: configStore,
    budget,
    resolution,
    rateLimiter,
    sessions,
  });
  const regenerateTitle = createTitleRegenerator({
    sessions,
    titles: createSessionTitles({ sessions, agent: modelUtilities, sessionStateBus, errors }),
  });
  const appDeps: AppDeps = {
    screenSecuritySteer,
    regenerateTitle,
    teams,
    externalSlackPolicies: config.externalSlackPolicies,
    admittedWork,
    shutdown: () => inlineShutdown.signal,
    resourceSearch: createPostgresResourceSearch(pgArtifactMap.pool),
    swarms,
    identity,
    ...(config.publicWebUrl ? { publicWebUrl: config.publicWebUrl } : {}),
    sessions,
    runs,
    leaseTtlMs,
    maxAttempts,
    turnStream,
    runStreamEvents,
    runActivity,
    signals: runSignals,
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
    contextRequests: createPostgresContextRequestStore(databaseUrl),
    engaged: harnessNudges,
    reaperPoke: () => harnessNudges.pokeReaper(),
    surfaceCache,
    channelPolicy,
    ...(modelUtilities.judge
      ? { ambientJudge: (s: string, pr: string, signal?: AbortSignal) => modelUtilities.judge!(s, pr, signal) }
      : {}),
    ...(screenSecurity ? { screenSecurity } : {}),
    ambientCursors: createPostgresAmbientCursorStore(databaseUrl),
    ambientJudgments,
    ackEmojiPicks,
    judgeModelId,
    runtimeFallback: fallback,
    runWaitMs: config.runWaitMs,
  };
  const app = createApp(appDeps);
  const surfaceContext = createSurfaceContextPuller(
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
  const suggestedActivityProfiles = createPostgresSuggestedActivityProfiles(databaseUrl);
  const memoryTidy = createMemoryTidyService({
    store: createPostgresMemoryTidyProfiles(databaseUrl),
    memory: baseMemory,
    timezone: async (principalId) => (await suggestedActivityProfiles.get(principalId))?.timezone,
    crons,
    scheduler: cronNotifier,
  });
  const suggestedActivities = createSuggestedActivityService({
    store: suggestedActivityProfiles,
    sessions,
    crons,
    scheduler: { ...cronNotifier, ...cronRuns },
    enabled: config.suggestedActivitiesEnabled === true,
    context: async () => (await tenantSettings.get()).suggestedActivitiesContext,
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
        store: createBackgroundOwnershipStore(createBackgroundOwnershipRows(databaseUrl)),
        instanceId: randomUUID(),
        deploymentId: config.backgroundDeploymentId,
        active: () => backgroundActive(),
      }
    : undefined;
  let stopIdentityPreload: (() => void) | undefined;
  return {
    askResolution,
    surfaceContext,
    securityScreener,
    admittedWork,
    approvals,
    blockingApprovalSessions,
    companyModelId,
    configStore,
    createSweeper,
    cronChanged,
    currentScopeMembers,
    databaseUrl,
    deploymentDefaultModel,
    deployProvider,
    deployService,
    fallback,
    flyTunnel,
    hydrateModelCatalog,
    idempotency,
    isCurrentSharedScopeMember,
    layerBrokerFor,
    leaderLease,
    leaseTtlMs,
    loopFire,
    loopItems,
    loopStore,
    maxAttempts,
    memoryStrategy,
    memoryTidy,
    orgBaseModelId,
    pgArtifactMap,
    prepareSessionRequest,
    resolution,
    resolveCompanyProviderKeys,
    resolveRecipient,
    runActivity,
    runSignals,
    runStreamEvents,
    runTriggered,
    runtimeDeps,
    semanticMemory,
    sessionMailbox,
    skillPacks,
    stopStreamSync,
    suggestedActivityService: suggestedActivities,
    swarms,
    tenantModels,
    tenantLease,
    tenants,
    sweepAsks,
    toolOutput,
    turnStream,
    webhooks,
    modelUtilities,
    cronRuns,
    cronQueue,
    harnessNudges,
    canClaimBackground: () => backgroundAdmission(),
    setBackgroundAdmission(canClaim: () => boolean, active: () => boolean) {
      backgroundAdmission = canClaim;
      backgroundActive = active;
    },
    releaseWaiters: () => inlineShutdown.abort(),
    setInlineRunner(runInline: NonNullable<AppDeps["runInline"]>) {
      appDeps.runInline = runInline;
    },
    start() {
      if (inlineShutdown.signal.aborted) inlineShutdown = new AbortController();
      flyTunnel?.monitor();
      tenantSettings.start();
      stopIdentityPreload ??= onFirstBind((tenant) => withTenant(tenant, () => identity.ready()));
    },
    async close() {
      stopStreamSync();
      await Promise.all(
        [
          runs.close?.(),
          runSignals.close?.(),
          sessionStateBus.close?.(),
          ledgerEventBus.close?.(),
          runActivity.close?.(),
          runStreamEvents.close?.(),
          cronChanged.close?.(),
          harnessNudges.close(),
          cronQueue.stop(),
        ].map((closing) => closing?.catch(reportFailureAs("shutdown: close event stores", undefined))),
      );
      await semanticMemory.close();
      await flyTunnel?.stop();
      await tenantSettings.stop();
      stopIdentityPreload?.();
      stopIdentityPreload = undefined;
      await errors.flush();
    },
    app,
    tenantSettings,
    baseModelDefault: () => fallback.modelId,
    companySubscriptionAuth: () => tenantModels.subscriptionAuth(),
    checkReadiness: async (signal: AbortSignal) => {
      await pgArtifactMap.pool.q("SELECT 1", [], { signal });
    },
    ...(screenSecurity ? { screenSecurity } : {}),
    deploymentLayer,
    deploymentLayerStore,
    brokeredTools,
    eachTenant: tenants,
    boot: () =>
      tenants(async () => {
        await configStore.hydrate?.();
        await identity.refresh();
        await refreshCustomProviders();
        await mcpToolService.refresh();
        await skillsReady();
      }),
    skillsReady,
    deploymentLayerReady,
    deploymentLayerRefresh,
    sessions,
    runs,
    signals: runSignals,
    sessionStateBus,
    sessionSyscalls,
    ledgerEventBus,
    surfaceCache,
    config: configStore,
    connectorTokens,
    slackTables,
    slackInstallation,
    composioNamespace: composioNamespaceReader(pgArtifactMap?.pool ?? null),
    tenantName: tenantNameReader(pgArtifactMap?.pool ?? null),
    resolveClient,
    consentLinks,
    oauthFlows,
    secretDrops,
    rowTenants,
    modelGatewayTransport: () => tenantModels.gateway(),
    budget,
    resolveBrowserCompanyKeys,
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
    slackAccounts: slackTables.accounts,
    composioReturns,
    workspace,
    memory,
    ...(keychain ? { keychain } : {}),
    serviceCreds,
    deliveries,
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
    replayDedupe,
    ...(brokerSessions ? { brokerSessions } : {}),
    directory,
    projects,
    environments,
    ...(processes ? { processes } : {}),
    ...(appPageViews ? { appPageViews } : {}),
    monitors,
    ...(browserSessionStore ? { browserSessionStore } : {}),
    ...(ambientJudgments ? { ambientJudgments } : {}),
    ...(ackEmojiPicks ? { ackEmojiPicks } : {}),
    channelPolicy,
    ...(config.suggestedActivitiesEnabled && (config.backgroundWorkEnabled || config.backgroundDeploymentId)
      ? { suggestedActivities }
      : {}),
    ...(backgroundOwnership ? { backgroundOwnership } : {}),
    uiState,
    sessionShares: createPostgresSessionShareStore(databaseUrl),
    sessionShareBytes: durableBytes("session-shares"),
  };
}

export type Core = ReturnType<typeof buildCore>;
