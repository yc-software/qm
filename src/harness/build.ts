import { nonDeploymentCredential } from "../credentials/deployment-credentials.ts";
import type { DecisionBackend } from "../decisions/decisions.ts";
import { createDecisionHooks, routeTurnRuntime, turnStartState } from "../decisions/hooks.ts";
import { createDecisionBackend } from "../decisions/providers.ts";
import { availableRuntimeError } from "../api/runtime-config.ts";
import { tracePhase } from "../../plugins/chassis/src/error-reporting.ts";
import { createRuntimeService } from "../harness/runtime-control.ts";
import { deliverSubagentMail, sessionTreeWorking, stoppableAncestors } from "../sessions/session-syscalls.ts";
import { randomUUID } from "node:crypto";
import { type Config } from "../config.ts";
import { resendMailer } from "../../plugins/chassis/src/resend.ts";
import { installSharedCanvas } from "../surfaces/ui-canvas.ts";
import type { CommandApprovalGrant, Session } from "../types.ts";
import { personalScope, scopeId } from "../types.ts";
import { wireRunResultDeliveries } from "../delivery/run-result-delivery.ts";
import { adminSessionUrl } from "../util/admin-links.ts";
import { uuidSchema } from "../util/ids.ts";
import { createCurrentScopeMembers } from "../resolution/scope-membership.ts";
import { credentialRequestHeaders } from "../credentials/keychain.ts";
import { LLM_CAPTURE_RETENTION_MS } from "../sessions/session-store.ts";
import { createAgent, agentConfigOptions } from "./agent-run.ts";
import { withResolvedRuntime } from "../agent/runtime-choice.ts";
import { resolveRuntimeChoice } from "../agent/runtime-choice.ts";
import type { Agent } from "../agent/agent.ts";
import { createOrchestrator, type OrchestratorDeps } from "../harness/orchestrator.ts";
import { isTerminal, type Run } from "../runs/run-store.ts";
import { createTurnRunner } from "./turn-runner.ts";
import { TURN_READY_CHANNEL, TURN_YIELD_CHANNEL } from "../turns/turn-ledger.ts";
import { sweepTurns } from "../turns/turn-engine.ts";
import { TURN_QUEUES } from "../turns/absurd-schema.ts";
import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";
import {
  createNoopInstanceRegistry,
  createPostgresInstanceRegistry,
  type InstanceRegistry,
} from "./instance-registry.ts";
import { createDrainController, type DrainController } from "./drain.ts";
import { createProcessReaper, createReaperKillHook, type ProcessReaper } from "../processes/process-reaper.ts";
import { createJobComputerSweep } from "../processes/job-computers.ts";
import { createMonitorPoller, type MonitorPoller } from "../monitors/monitor-poller.ts";
import { createSkillSyncEngine } from "../skills/skill-sync-engine.ts";
import { supportsProcessSessions, type SandboxHandle } from "../sandbox/sandbox.ts";
import { finishProcessCredentials } from "../credentials/execute-files.ts";
import { modelSupported } from "../model/pi-models.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { withTimeout } from "../util/async.ts";

