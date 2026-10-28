import type { StoresModule } from "./stores.ts";
import type { OutboundModule } from "./outbound.ts";
import type { DeploymentLayerModule } from "./deployment-layer.ts";
import type { RunsModule } from "./runs.ts";
import type { HarnessModule } from "./harness.ts";
import type { FilesModule } from "./files.ts";
import type { CredentialsModule } from "./credentials.ts";
import type { SandboxModule } from "./sandbox.ts";
import type { MemoryModule } from "./memory.ts";
import type { DeployModule } from "./deploy.ts";
import type { CronsModule } from "./crons.ts";
import { tenantConfig } from "../tenants/tenant-config.ts";
import { tenant } from "../tenant.ts";
import type { Head } from "./late.ts";
import { createApprovalGrants } from "../core/orchestrator/approvals.ts";
import { type SurfaceCache, createPostgresSurfaceCache } from "../surface-cache/surface-cache.ts";
import { type ChannelPolicyStore, createPostgresChannelPolicyStore } from "../surface-cache/channel-policy-store.ts";
import { type OrchestratorDeps, createOrchestrator } from "../core/orchestrator.ts";
import { installSharedCanvas } from "../surfaces/ui-canvas.ts";
import { personalScope } from "../types.ts";
import { EXEC_TIMEOUT_DEFAULT_MS, EXEC_TIMEOUT_MAX_MS } from "../harness/agent-tools.ts";
import { BACKGROUND_JOB_TTL_MS, BACKGROUND_JOB_TTL_MAX_MS } from "../connectors/background-exec-broker.ts";
import { resendMailer } from "../../plugins/chassis/src/resend.ts";
import { createCurrentScopeMembers, rosterAdmits } from "../resolution/scope-membership.ts";
import { type AwsRoleBroker, createAwsRoleBroker } from "../auth/aws-role-broker.ts";
import type { BrokeredLayerTool } from "../deployment/load-layer.ts";
import type { RunStore } from "../runs/run-store.ts";
import { createSessionMailbox } from "../sessions/session-mailbox.ts";
import { createSessionSyscalls } from "../subagents/session-tools.ts";
import { createPostgresSwarmBoard } from "../swarms/swarm-board.ts";
import { createSwarmNoticeSweep } from "../swarms/swarm-notices.ts";
import { startSession } from "../api/start-session.ts";
import { resolveRuntimeChoiceDurable } from "../harness/runtime-choice.ts";
import { createUiStateStore } from "../surfaces/ui-state.ts";
import { adminSessionUrl } from "../util/admin-links.ts";
import { wireRunResultPosts } from "../runs/run-results.ts";
import { createGitFetcher, resolvePackAuth } from "../skills/pack-fetcher.ts";
import { nonDeploymentCredential } from "../credentials/deployment-credentials.ts";
import {
  type AmbientJudgmentStore,
  createPostgresAmbientJudgmentStore,
} from "../surface-cache/ambient-judgment-store.ts";
import { type AckEmojiPickStore, createPostgresAckEmojiPickStore } from "../surface-cache/ack-emoji-pick-store.ts";

type OrchestratorInputs = Pick<Head, "late" | "config" | "overrides"> & {
  stores: StoresModule;
  outbound: OutboundModule;
  deploymentLayer: DeploymentLayerModule;
  runs: RunsModule;
  harness: HarnessModule;
  files: FilesModule;
  credentials: CredentialsModule;
  sandbox: SandboxModule;
  memory: MemoryModule;
  deploy: DeployModule;
  crons: CronsModule;
};

type SessionSyscalls = ReturnType<typeof buildSessionSyscalls>;

