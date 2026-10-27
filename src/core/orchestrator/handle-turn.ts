import { surfaceHas } from "../../surfaces/surface.ts";
import { UNTRACKED_PROVENANCE } from "../../memory/facts.ts";
import { type Session, type TurnResult } from "../../types.ts";
import type { DirectoryStore, DirectoryChannel, DirectoryMember } from "../../directory/directory-store.ts";
import type { GapPhase } from "../../sessions/session-store.ts";
import { createTranscriptSource } from "../../sessions/transcript-source.ts";
import { swallow, swallowAs } from "../../util/errors.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";
import { admitTurn } from "./admit.ts";
import { holdTurnLease } from "./turn-lease.ts";
import { openTurnSession, resolveTurnScope, resolveTurnWorkspace, type TurnCtx } from "./turn-context.ts";
import { observeInboundTurn } from "./inbound-screen.ts";
import { buildCredentialCatalog } from "./credential-catalog.ts";
import { frameTurnPrompt } from "./turn-prompt.ts";
import { concludeTurn, mapTurnFailure, settleTurnResult } from "./settle.ts";
import { detectAmbientDecline, findRecordedTurn, replayRecordedAnswer } from "./turn-replay.ts";
import { openTurnSandboxes } from "./turn-sandboxes.ts";
import { finishSystemPrompt } from "./turn-prompt.ts";
import { buildTurnTools, firstAckPublisher } from "./turn-tools.ts";
import { prepareTurnInput, turnFailureUserItem } from "./turn-input.ts";
import { selectTurnRuntime } from "./turn-runtime.ts";
import { runSegments, type GapWorkFeed, type SegmentTurn, type TurnRunState } from "./turn-segment.ts";
import { consumeApprovalDecision, loadApprovalLedger, type ApprovalLedger } from "./approvals.ts";
import { createSessionTitles } from "../session-title.ts";
import type { MemoryPolicy } from "../../memory/policy.ts";
import type { MemoryStrategy } from "../../memory/strategy.ts";
import type { CompactionContext } from "./compaction.ts";
import type { SecurityObserver } from "./security-screen.ts";
import type { RecordedTurn } from "../turn-resume.ts";

const MODEL_ACCESS_BLOCK =
  "## Model access\nAn OpenAI-compatible model gateway is at `$MODEL_GATEWAY_URL` in the sandbox; authenticate with `Authorization: Bearer $MODEL_GATEWAY_TOKEN`. `GET $MODEL_GATEWAY_URL/v1/models` lists the usable models. The token is bound to this turn and expires with it; never send it anywhere but the gateway.";

export interface OrchestratorInstance {
  deps: OrchestratorDeps;
  transcripts: ReturnType<typeof createTranscriptSource>;
  memoryPolicy: MemoryPolicy;
  memoryStrategy: MemoryStrategy;
  blobTransfer: OrchestratorDeps["blobTransfer"];
  reachableChannelsFor: (directory: DirectoryStore, principalId: string) => Promise<DirectoryChannel[]>;
  directoryIndexFor: (directory: DirectoryStore) => Promise<Map<string, DirectoryMember>>;
  compaction: CompactionContext;
  observeSecurityData: SecurityObserver;
  titles: ReturnType<typeof createSessionTitles>;
}

export type TurnFrame = Awaited<ReturnType<typeof frameTurn>>;
export type HeldLease = Exclude<Awaited<ReturnType<typeof holdTurnLease>>, { refused: TurnResult }>;
export type BegunTurn = Extract<Awaited<ReturnType<typeof beginTurn>>, { done: false }>;
export type ReadyTurn = Awaited<ReturnType<typeof readyTurn>>;
type SessionTitling = ReturnType<typeof sessionTitling>;
type Catalog = Awaited<ReturnType<typeof buildCredentialCatalog>>;
type Sandboxes = ReturnType<typeof openTurnSandboxes>;

