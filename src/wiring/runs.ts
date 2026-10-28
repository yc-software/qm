import type { StoresModule } from "./stores.ts";
import { hasRows } from "../jobs/job-worker.ts";
import type { FilesModule } from "./files.ts";
import type { SandboxModule } from "./sandbox.ts";
import { tenant } from "../tenant.ts";
import type { Head } from "./late.ts";
import type { SessionStateBus } from "../runs/session-state-bus.ts";
import { createPostgresSessionStateBus } from "../runs/postgres-session-state-bus.ts";
import { type LedgerEventBus, createPostgresLedgerEventBus } from "../inbox/events.ts";
import { createPostgresRunStore } from "../runs/postgres-run-store.ts";
import { createTurnLedger } from "../turns/turn-ledger.ts";
import { bindTurnLedger, sweepTurns } from "../turns/turn-engine.ts";
import { actorAssertionActive } from "../identity/identity-service.ts";
import type { Session } from "../types.ts";
import { stoppableAncestors, sessionTreeRunCount, sessionTreeRoot, SUBAGENT_TREE_RUN_CAP } from "../subagents/tree.ts";
import type { RunStore } from "../runs/run-store.ts";
import { createProductAnalytics } from "../util/product-analytics.ts";
import { supportsProcessSessions } from "../sandbox/sandbox.ts";
import { createPostgresProcessRegistry } from "../processes/process-registry.ts";
import { createPostgresAppPageViewLog } from "../deploy/page-views.ts";
import { createPostgresBrokerSessions } from "../auth/broker-sessions.ts";
import { createPostgresReplayDedupe } from "../auth/replay-dedupe.ts";
import { createPostgresCredentialUsageSink } from "../admin/postgres-credential-usage-sink.ts";
import { createPostgresEgressAuditSink } from "../admin/postgres-egress-audit-sink.ts";
import { createPostgresNotifyBus } from "../persistence/postgres-notify-bus.ts";
import { type RunStreamEvent, emitRunText, emitRunReasoning, reasoningKey } from "../runs/run-stream-events.ts";
import type { ContextRequestEvent } from "../api/app-types.ts";
import { createTurnStream } from "../runs/turn-stream.ts";
import type { RunActivityStore } from "../runs/run-activity-store.ts";
import { createPostgresRunActivityStore } from "../runs/postgres-run-activity-store.ts";

type RunsInputs = Pick<Head, "config" | "late"> & { stores: StoresModule; files: FilesModule; sandbox: SandboxModule };

export function buildRuns(deps: RunsInputs) {
  const { config, late } = deps;
  const { databaseUrl, identity, sessions, advisoryLock, every } = deps.stores;
  const { errors } = deps.files;

  const sessionStateBus: SessionStateBus = createPostgresSessionStateBus(databaseUrl);
  const ledgerEventBus: LedgerEventBus = createPostgresLedgerEventBus(databaseUrl);
  const maxAttempts = config.maxAttempts;
  const runStore = createPostgresRunStore(databaseUrl);
  const turnLedger = createTurnLedger(databaseUrl, { onTerminal: (run) => runStore.runs.emitTerminal(run) });
  const turnBinding = bindTurnLedger(runStore.runs, turnLedger);
  const blockingApprovalSessions = async (sessionIds: readonly string[]): Promise<Set<string>> =>
    new Set(
      (await late.approvals.forSessions(sessionIds))
        .filter(([, r]) => r.blocksInput !== false && actorAssertionActive(identity, r.request?.actor))
        .map(([, r]) => r.sessionId),
    );
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
    ...turnBinding,
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
        const result = await turnBinding.enqueue(input);
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
  const productAnalytics = createProductAnalytics(() => tenant().orgId, config.productAnalytics);
  runs.onTerminal((run) => void productAnalytics.responseFinished(run));
  const ledger = runStore.ledger;
  every("turns:pointer-repair", 60_000, () => sweepTurns({ ledger: turnLedger, sessions, errors }), {
    immediate: true,
    due: hasRows("session_turn_pointers", "w.active_turn_id IS NOT NULL"),
  });
  every("turns:cleanup", 60 * 60_000, () => turnLedger.cleanup(), { shared: true });
  const {
    turnStream,
    runActivity,
    credentialUsage,
    processes,
    runStreamEvents,
    contextRequestEvents,
    stopStreamSync,
    egressAudit,
    replayDedupe,
    brokerSessions,
    appPageViews,
  } = buildRunStreams(deps, runs);
  return {
    runs,
    sessionStateBus,
    productAnalytics,
    ledgerEventBus,
    maxAttempts,
    ledger,
    blockingApprovalSessions,
    turnLedger,
    turnStream,
    runActivity,
    credentialUsage,
    processes,
    runStreamEvents,
    contextRequestEvents,
    stopStreamSync,
    egressAudit,
    replayDedupe,
    brokerSessions,
    appPageViews,
  };
}

export type RunsModule = ReturnType<typeof buildRuns>;

function buildRunStreams(deps: RunsInputs, runs: RunStore) {
  const { sandbox } = deps.sandbox;
  const { databaseUrl } = deps.stores;
  const { late, config } = deps;

  const processes = supportsProcessSessions(sandbox) ? createPostgresProcessRegistry(databaseUrl) : undefined;
  late.processes = processes;
  const appPageViews = config.awsDeploy.appsDomain ? createPostgresAppPageViewLog(databaseUrl) : undefined;
  const brokerSessions = createPostgresBrokerSessions(databaseUrl);
  const replayDedupe = createPostgresReplayDedupe(databaseUrl);
  const credentialUsage = createPostgresCredentialUsageSink(databaseUrl);
  const egressAudit = createPostgresEgressAuditSink(databaseUrl);
  const runStreamEvents = createPostgresNotifyBus<RunStreamEvent>(databaseUrl, "run_stream", "run-stream");
  const contextRequestEvents = createPostgresNotifyBus<ContextRequestEvent>(
    databaseUrl,
    "context_request_events",
    "context requests",
  );
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
  const activityStore: RunActivityStore = createPostgresRunActivityStore(databaseUrl);
  const runActivity: RunActivityStore = {
    ...activityStore,
    async append(runId, entry) {
      await activityStore.append(runId, entry);
      refreshRunStream(runId);
    },
  };
  return {
    turnStream,
    runActivity,
    credentialUsage,
    processes,
    runStreamEvents,
    contextRequestEvents,
    stopStreamSync,
    egressAudit,
    replayDedupe,
    brokerSessions,
    appPageViews,
  };
}
