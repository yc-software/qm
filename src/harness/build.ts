import type { DecisionBackend } from "../decisions/decisions.ts";
import { createDecisionHooks, routeTurnRuntime, turnStartState } from "../decisions/hooks.ts";
import { createDecisionBackend } from "../decisions/providers.ts";
import { availableRuntimeError } from "../api/runtime-config.ts";
import { tracePhase } from "../../plugins/chassis/src/error-reporting.ts";
import { createRuntimeService } from "../harness/runtime-control.ts";
import { deliverSubagentMail, sessionTreeWorking, stoppableAncestors } from "../sessions/session-syscalls.ts";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.ts";
import { resendMailer } from "../../plugins/chassis/src/resend.ts";
import { installSharedCanvas } from "../surfaces/ui-canvas.ts";
import { type Session, personalScope, scopeId } from "../types.ts";
import { wireRunResultDeliveries } from "../delivery/run-result-delivery.ts";
import { adminSessionUrl } from "../util/admin-links.ts";
import { uuidSchema } from "../util/ids.ts";
import { createScheduler } from "./scheduler.ts";
import { createCurrentScopeMembers } from "../resolution/scope-membership.ts";
import { credentialRequestHeaders } from "../credentials/keychain.ts";
import { LLM_CAPTURE_RETENTION_MS } from "../sessions/session-store.ts";
import { createAgent, agentConfigOptions } from "./agent-run.ts";
import { withResolvedRuntime, resolveRuntimeChoice } from "../agent/runtime-choice.ts";
import type { Agent } from "../agent/agent.ts";
import { createOrchestrator, type OrchestratorDeps } from "../harness/orchestrator.ts";
import { isTerminal, type Run } from "../runs/run-store.ts";
import { createRunPreemption, createWorker, type Worker, processRun } from "./worker.ts";
import {
  createNoopInstanceRegistry,
  createPostgresInstanceRegistry,
  type InstanceRegistry,
} from "./instance-registry.ts";
import { createDrainController, type DrainController } from "./drain.ts";
import { createReaper, REAPER_LEASE_KEY, type Reaper } from "./reaper.ts";
import { createProcessReaper, createReaperKillHook, type ProcessReaper } from "../processes/process-reaper.ts";
import { createJobComputerSweep } from "../processes/job-computers.ts";
import { createMonitorPoller, type MonitorPoller } from "../monitors/monitor-poller.ts";
import { createSkillSyncEngine } from "../skills/skill-sync-engine.ts";
import { supportsProcessSessions, type SandboxHandle } from "../sandbox/sandbox.ts";
import { finishProcessCredentials } from "../credentials/execute-files.ts";
import { createEngagedRegistry } from "../wake/engaged-registry.ts";
import { createWakeSweep, type WakeSweep } from "../wake/sweep.ts";
import { modelSupported } from "../model/pi-models.ts";
import { errMessage, swallowAs } from "../util/errors.ts";
import { withTimeout } from "../util/async.ts";
import type { Core, Runtime } from "../wiring.ts";
import { createControlService } from "../api/control-service.ts";
import { inTenantOf } from "../tenants/claim.ts";
import { tenantKey, tenantRootScope, withoutTenant } from "../tenants/context.ts";
import { createPostgresApprovalGrantStore } from "../core/approval-grant-store.ts";
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
    decisions,
    deploymentDefaultModel,
    deliveries,
    deployProvider,
    deployService,
    deploymentLayer,
    directory,
    environments,
    errors,
    fallback,
    featureFlags,
    fileUploads,
    files,
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
    monitors,
    orgBaseModelId,
    pgArtifactMap,
    prepareSessionRequest,
    processes,
    projects,
    rateLimiter,
    refreshModels,
    releaseWaiters,
    setInlineRunner,
    resolution,
    resolveClient,
    resolveCompanyProviderKeys,
    resolveRecipient,
    runActivity,
    runSignals,
    runTriggered,
    runs,
    runtimeDeps,
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
    tenantLease,
    tenantModels,
    tenantSettings,
    tenants,
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
      defaultModelId: deploymentDefaultModel,
      detectModelId: () => tenantSettings.peek().piDetectModel,
      titleModelId: () => tenantSettings.peek().piTitleModel,
      judgeModelId: () => tenantSettings.peek().piJudgeModel,
      resolveModelGateway: () => tenantModels.gateway(),
      resolveBaseModelId: () => orgBaseModelId() ?? deploymentDefaultModel(),
      resolveFallbackRuntime: () => configStore.getPurposeRuntime("fallback"),
      resolveProviderKeys: resolveCompanyProviderKeys,
      companyModelId,
      signals: runSignals,
    });
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
  const agent = withResolvedRuntime(baseAgent, async (input, routedBy) => {
    const resolve = (requested: typeof input.runtime) =>
      resolveRuntimeChoice(
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
      if (input.runtimePinned && input.runtime?.modelId) {
        if (!modelSupported(input.runtime.modelId)) throw new Error(`Unsupported model: ${input.runtime.modelId}`);
        return { ...input.runtime, modelId: input.runtime.modelId };
      }
      return resolve(input.runtime);
    });
    if (routed.routedBy) routedBy(routed.routedBy);
    return routed.choice;
  });

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
    approvalGrants: createPostgresApprovalGrantStore(config.databaseUrl!),
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
  setInlineRunner((run, shutdown) => processRun({ runs, orchestrator, leaseTtlMs }, run, { shutdown }));

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
  const engaged = createEngagedRegistry({ maxAgeMs: config.runMaxAgeMs });
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
    void withoutTenant(() => leaderLease.hold(REAPER_LEASE_KEY, () => reaper.sweep()))
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
    tenants,
    sweepAsks: async (now) => sweepAsks?.(now),
    sweepLoops: async (now) => {
      ingressMaintenance ??= admittedWork
        .run(() => loopIngress.maintain())
        .catch(swallowAs("Loop ingress maintenance", undefined))
        .finally(() => (ingressMaintenance = undefined));
      await loopFire.sweepStale(now);
    },
  });
  const stopCronChanged = cronChanged.subscribe(({ cronId }) => scheduler.notifyChanged(cronId), { allTenants: true });
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
    leaderLease: tenantLease,
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
    () => leaderLease.hold("monitor:retention:sweep", () => monitors.deleteDefunct(Date.now())),
    MONITOR_RETENTION_SWEEP_MS,
    { label: "monitor-retention", immediate: true },
  );
  const deployIdleTtlMs = deployProvider.profile.managedScaleToZero ? undefined : config.deployIdleTtlMs;
  const BLOB_TTL_MS = 6 * 60 * 60_000;
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
          tenantLease.hold("sandbox:deep-idle-reaper", () =>
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
      await agent.close?.();
      await core.close();
    },
  };
  return { agent, orchestrator, scheduler, runtime, monitorPoller, skillSyncEngine, reaper, workers };
}