export async function handleTurn(o: OrchestratorInstance, requested: OrchestratorInput): Promise<TurnResult> {
  const { deps } = o;
  const admission = await admitTurn(deps, requested);
  if ("refused" in admission) return admission.refused;
  const ctx = await resolveTurnScope(deps, admission.admitted);
  const frame = await frameTurn(o, ctx);
  const session = await openTurnSession(ctx);
  const titling = sessionTitling(o.titles, ctx, session);
  const recordedTurn = ctx.isRetry ? await findRecordedTurn(ctx, session) : null;
  const recordedReplay = recordedTurn ? replayRecordedAnswer(ctx, session, recordedTurn) : undefined;
  if (recordedReplay) return recordedReplay;
  deps.auditLog.record({
    at: Date.now(),
    principalId: ctx.actor.id,
    action: "turn",
    resource: ctx.conversation.threadRef,
    scopeLabel: ctx.scopeId,
  });
  const approvalLedger = loadApprovalLedger(await ctx.actorGrants(), session.id, ctx.resolution.approvalGrantModes);
  const catalog = await buildCredentialCatalog(ctx, {
    sharingSources: frame.context.sharingSources,
    delivery: frame.framed.delivery,
    defaultDestination: frame.framed.defaultDestination,
    session,
  });
  if (catalog.sandboxModelGateway) frame.framed.turnContextBlocks["Model access"] = MODEL_ACCESS_BLOCK;
  const run = newTurnRunState();
  const turnSandboxes = openTurnSandboxes(ctx, {
    context: frame.context,
    framed: frame.framed,
    catalog,
    session,
    emitGapWork: run.gap.emit,
  });
  const held = await holdTurnLease(ctx, { session, run });
  if ("refused" in held) return held.refused;
  if (!ctx.ambientTurn) titling.assignSessionTitle();
  try {
    const begun = await beginTurn(o, ctx, {
      frame,
      session,
      catalog,
      approvalLedger,
      recordedTurn,
      titling,
      held,
      run,
    });
    if (begun.done) return begun.result;
    const ready = await readyTurn(o, ctx, {
      frame,
      session,
      catalog,
      approvalLedger,
      recordedTurn,
      titling,
      held,
      run,
      sandboxes: turnSandboxes,
      begun,
    });
    return await executeTurn(o, ctx, {
      frame,
      session,
      catalog,
      approvalLedger,
      titling,
      held,
      run,
      sandboxes: turnSandboxes,
      begun,
      ready,
    });
  } catch (err) {
    return await mapTurnFailure(ctx, { session, lease: held.lease, failureUserItem: run.failureUserItem }, err);
  } finally {
    await releaseTurn(o, ctx, { session, held, run, reclaimBox: turnSandboxes.sandboxes.reclaimBox });
  }
}

async function frameTurn(o: OrchestratorInstance, ctx: TurnCtx) {
  const { deps, memoryPolicy, memoryStrategy, blobTransfer, observeSecurityData } = o;
  const screenTrace = observeInboundTurn(ctx, { observeSecurityData, blobTransfer });
  const mcpToolsReady = !ctx.external && deps.mcp ? deps.mcp.toolDefsFor(ctx.actor.id) : undefined;
  const context = await resolveTurnWorkspace(ctx, memoryPolicy);
  ctx.resolution.grantedHandles = context.listFiles();
  const framed = await frameTurnPrompt(ctx, { screenTrace, context, memoryStrategy, observeSecurityData });
  return { screenTrace, mcpToolsReady, context, framed };
}

async function beginTurn(
  o: OrchestratorInstance,
  ctx: TurnCtx,
  turn: {
    frame: TurnFrame;
    session: Session;
    catalog: Catalog;
    approvalLedger: ApprovalLedger;
    recordedTurn: RecordedTurn | null;
    titling: SessionTitling;
    held: HeldLease;
    run: TurnRunState;
  },
) {
  const { deps, transcripts } = o;
  const { input, actor, scopeId, resolution, withManagedRosterVersion, mirrorRunActivity } = ctx;
  const { frame, session, run } = turn;
  await withManagedRosterVersion(async () => {
    await ctx.reconcileSessionParticipants(session.id);
    return true;
  });
  const memoryWindow = await deps.sessions.getContextWindow(session.id);

  const memoryView = await frame.context.memorySnapshot();
  const captureDependencies = () => [
    ...memoryView.facts,
    ...(!memoryView.complete ||
    memoryWindow.items.length > 0 ||
    run.toolCalls > 0 ||
    input.priorTurns?.length ||
    input.overheard?.length ||
    input.attachments?.length ||
    input.inboundNotes
      ? [UNTRACKED_PROVENANCE]
      : []),
  ];
  const historyWindow = () => deps.sessions.getContextWindow(session.id);
  let approvalNote = "";
  if (input.approval) {
    const decided = await consumeApprovalDecision({
      deps,
      decision: input.approval,
      sessionId: session.id,
      ...(input.runId ? { runId: input.runId } : {}),
      lease: turn.held.lease,
      actorId: actor.id,
      scopeId,
      resolution,
      ledger: turn.approvalLedger,
      withRosterVersion: withManagedRosterVersion,
      mirror: mirrorRunActivity,
    });
    if (decided.kind === "settled") return { done: true as const, result: decided.result };
    approvalNote = decided.approvalNote;
  }

  const finished = await finishSystemPrompt(ctx, frame.framed, turn.catalog, o);
  const volatileContext = [finished.volatileContext, approvalNote].filter(Boolean).join("\n\n");

  const declined = await detectAmbientDecline(ctx, {
    session,
    recordedTurn: turn.recordedTurn,
    historyWindow,
    transcripts,
  });
  if (declined) return { done: true as const, result: declined };
  if (ctx.ambientTurn) turn.titling.assignSessionTitle();

  return {
    done: false as const,
    memoryView,
    captureDependencies,
    historyWindow,
    systemPrompt: finished.systemPrompt,
    volatileContext,
  };
}