export function buildOrchestrator(deps: OrchestratorInputs) {
  const { databaseUrl } = deps.stores;
  const { uiState, sessionSyscalls, layerBrokerFor, sessionMailbox, prepareSessionRequest } =
    buildSessionSyscalls(deps);

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
  const surfaceCache: SurfaceCache = createPostgresSurfaceCache(databaseUrl, { liveFallback });
  const channelPolicy: ChannelPolicyStore = createPostgresChannelPolicyStore(databaseUrl);
  const current = () => tenantConfig(deps.config);
  const orchestratorDeps: OrchestratorDeps = {
    ...orchestratorDepsHead({ ...deps, channelPolicy, surfaceCache, uiState, sessionSyscalls }),
    ...orchestratorDepsTail({ ...deps, layerBrokerFor }),
    get externalSlackPolicies() {
      return current().externalSlackPolicies;
    },
    get brandingDefault() {
      return current().brandingDefault;
    },
    get signingSecret() {
      return current().signingSecret;
    },
    get capabilitySecret() {
      return current().capabilitySecret;
    },
    get apiBaseUrl() {
      return current().apiBaseUrl;
    },
    get publicWebUrl() {
      return current().publicWebUrl;
    },
    get deployAppsDomain() {
      return current().deployAppsDomain;
    },
    get webhookPublicUrl() {
      return current().publicUrl;
    },
  };
  const orchestrator = createOrchestrator(orchestratorDeps);
  const { skillFetcher, ambientJudgments, ackEmojiPicks, providerKeys } = buildAppServices(deps);
  return {
    orchestrator,
    surfaceCache,
    channelPolicy,
    orchestratorDeps,
    uiState,
    sessionMailbox,
    prepareSessionRequest,
    skillFetcher,
    ambientJudgments,
    ackEmojiPicks,
    providerKeys,
  };
}