import type { Core, Runtime } from "../wiring.ts";
import { createControlService } from "../api/control-service.ts";
export interface HarnessOverrides {
  decisionBackend?: DecisionBackend;
  agent?: Agent;
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
    crons,
    currentScopeMembers,
    databaseUrl,
    decisions,
    deploymentDefaultModel,
    deliveries,
    deployProvider,
    deployService,
    deploymentLayer,
    directProviderAvailability,
    directory,
    environments,
    errors,
    fallback,
    featureFlags,
    fileUploads,
    files,
    gatewayTransport,
    hydrateModelCatalog,
    idempotency,
    identity,
    isCurrentSharedScopeMember,
    jobs,
    keychain,
    layerBrokerFor,
    leaderLease,
    maxAttempts,
    mcpToolService,
    memory,
    memoryStrategy,
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
    resolveCompanyProviderKeys,
    resolveRecipient,
    runActivity,
    runSignals,
    runTriggered,
    runs,
    runtimeDeps,
    runtimeOrgScope,
    scheduler,
    setTurnStarter,
    turnLedger,
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
    surfaceCache,
    surfaceContext,
    swarms,
    teams,
    toolOutput,
    turnStream,
    uiState,
    userModelCredentials,
    webhooks,
    workspace,
  } = core;
  const baseAgent =
    overrides.agent ??
    createAgent({
      ...agentConfigOptions(config),
      modelGateway: gatewayTransport,
      resolveBaseModelId: () => orgBaseModelId() ?? deploymentDefaultModel(),
      resolveFallbackRuntime: () => configStore.getPurposeRuntime("fallback"),
      resolveProviderKeys: resolveCompanyProviderKeys,
      ...(directProviderAvailability.codexOAuth ? { companyModelId } : {}),
      signals: runSignals,
    });
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
  const agent = withResolvedRuntime(baseAgent, async (input, routedBy) => {
    const resolve = (requested: typeof input.runtime) =>
      resolveRuntimeChoice(
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
      if (input.runtimePinned && input.runtime?.modelId) {
        if (!modelSupported(input.runtime.modelId)) throw new Error(`Unsupported model: ${input.runtime.modelId}`);
        return { ...input.runtime, modelId: input.runtime.modelId };
      }
      return resolve(input.runtime);
    });
    if (routed.routedBy) routedBy(routed.routedBy);
    return routed.choice;
  });

  if (config.securityScreen === "off" || config.securityScreenClassifier !== "model") {
    delete agent.screenSecurity;
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
    auditLog,
    rateLimiter,
    budget,
    agent,
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
    () => advisoryLock.tryWithLock("session-return-sweep", sweepSessionReturns),
    1_000,
    { label: "session-returns", immediate: true },
  );
  const runResultSweeper = createSweeper(
    () => advisoryLock.tryWithLock("run-result-sweep", () => runResultRecovery.sweep()),
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
  orchestratorDeps.surfaceContext = surfaceContext;
  orchestratorDeps.channelPolicy = channelPolicy;
  orchestratorDeps.surfaceCache = surfaceCache;
  orchestratorDeps.control = createControlService(app, scheduler, admin);
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
  const turnReady = createPostgresNotifyBus<string>(databaseUrl, TURN_READY_CHANNEL, "turn ready");
  const turnYields = createPostgresNotifyBus<string>(databaseUrl, TURN_YIELD_CHANNEL, "turn yields");
  const turnRunner = createTurnRunner({
    ledger: turnLedger,
    orchestrator,
    queues: TURN_QUEUES,
    slots: Math.max(1, config.workers),
    ready: turnReady,
    yields: turnYields,
    canClaim: canClaimRuns,
    errors,
    ...(Number.isFinite(config.maxClaims) ? { maxClaims: config.maxClaims } : {}),
  });
  const turnRepairSweeper = createSweeper(
    () => leaderLease.hold("turns:pointer-repair", () => sweepTurns({ ledger: turnLedger, sessions, errors })),
    60_000,
    { label: "turn-pointer-repair", immediate: true },
  );
  const turnCleanupSweeper = createSweeper(
    () => leaderLease.hold("turns:cleanup", () => turnLedger.cleanup()),
    60 * 60_000,
    { label: "turn-cleanup" },
  );
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
    void backgroundClaimsStopping
      .then(() => {
        if (backgroundRunning && generation === backgroundGeneration) turnRunner.start();
      })
      .catch(swallowAs("wiring: turn runner resume failed", undefined));
    const startPeriodic = () => {
      if (!backgroundRunning || generation !== backgroundGeneration) return;
      turnRepairSweeper.start();
      turnCleanupSweeper.start();
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
      turnRepairSweeper.stop(),
      turnCleanupSweeper.stop(),
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
      swarms?.stop(),
      orphanedSignalSweeper.stop(),
      sessionReturnSweeper.stop(),
      runResultSweeper.stop(),
      approvalDeliverySweeper.stop(),
      turnRunner.stopClaims(),
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
      turnRunner.releaseInFlight(),
    ]);
  }
  setTurnStarter(() => {
    if (!backgroundStopping) turnRunner.start();
  });
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
      await Promise.all([backgroundClaimsStopping, turnRunner.stopClaims()]);
    },
    stopBackground,
    async backgroundDrained() {
      await backgroundStopping;
      await admittedWork.drained();
    },
    releaseInFlightRuns,
    async stop() {
      await stopBackground();
      await Promise.all([
        withTimeout(() => admittedWork.drained(), config.shutdownDrainMs, "admitted work drain").catch(
          swallowAs("wiring: admitted work drain failed", undefined),
        ),
        turnRunner.drained(config.shutdownDrainMs),
      ]).catch(swallowAs("wiring: turn drain failed", undefined));
      await releaseInFlightRuns();
      await drain.stop();
      await agent.close?.();
      await Promise.all(
        [turnReady.close?.(), turnYields.close?.()].map((closing) =>
          closing?.catch(swallowAs("shutdown: close turn buses", undefined)),
        ),
      );
      await core.close();
    },
  };

  return { agent, orchestrator, scheduler, jobs, runtime, monitorPoller, skillSyncEngine, turnRunner };
}