async function readyTurn(
  o: OrchestratorInstance,
  ctx: TurnCtx,
  turn: {
    frame: TurnFrame;
    session: Session;
    catalog: Catalog;
    approvalLedger: ApprovalLedger;
    recordedTurn: RecordedTurn | null;
    titling: SessionTitling;
    held: HeldLease;
    run: TurnRunState;
    sandboxes: Sandboxes;
    begun: BegunTurn;
  },
) {
  const { deps, transcripts, observeSecurityData } = o;
  const { compactContextIfNeeded, documentTokenBudget } = o.compaction;
  const { input } = ctx;
  const { frame, session, held, run, begun } = turn;
  const { screenTrace, context, framed } = frame;
  const { sandboxes, turnSandboxResources } = turn.sandboxes;
  if (input.runId) {
    if ((surfaceHas(input.surface, "earlyAck") || input.surface === "monitor") && input.runLeaseToken) {
      await deps.runs
        ?.setDeliveryState(input.runId, input.runLeaseToken, { replying: true })
        .catch(swallowAs("orchestrator: persist reply engagement", false));
    }
    deps.turnStream?.begin(input.runId);
  }

  const turnTools = await buildTurnTools(ctx, {
    session,
    context,
    framed,
    catalog: turn.catalog,
    sandboxes,
    approvalLedger: turn.approvalLedger,
    turnSandboxResources,
    gapWork: run.gap,
    turnAbort: held.turnAbort,
    captureDependencies: begun.captureDependencies,
  });
  const prepared = await prepareTurnInput(ctx, {
    screenTrace,
    context,
    memoryView: begun.memoryView,
    framed,
    session,
    recordedTurn: turn.recordedTurn,
    provision: sandboxes.provision,
    lease: held.lease,
    turnAbort: held.turnAbort,
    historyWindow: begun.historyWindow,
    volatileContext: begun.volatileContext,
    turnTools,
    transcripts,
    documentTokenBudget,
    compactContextIfNeeded,
    observeSecurityData,
  });
  run.contextRecovered = prepared.contextRecovered;
  run.remainingDocumentBytes = prepared.remainingDocumentBytes;
  run.remainingDocumentCount = prepared.remainingDocumentCount;
  run.remainingDocumentTokens = prepared.remainingDocumentTokens;
  const { approvalReplay, resume, isPollFire, partial } = prepared;
  const publishFirstAck = firstAckPublisher(ctx, {
    turnTools,
    defaultDestination: framed.defaultDestination,
    isPollFire,
    resume,
    approvalReplay,
  });
  const syntheticPrompt = Boolean(turn.titling.syntheticInput || partial || approvalReplay);
  return { turnTools, prepared, publishFirstAck, syntheticPrompt };
}