function orchestratorDepsHead(
  deps: OrchestratorInputs & {
    channelPolicy: ChannelPolicyStore;
    surfaceCache: SurfaceCache;
    uiState: SessionSyscalls["uiState"];
    sessionSyscalls: SessionSyscalls["sessionSyscalls"];
  },
) {
  const { chatSurfaces } = deps.outbound;
  const { uiState, late, config, sessionSyscalls, channelPolicy, surfaceCache } = deps;
  const { auditLog } = deps.deploymentLayer;
  const { sessionStateBus } = deps.runs;
  const { refreshModels, harness, gatewayTransport } = deps.harness;
  const { identity, configStore, sessions, admin } = deps.stores;
  const { resolution, workspace, files, toolOutput, rateLimiter, budget, acl } = deps.files;
  const { userModelCredentials, connectorTokens, modelGateway, mcpToolService } = deps.credentials;
  const { sandbox, sandboxResources } = deps.sandbox;
  const { memory } = deps.memory;
  const { deployService } = deps.deploy;
  const { securityScreener } = deps.crons;
  return {
    channelPolicy,
    surfaceCache,
    surfaceLabel: chatSurfaces.label,
    installSharedCanvas: async (actorId, fileId, where) => {
      const canvas = await installSharedCanvas(uiState, actorId, await late.app.openFileForViewer(fileId, actorId));
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
    sessionSyscalls,
    refreshModels,
    identity,
    resolution,
    config: configStore,
    defaultTurnWallClockMs: config.turnWallClockMs,
    userModelCredentials,
    sessions,
    workspace,
    files,
    toolOutput,
    sandbox,
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
    execTimeoutMs: EXEC_TIMEOUT_DEFAULT_MS,
    execTimeoutCeilingMs: EXEC_TIMEOUT_MAX_MS,
    approvalSummaryTimeoutMs: config.approvalSummaryTimeoutMs,
    turnLeaseWaitMs: config.turnLeaseWaitMs,
    securityScreenTimeoutMs: config.securityScreenTimeoutMs,
    ...(securityScreener ? { securityScreener } : {}),
    backgroundJobTtlMs: BACKGROUND_JOB_TTL_MS,
    backgroundJobTtlMaxMs: BACKGROUND_JOB_TTL_MAX_MS,
    capabilityTokenCompression: config.capabilityTokenCompression,
    ...(gatewayTransport ? { sandboxModels: true } : {}),
    ...(config.resendApiKey && config.emailFrom
      ? { inviteMailer: resendMailer(config.resendApiKey, config.emailFrom) }
      : {}),
  } satisfies Partial<OrchestratorDeps>;
}

function orchestratorDepsTail(deps: OrchestratorInputs & { layerBrokerFor: SessionSyscalls["layerBrokerFor"] }) {
  const { config, layerBrokerFor } = deps;
  const {
    identity,
    skills,
    skillBundles,
    advisoryLock,
    featureFlags,
    teams,
    connectorStatusCache,
    directory,
    isCurrentSharedScopeMember,
    projects,
    environments,
    databaseUrl,
  } = deps.stores;
  const { memoryStrategy } = deps.memory;
  const { skillsReady, resolveClient, keychain, serviceCreds } = deps.credentials;
  const { errors, blobTransfer } = deps.files;
  const { ledger, turnStream, runActivity, runs, credentialUsage, processes } = deps.runs;
  const { runSignals, orgBaseModelId, fallback } = deps.harness;
  const { outbound, recentDmPosts } = deps.outbound;
  const { approvals, monitors, crons, webhooks } = deps.crons;
  const { brokeredTools, deploymentLayer } = deps.deploymentLayer;
  return {
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
    keychain,
    serviceCreds,
    outbound,
    recentDmPosts,
    approvals,
    approvalGrants: createApprovalGrants(databaseUrl),
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
    environments,
    brokeredTools,
    deploymentLayer,
    layerBrokerFor,
  } satisfies Partial<OrchestratorDeps>;
}

export type OrchestratorModule = ReturnType<typeof buildOrchestrator>;

function buildSessionSyscalls(deps: OrchestratorInputs) {
  const { config, overrides, late } = deps;
  const { resolution } = deps.files;
  const { canWriteScope, projects, currentScopeMembers, databaseUrl, sessions, advisoryLock, configStore, every } =
    deps.stores;
  const { runs, maxAttempts } = deps.runs;
  const { runSignals, fallback, hydrateModelCatalog } = deps.harness;

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
  const sessionMailbox = createSessionMailbox(databaseUrl);
  const swarmBoard = createPostgresSwarmBoard(databaseUrl);
  const swarmNotices = createSwarmNoticeSweep({ board: swarmBoard, mailbox: sessionMailbox, sessions, runs });
  every("swarm-notice-sweep", 60_000, () => swarmNotices.sweep());
  const sessionSyscalls = createSessionSyscalls({
    mailbox: sessionMailbox,
    board: swarmBoard,
    sessions,
    runs,
    signals: runSignals,
    maxAttempts,
    advisoryLock,
    prepareRequest: prepareSessionRequest,
    authorize: (session, actorId) => canWriteScope(actorId, session.scopeId),
    conversations: {
      search: ({ query, principals, limit }) => late.app.searchConversations(query, principals, limit),
      list: (actorId) => late.app.listSessions(actorId),
      start: (actorId, input) => startSession(late.app, sessions, actorId, input),
    },
    async validateRuntime(input, scope) {
      await resolveRuntimeChoiceDurable(
        configStore,
        tenant().orgScope,
        scope,
        fallback,
        {
          ...(input.model ? { modelId: input.model } : {}),
          ...(input.thinkingLevel ? { effortLevel: input.thinkingLevel } : {}),
          ...(typeof input.fastMode === "boolean" ? { fastMode: input.fastMode } : {}),
        },
        hydrateModelCatalog,
        "subagent",
      );
    },
  });
  const uiState = createUiStateStore(databaseUrl);
  return { uiState, sessionSyscalls, layerBrokerFor, sessionMailbox, prepareSessionRequest };
}

function buildAppServices(deps: OrchestratorInputs) {
  const { config } = deps;
  const { runs } = deps.runs;
  const { outbound, chatSurfaces } = deps.outbound;
  const { sessions, databaseUrl, every } = deps.stores;
  const { serviceCreds, keychain } = deps.credentials;
  const { directProviderAvailability } = deps.harness;

  const uuidId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const runResultRecovery = wireRunResultPosts(runs, outbound, {
    adminUrlFor: (sessionId: string): string | undefined => {
      const base = tenantConfig(config).publicWebUrl;
      return base && uuidId.test(sessionId) ? adminSessionUrl(base, sessionId) : undefined;
    },
    sessions,
    postsImmediately: chatSurfaces.receives,
  });
  const skillFetcher = createGitFetcher({
    allowLocalRepos: !config.production,
    resolveAuth: (pack) =>
      resolvePackAuth(
        {
          serviceCredential: async (slug) => {
            const record = nonDeploymentCredential(
              await serviceCreds.getServiceCredentialSecret(tenant().orgScope, slug),
            );
            return record && record.delivery !== "env" ? record : undefined;
          },
          connectorToken: async (host, principalId) =>
            (await keychain.connectorAccessToken(host, principalId)) ?? undefined,
        },
        pack,
      ),
  });
  const ambientJudgments: AmbientJudgmentStore = createPostgresAmbientJudgmentStore(databaseUrl);
  const ackEmojiPicks: AckEmojiPickStore = createPostgresAckEmojiPickStore(databaseUrl);
  const providerKeys = directProviderAvailability;
  every("run-result-sweep", 60_000, () => runResultRecovery.sweep());
  return {
    skillFetcher,
    ambientJudgments,
    ackEmojiPicks,
    providerKeys,
    runResultRecovery,
  };
}
