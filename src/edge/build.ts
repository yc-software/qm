import { createKeychainApprovals, type KeychainApprovals } from "../credentials/keychain-approval.ts";
import { runSessionSmoke } from "../deployment/postdeploy-smoke.ts";
import type { Config } from "../config.ts";
import type { ServerDeps } from "./http/deps.ts";
import { ensureInstallTenant } from "../tenants/install.ts";
import { resendMailer } from "../../plugins/chassis/src/resend.ts";
import { slackUserClientFactory } from "../loops/sources/slack.ts";
import { createInboxSourceRefresh } from "../loops/inbox-source-refresh.ts";
import { createInboxRealtime } from "../loops/inbox-realtime.ts";
import { createSlackCoreClient } from "../api/slack-core-client.ts";
import { auxiliaryModelForProvider } from "../model/pi-models.ts";
import { swallowAs } from "../util/errors.ts";
import { withTimeout } from "../util/async.ts";
import type { Core } from "../wiring.ts";
export function buildEdge(config: Config, core: Core) {
  const {
    ackEmojiPicks,
    admittedWork,
    app,
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
    memory,
    modelUtilities,
    monitors,
    processes,
    runs,
    sessions,
    slackTables,
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
    taskAcknowledgements: slackTables.taskAcknowledgements,
    sessionStatus: slackTables.sessionStatus,
    statusActivity: { processes, monitors, sessions, publicWebUrl: config.publicWebUrl },
    featureFlags,
    inboxEvent: (event) => inboxRealtime.onConversationEvent(event),
    app,
    leaderLease,
    stagedEnvelopes: slackTables.stagedEnvelopes,
    config: configStore,
    runtimeFallback: fallback,
    blobTransfer,
    deliveries,
    errors,
    runs,
    turnStream,
    ackPicks: ackEmojiPicks,
    ackModelId: () => auxiliaryModelForProvider("anthropic"),
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

export function serverDeps(
  config: Config,
  core: Core,
  edge: { keychainApprovals?: KeychainApprovals },
  slackEnvironmentState: "absent" | "configured" | "partial" = "absent",
  slackEnvBotToken?: string,
): Omit<ServerDeps, "control"> {
  return {
    externalSlackPolicies: config.externalSlackPolicies,
    composioNamespace: core.composioNamespace,
    tenantName: core.tenantName,
    modelGatewayTransport: core.modelGatewayTransport,
    resolveBrowserCompanyKeys: core.resolveBrowserCompanyKeys,
    production: config.production,
    checkReadiness: core.checkReadiness,
    tenantSettings: core.tenantSettings,
    ...(core.backgroundOwnership
      ? {
          backgroundOwnership: core.backgroundOwnership,
          deploymentLiveSmoke: () => runSessionSmoke(config, `http://127.0.0.1:${config.port}`, core.tenantSettings),
        }
      : {}),
    ...(config.deploymentControlSecret ? { deploymentControlSecret: config.deploymentControlSecret } : {}),
    ...(config.spendExportToken ? { spendExportToken: config.spendExportToken } : {}),
    installTenant: (slug) => ensureInstallTenant(config.databaseUrl!, slug),
    ...(config.signingSecret ? { signingSecret: config.signingSecret } : {}),
    ...(config.capabilitySecret ? { capabilitySecret: config.capabilitySecret } : {}),
    capabilityTokenCompression: config.capabilityTokenCompression,
    ...(config.portalIdentitySecret ? { portalIdentitySecret: config.portalIdentitySecret } : {}),
    replayDedupe: core.replayDedupe,
    ...(core.brokerSessions ? { brokerSessions: core.brokerSessions } : {}),
    config: core.config,
    ...(core.screenSecurity ? { screenSecurity: core.screenSecurity } : {}),
    baseModelDefault: core.baseModelDefault,
    modelCredentials: core.modelCredentials,
    userModelCredentials: core.userModelCredentials,
    modelRegistry: core.modelRegistry,
    modelVerifier: core.modelVerifier,
    refreshModels: core.refreshModels,
    customProviders: core.customProviders,
    refreshCustomProviders: core.refreshCustomProviders,
    mcpServers: core.mcpServers,
    mcpToolService: core.mcpToolService,
    companySubscriptionAuth: core.companySubscriptionAuth,
    connectorTokens: core.connectorTokens,
    slackInstallation: core.slackInstallation,
    slackEnvironmentState,
    ...(config.slackEventsPort ? { slackEventsPort: config.slackEventsPort } : {}),
    ...(slackEnvBotToken ? { slackEnvBotToken } : {}),
    resolveClient: core.resolveClient,
    consentLinks: core.consentLinks,
    oauthFlows: core.oauthFlows,
    secretDrops: core.secretDrops,
    rowTenants: core.rowTenants,
    ...(core.fireDropResolution ? { fireDropResolution: core.fireDropResolution } : {}),
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
    ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}),
    ...(config.publicWebUrl ? { portalUrl: config.publicWebUrl } : {}),
    admin: core.admin,
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