async function executeTurn(
  o: OrchestratorInstance,
  ctx: TurnCtx,
  turn: {
    frame: TurnFrame;
    session: Session;
    catalog: Catalog;
    approvalLedger: ApprovalLedger;
    titling: SessionTitling;
    held: HeldLease;
    run: TurnRunState;
    sandboxes: Sandboxes;
    begun: BegunTurn;
    ready: ReadyTurn;
  },
): Promise<TurnResult> {
  const { deps, memoryPolicy, memoryStrategy, observeSecurityData, titles } = o;
  const { input, scopeId } = ctx;
  const { frame, session, held, run, begun, ready, titling } = turn;
  const { spine, surfaceToolDeps, attachStaging } = ready.turnTools;
  const { inboundIssues, partial, turnInput, isPollFire } = ready.prepared;
  const { sandboxes } = turn.sandboxes;
  run.turnStart = Date.now();
  run.failureUserItem = ready.syntheticPrompt ? undefined : turnFailureUserItem(ctx, inboundIssues);
  const { controlClaims, scopeAttestation } = turn.catalog;
  const selected = await selectTurnRuntime(ctx, { session, controlClaims, scopeAttestation });
  const segmentTurn: SegmentTurn = {
    frame,
    session,
    held,
    run,
    begun,
    ready,
    selected,
    approvalLedger: turn.approvalLedger,
    provision: sandboxes.provision,
    observeSecurityData,
  };
  run.runtimeHandoffs = selected.restoredRuntime ? 1 : 0;
  const result = await runSegments(ctx, segmentTurn, o.compaction.compactRecent);

  const { stagedAttachments, reply, cancelStopped, outcome, turnCompleted, pausing, turnUserSeq } = await concludeTurn(
    ctx,
    {
      session,
      result,
      attachStaging,
      spine,
      partial,
      turnInput,
      emittedEntries: run.emittedEntries,
      memoryScopeId: frame.context.memoryScopeId,
      captureDependencies: begun.captureDependencies,
      memoryStrategy,
      memoryPolicy,
    },
  );

  const tail = async (): Promise<void> => {
    try {
      if (!pausing && turnCompleted && !session.title && !titling.title.write) {
        await titles.generateAndStore(
          session.id,
          scopeId,
          `User:\n${titling.titleText}\n\nAssistant:\n${result.reply}`,
        );
      }
    } finally {
      await sandboxes.reclaimBox();
    }
  };

  let finalResult = await settleTurnResult(ctx, {
    session,
    hasSurfaceToolDeps: Boolean(surfaceToolDeps),
    isPollFire,
    emittedEntries: run.emittedEntries,
    result,
    stagedAttachments,
    reply,
    cancelStopped,
    outcome,
    turnCompleted,
    turnUserSeq,
  });
  if (run.turnRuntime) finalResult = { ...finalResult, runtime: run.turnRuntime };
  await titling.title.write;

  if (input.background) {
    run.tailOwnsReclaim = true;
    await held.catchUpMessageRevisions();
    await deps.sessions.releaseLease(held.lease);
    held.leaseState.released = true;
    void tail().catch(swallowAs("orchestrator: background tail", undefined));
  } else {
    await tail();
    run.tailOwnsReclaim = true;
  }
  await deps.errors?.flush();
  return finalResult;
}

async function releaseTurn(
  o: OrchestratorInstance,
  ctx: TurnCtx,
  turn: { session: Session; held: HeldLease; run: TurnRunState; reclaimBox: () => Promise<void> },
): Promise<void> {
  const { deps } = o;
  const { input, actor, resolution, scopeId } = ctx;
  const { session, held, run } = turn;
  if (input.runId) deps.turnStream?.end(input.runId);
  held.stopLeaseKeepalive();
  if (!run.tailOwnsReclaim) await turn.reclaimBox();
  if (!held.leaseState.released) {
    await held.catchUpMessageRevisions();
    await deps.sessions.releaseLease(held.lease);
  }
  if (!run.contextRecovered && !held.turnAbort.signal.aborted)
    o.compaction.scheduleBackgroundCompaction({
      sessionId: session.id,
      scopeId,
      orgScopeId: resolution.orgScopeId,
      actorId: actor.id,
      ...(input.model ? { model: input.model } : {}),
    });
}

function newTurnRunState(): TurnRunState {
  return {
    toolCalls: 0,
    turnProgress: 0,
    firstTokenMarked: false,
    runtimeHandoffs: 0,
    contextRecovered: false,
    remainingDocumentBytes: 0,
    remainingDocumentCount: 0,
    remainingDocumentTokens: 0,
    turnStart: 0,
    emittedEntries: [],
    tailOwnsReclaim: false,
    gap: createGapWork(),
  };
}

function createGapWork(): GapWorkFeed {
  const gap: GapWorkFeed = {
    emit: (phase: GapPhase, start: number, end: number): void => {
      try {
        gap.listener?.({ phase, start, end });
      } catch (e) {
        swallow("gap-work emit", e);
      }
    },
  };
  return gap;
}

function sessionTitling(titles: OrchestratorInstance["titles"], ctx: TurnCtx, session: Session) {
  const { input, automatedTurn, sessionTurn, scopeId } = ctx;
  const delegatedTask = !!input.sessionSenderId && session.parentSessionId === input.sessionSenderId;
  const syntheticInput =
    (input.proactiveOpener && !input.text.trim()) ||
    ((automatedTurn || (sessionTurn && input.envelopeWrapped)) && !delegatedTask);
  const titleText = input.displayText?.trim() || input.text;
  const title: { write?: Promise<void> } = {};
  const assignSessionTitle = () => {
    if (!session.title && !syntheticInput && !input.approval)
      title.write = titles.titleFromFirstMessage(session, scopeId, titleText);
  };
  return { syntheticInput, titleText, title, assignSessionTitle };
}
