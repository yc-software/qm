import { surfaceHas } from "../../surfaces/surface.ts";
import type { TurnCtx } from "./turn-context.ts";
import type { ApprovalLedger } from "./approvals.ts";
import type { selectTurnRuntime } from "./turn-runtime.ts";
import type { BegunTurn, HeldLease, ReadyTurn, TurnFrame } from "./handle-turn.ts";
import type { SecurityObserver } from "./security-screen.ts";
import type { Outbound } from "../../surfaces/outbound.ts";
import type { Session } from "../../types.ts";
import { markFirstToken } from "../../../plugins/chassis/src/error-reporting.ts";
import { memoryRecallDelta } from "../../memory/recall-delta.ts";
import { loadDocumentInputs } from "../document-inputs.ts";
import { goalView } from "../../runs/turn-stream.ts";
import { type GoalRecord, openGoal } from "../../harness/goal.ts";
import { type Destination, type TurnRuntime } from "../../types.ts";
import { loadProtocolFile } from "../../resolution/prompt-vars.ts";
import { reachPost } from "../../reach/reach.ts";
import type { GapPhase } from "../../sessions/session-store.ts";
import { isUserMessage, type Item, type NewItem } from "../../sessions/items.ts";
import { environmentDelta } from "../environment-facts.ts";
import { estimateCostUsd } from "../../ratelimit/budget.ts";
import type { GapWork, HarnessTurnInput, RuntimeChoice } from "../../harness/harness.ts";
import { forModelContext } from "../../harness/context-compaction.ts";
import { securityScreenChunks, toolLabelOf, type ToolResultScreenInput } from "../../security/security-screen.ts";
import { artifactImageLoader } from "../../harness/replay-images.ts";
import {
  environmentNote,
  inboundIssuesNote,
  inboundIssueList,
  inboundManifest,
  materializeInbound,
  safeAttachmentName,
} from "../attachments.ts";
import { runtimeSwitchNote } from "../turn-resume.ts";
import { reportFailure, swallowAs } from "../../util/errors.ts";
import { absoluteAppLinks } from "../../util/markdown.ts";
import { NonRetryableTurnError } from "../turn-error.ts";
import { randomUUID } from "node:crypto";
import { stripAckPrefix } from "./turn-helpers.ts";
import { createCompaction } from "./compaction.ts";
import { createTurnSandboxes } from "./sandboxes.ts";

const FIRST_BLOCK_CAPTURE_MAX_CHARS = 20_000;
const ADDRESSED_NUDGE_MD = loadProtocolFile("turn-addressed-nudge");

export interface TurnRunState {
  toolCalls: number;
  turnProgress: number;
  failureUserItem?: NewItem<"UserMessage">;
  firstTokenMarked: boolean;
  turnRuntime?: TurnRuntime;
  runtimeHandoffs: number;
  contextRecovered: boolean;
  remainingDocumentBytes: number;
  remainingDocumentCount: number;
  remainingDocumentTokens: number;
  turnStart: number;
  emittedEntries: Item[];
  tailOwnsReclaim: boolean;
  gap: GapWorkFeed;
}

export interface GapWorkFeed {
  listener?: (work: GapWork) => void;
  emit: (phase: GapPhase, start: number, end: number) => void;
}

export interface SegmentTurn {
  frame: TurnFrame;
  session: Session;
  held: HeldLease;
  run: TurnRunState;
  begun: BegunTurn;
  ready: ReadyTurn;
  selected: Awaited<ReturnType<typeof selectTurnRuntime>>;
  approvalLedger: ApprovalLedger;
  provision: ReturnType<typeof createTurnSandboxes>["provision"];
  observeSecurityData: SecurityObserver;
}

function createHarnessSegment(ctx: TurnCtx, turn: SegmentTurn) {
  return (harnessInput: string, extras: Parameters<typeof runHarnessSegment>[3], continuation?: { history: Item[] }) =>
    runHarnessSegment(ctx, turn, harnessInput, extras, continuation);
}

type Prepared = ReadyTurn["prepared"];

async function runHarnessSegment(
  ctx: TurnCtx,
  turn: SegmentTurn,
  harnessInput: string,
  extras: {
    priorTurns?: typeof ctx.input.priorTurns;
    overheard?: Prepared["importedOverheard"];
    attachments?: Prepared["inbound"]["metas"];
    images?: Prepared["inbound"]["images"];
  },
  continuation?: { history: Item[] },
) {
  const { deps, input, messageTs, entryTs, turnTimezone, resolution, scopeId, strictReadOnly } = ctx;
  const { frame, ready, session, held, run } = turn;
  const { surfaceName, delegateWork } = frame.framed;
  const { consume: consumeApproval } = turn.approvalLedger;
  const { mayReadArtifact, surfaceToolDeps, tools } = ready.turnTools;
  const { partial, resumePlan, history, documentInputs, continueTurn, isPollFire } = ready.prepared;
  const { effectiveTurnWallClockMs, runtimeState } = turn.selected;
  const { mcpToolsReady } = frame;
  const { systemPrompt } = turn.begun;
  const { lease, turnAbort } = held;
  const { turnStart } = run;
  const segmentEnv = segmentEnvironment(
    { frame, prepared: ready.prepared, memoryView: turn.begun.memoryView, session },
    continuation,
  );
  const { environment, silentResume } = segmentEnv;
  const emit = createSegmentEmit(ctx, { framed: frame.framed, ready, lease, run }, segmentEnv, continuation);
  const initialDocuments = [...documentInputs.documents];
  const storedGoal = (await deps.sessions.goals([session.id])).get(session.id);
  const sessionGoal = openGoal(storedGoal);
  const saveGoal = async (goal: GoalRecord): Promise<void> => {
    await deps.sessions.setGoal(lease, goal);
    if (input.runId) deps.turnStream?.noteGoal(input.runId, goalView(goal));
  };
  const turnResult = await deps.harness.turns.runTurn({
    session,
    loadImage: artifactImageLoader(deps.files, mayReadArtifact),
    ...(turnTimezone ? { timezone: turnTimezone } : {}),
    prepareSteer: createPrepareSteer(ctx, turn, initialDocuments),
    ...segmentRuntimeOptions(ctx, turn.selected, run),
    ...(input.runId ? { runId: input.runId } : {}),
    cancel: turnAbort.signal,
    ...(silentResume ? { continueTurn: true, resumeUserSeq: partial!.userSeq } : {}),
    ...(input.shutdown ? { shutdown: input.shutdown } : {}),
    input: continueTurn && !continuation && !silentResume ? "" : harnessInput,
    ...(!partial && messageTs ? { triggerTs: messageTs } : {}),
    ...(!partial && entryTs ? { entryTs } : {}),
    ...(environment ? { environment } : {}),
    ...(extras.priorTurns?.length ? { priorTurns: extras.priorTurns } : {}),
    ...(extras.overheard?.length ? { overheard: extras.overheard } : {}),
    ...(extras.attachments?.length ? { attachments: extras.attachments } : {}),
    ...(extras.images?.length ? { images: extras.images } : {}),
    documents: initialDocuments,
    ...(Object.keys(runtimeState.requestedRuntime).length ? { runtime: runtimeState.requestedRuntime } : {}),
    ...(strictReadOnly ? { readOnly: true } : {}),
    surfaceName,
    delegateWork,
    ...((session.clientTools ?? input.clientTools)?.length
      ? { clientTools: session.clientTools ?? input.clientTools }
      : {}),
    ...(input.surfaceTools && surfaceToolDeps ? { surfaceTools: true } : {}),
    ...(isPollFire ? { pollFire: true } : {}),
    turnWallClockMs:
      effectiveTurnWallClockMs > 0
        ? Math.max(1, effectiveTurnWallClockMs - (Date.now() - turnStart))
        : effectiveTurnWallClockMs,
    toolApprovalGate: consumeApproval,
    systemPrompt,
    history: continuation?.history ?? history,
    tools,
    ...(mcpToolsReady ? { mcpTools: await mcpToolsReady } : {}),
    ...(resumePlan?.kind === "retry" && !continuation ? { resumeToolCall: resumePlan.call } : {}),
    emit,
    goal: sessionGoal,
    saveGoal,
    scopeLabel: scopeId,
    orgScopeId: resolution.orgScopeId,
    ...segmentCallbacks(ctx, turn),
  });
  return turnResult;
}

function segmentEnvironment(
  turn: { frame: TurnFrame; prepared: Prepared; memoryView: BegunTurn["memoryView"]; session: Session },
  continuation: { history: Item[] } | undefined,
) {
  const { turnContextBlocks, memoryHeading } = turn.frame.framed;
  const { inboundIssues, recalled, history, documentInputs, turnEnvironmentContents, continueTurn } = turn.prepared;
  const { context } = turn.frame;
  const { memoryView, session } = turn;
  const recall = memoryRecallDelta(recalled, continuation?.history ?? history, memoryView.held, context.memoryLabels);
  const snapshot = environmentDelta(turnContextBlocks, continuation?.history ?? history, session.id);
  const turnEnvironment = environmentNote(
    [
      turnEnvironmentContents,
      snapshot.text,
      recall.text ? `${memoryHeading}${recall.text}` : "",
      inboundIssuesNote(inboundIssues),
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
  const environment = [turnEnvironment, ...documentInputs.notices].filter(Boolean).join("\n");
  const silentResume = continueTurn && !continuation && !snapshot.text && !recall.text;
  return { recall, snapshot, environment, silentResume };
}

function createSegmentEmit(
  ctx: TurnCtx,
  turn: { framed: TurnFrame["framed"]; ready: ReadyTurn; lease: HeldLease["lease"]; run: TurnRunState },
  { recall, snapshot, environment }: ReturnType<typeof segmentEnvironment>,
  continuation: { history: Item[] } | undefined,
): HarnessTurnInput["emit"] {
  const { deps, input, actor, humanInput, coreReceivedAt, withManagedRosterVersion, mirrorRunActivity } = ctx;
  const { surfaceName } = turn.framed;
  const { spine } = turn.ready.turnTools;
  const { partial } = turn.ready.prepared;
  const { publishFirstAck, syntheticPrompt } = turn.ready;
  const { lease, run } = turn;
  const { emittedEntries } = run;
  const emitGapWork = run.gap.emit;
  let recordedRecall = false;
  const emit: HarnessTurnInput["emit"] = async (entry) => {
    run.turnProgress++;
    const persistStart = Date.now();
    try {
      const stored = ((): NewItem => {
        if (
          (entry.kind === "AgentMessage" && !entry.variant) ||
          entry.kind === "Elicitation" ||
          ((entry.kind === "ToolResult" || entry.kind === "ToolCall") && entry.body?.blocked === "needs_approval")
        ) {
          const body = { ...entry.body };
          if (typeof body.workStartedAt !== "number") body.workStartedAt = input.runStartedAt ?? coreReceivedAt;
          if (typeof body.workFinishedAt !== "number") body.workFinishedAt = Date.now();
          return { ...entry, body };
        }
        if (entry.kind !== "UserMessage" && entry.kind !== "SteeringMessage") return entry;
        const body: Record<string, unknown> = { ...entry.body };
        const steered = entry.kind === "SteeringMessage";
        const overheard = body.overheard === true;
        const turnStart = !steered && !overheard;
        if (!recordedRecall && turnStart) {
          recordedRecall = true;
          body.environmentSnapshot = snapshot.record;
          if (environment) body.environment = environment;
          if (recall.text) body.memoryRecall = recall.record;
        }
        delete body.speakerId;
        if (humanInput && !syntheticPrompt && !continuation && turnStart) body.speakerId = actor.id;
        if (actor.displayName?.trim() && typeof body.name !== "string") body.name = actor.displayName.trim();
        if (input.displayText?.trim() && entry.text === input.text && typeof body.display !== "string")
          body.display = input.displayText;
        if ((partial || continuation) && turnStart) body.resumeNote = true;
        return entry.kind === "UserMessage"
          ? { ...entry, body, ...((syntheticPrompt || continuation) && { hidden: true }) }
          : { ...entry, body };
      })();
      const appended = await withManagedRosterVersion(() => deps.sessions.append(lease, stored));
      emittedEntries.push(appended);
      if (isUserMessage(appended) && spine.turnUserEntrySeq === undefined) {
        spine.turnUserEntrySeq = appended.seq;
        if (input.runId && deps.runs)
          await deps.runs
            .noteTurnUserSeq(input.runId, appended.seq)
            .catch(swallowAs("orchestrator: record turn boundary", false));
      }
      if (isUserMessage(appended)) run.failureUserItem = undefined;
      if (appended.kind === "ToolCall") {
        run.toolCalls += 1;
        if (run.toolCalls === 1 && input.runId) {
          if (!input.surfaceTools) {
            deps.turnStream?.noteToolCall(input.runId);
          } else {
            publishFirstAck(appended.tool === surfaceName && appended.body.action === "post");
          }
        }
      }
      await mirrorRunActivity(appended);
      return appended;
    } finally {
      emitGapWork("persist", persistStart, Date.now());
    }
  };
  return emit;
}

function createPrepareSteer(
  ctx: TurnCtx,
  turn: Pick<SegmentTurn, "frame" | "ready" | "session" | "held" | "run" | "provision" | "observeSecurityData">,
  initialDocuments: HarnessTurnInput["documents"],
): NonNullable<HarnessTurnInput["prepareSteer"]> {
  const { deps, input, actor, conversation, scopeId, strictReadOnly } = ctx;
  const { blobTransfer } = deps;
  const { screenTrace } = turn.frame;
  const { turnInboxDir } = turn.frame.framed;
  const { fileRegistration, mayReadArtifact } = turn.ready.turnTools;
  const { documentInputs, observeDocuments } = turn.ready.prepared;
  const { provision, session, run, observeSecurityData } = turn;
  const { turnAbort } = turn.held;
  return async (text, request) => {
    const author = request ? deps.identity.resolve(request.actor).id : actor.id;
    const refreshedInbox =
      surfaceHas(input.surface, "sidebar") &&
      conversation.kind === "dm" &&
      /^web:.+:inbox$/.test(conversation.threadRef) &&
      request?.conversation.threadRef === conversation.threadRef
        ? request.conversationHeader?.trim()
        : undefined;
    if (refreshedInbox) {
      for (const chunk of securityScreenChunks("conversation-header", refreshedInbox))
        void observeSecurityData(chunk, actor.id, scopeId, {
          ...screenTrace,
          sessionId: session.id,
          hook: "user_input",
          request: text,
          surface: "steer",
          origin: input.origin.kind,
        });
      text = `${text}\n\n${refreshedInbox}`;
    }
    if (!request?.attachments?.length) return { text, author };
    const seed = `${fileRegistration.seed}:steer:${randomUUID()}`;
    const inboxDir = `${turnInboxDir}/${randomUUID()}`;
    const received = strictReadOnly
      ? { metas: [], images: [], tooMany: [], unavailable: [] }
      : await materializeInbound(
          deps.sandbox,
          provision,
          request.attachments,
          blobTransfer,
          { ...fileRegistration, seed },
          inboxDir,
          ({ content, name, mimetype }) =>
            void observeSecurityData(JSON.stringify({ name, mimetype, content }), actor.id, scopeId, {
              ...screenTrace,
              sessionId: session.id,
              hook: "tool_response",
              surface: "inbound_file",
              origin: input.origin.kind,
            }),
        );
    const steeredDocuments = await loadDocumentInputs(
      deps.files,
      received.metas,
      mayReadArtifact,
      run.remainingDocumentBytes,
      turnAbort.signal,
      run.remainingDocumentCount,
      initialDocuments,
      run.remainingDocumentTokens,
    );
    observeDocuments(steeredDocuments, text);
    run.remainingDocumentBytes -= steeredDocuments.documents.reduce(
      (sum, document) => sum + Buffer.byteLength(document.dataBase64, "base64"),
      0,
    );
    run.remainingDocumentCount -= steeredDocuments.documents.length;
    run.remainingDocumentTokens -= steeredDocuments.tokens;
    documentInputs.documents.push(...steeredDocuments.documents);
    const issues = inboundIssueList({
      ...received,
      surfaceNotes: strictReadOnly
        ? request.attachments.map((a) => `${safeAttachmentName(a.name)} — unavailable in read-only mode`)
        : [],
    });
    return {
      text: [
        text,
        inboundManifest(received.metas, inboxDir, received.unstaged),
        ...steeredDocuments.notices,
        inboundIssuesNote(issues),
      ]
        .filter(Boolean)
        .join("\n\n"),
      attachments: received.metas,
      images: received.images,
      documents: steeredDocuments.documents,
      author,
    };
  };
}

function segmentRuntimeOptions(
  ctx: TurnCtx,
  selected: SegmentTurn["selected"],
  run: TurnRunState,
): Partial<HarnessTurnInput> {
  const { deps, input, actor, automatedTurn, sessionTurn } = ctx;
  const {
    runtimePurpose,
    purposeDefault,
    runtimeDefaults,
    runtimeClaims,
    restoredRuntime,
    checkRuntimeAuth,
    runtimeState,
  } = selected;
  return {
    ...(runtimeState.userProviderKeys ? { providerKeys: runtimeState.userProviderKeys } : {}),
    ...(runtimeState.personalAuth && !purposeDefault && !restoredRuntime && run.runtimeHandoffs === 0
      ? { runtimePinned: true }
      : {}),
    runtimeActorId: actor.id,
    onRuntime: (reported: TurnRuntime) => {
      const runtime: TurnRuntime = runtimeState.agentSwitch
        ? { ...reported, change: { agent: runtimeState.agentSwitch } }
        : reported;
      run.turnRuntime = runtime;
      if (input.runId) deps.turnStream?.noteRuntime(input.runId, runtime);
    },
    ...(runtimePurpose ? { runtimePurpose } : {}),
    ...(deps.runtime && input.runId
      ? {
          runtimeControl: (
            active: RuntimeChoice,
            request: import("../../harness/runtime-types.ts").RuntimeRequest,
            signal?: AbortSignal,
          ) =>
            deps.runtime!(
              sessionTurn && request.lifetime === "scope"
                ? { ...runtimeClaims, liveActor: false, liveAuthor: false }
                : runtimeClaims,
              active,
              request,
              checkRuntimeAuth,
              runtimeState.personalAuth,
              signal,
              automatedTurn && input.surface === "cron",
              runtimePurpose,
              runtimeDefaults,
            ),
        }
      : {}),
  };
}

function segmentCallbacks(
  ctx: TurnCtx,
  turn: Pick<SegmentTurn, "frame" | "ready" | "session" | "run" | "observeSecurityData">,
) {
  const { deps, input, actor, scopeId } = ctx;
  const { screenTrace } = turn.frame;
  const { surfaceName } = turn.frame.framed;
  const { spineFirst, earlyTaskAck } = turn.ready.turnTools;
  const { publishFirstAck } = turn.ready;
  const { session, run, observeSecurityData } = turn;
  const { emittedEntries, gap: gapWork } = run;
  return {
    observeToolResult: ({ tool, result, unscreenable, provenance, source }: ToolResultScreenInput) => {
      if (provenance !== "external" || unscreenable) return;
      const toolLabel = toolLabelOf(tool);
      const sourceLabel = source ? `:${source.replace(/[^A-Za-z0-9_-]/g, "_")}` : "";
      for (const chunk of securityScreenChunks(`tool_result:${toolLabel}${sourceLabel}`, result))
        void observeSecurityData(chunk, actor.id, scopeId, {
          ...screenTrace,
          sessionId: session.id,
          hook: "tool_response",
          request: input.text,
          surface: toolLabel,
          origin: input.origin.kind,
        });
    },
    onDelta: (chunk: string) => {
      if (!run.firstTokenMarked) {
        run.firstTokenMarked = true;
        markFirstToken();
      }
      if (input.runId && deps.turnStream && !input.surfaceTools) deps.turnStream.publish(input.runId, chunk);
      if (input.surfaceTools && spineFirst.open && spineFirst.block.length < FIRST_BLOCK_CAPTURE_MAX_CHARS)
        spineFirst.block += chunk;
    },
    onReasoningDelta: (step: string, index: number, chunk: string) => {
      if (input.runId && deps.turnStream && !input.surfaceTools)
        deps.turnStream.publishReasoning(input.runId, step, index, chunk);
    },
    onToolCallStart: (name: string) => {
      if (!earlyTaskAck || name === surfaceName) return;
      if (input.surfaceTools) publishFirstAck(false);
      else if (input.runId) deps.turnStream?.noteToolCall(input.runId);
    },
    onTextBlockStart: async (phase) => {
      if (input.runId && deps.turnStream && !input.surfaceTools) deps.turnStream.publishBlockStart(input.runId);
      if (input.surfaceTools && spineFirst.block) spineFirst.open = false;
      if (!input.surfaceTools) {
        const streamOffset =
          input.runId && deps.turnStream
            ? deps.turnStream.startOffset(input.runId) + (deps.turnStream.snapshot(input.runId) ?? "").length
            : undefined;
        if (input.runId && deps.runActivity) {
          const started = deps.runActivity.append(input.runId, {
            marker: "text_start",
            seq: emittedEntries.at(-1)?.seq ?? 0,
            createdAt: Date.now(),
            ...(phase ? { phase } : {}),
            ...(streamOffset !== undefined ? { streamOffset } : {}),
          });
          await (phase ? started : started.catch(swallowAs("orchestrator: text-start activity", undefined)));
        }
      }
    },
    onGapWork: (cb) => {
      gapWork.listener = cb;
    },
    recordModelCall: (rec) => {
      deps.modelGateway.recordCall({ at: Date.now(), scopeLabel: scopeId, ...rec });
      void deps.budget?.record(actor.id, estimateCostUsd(rec.inputTokens));
    },
    recordLlmRequest: async (rec, signal) => {
      try {
        await deps.sessions.recordLlmRequest(session.id, { ...rec, scopeLabel: scopeId }, signal);
      } catch (err) {
        reportFailure("orchestrator: persist LLM request snapshot", err);
      }
    },
  } satisfies Partial<HarnessTurnInput>;
}

export async function runSegments(
  ctx: TurnCtx,
  turn: SegmentTurn,
  compactRecent: ReturnType<typeof createCompaction>["compactRecent"],
) {
  const { deps, input, actor, withManagedRosterVersion, resolution, scopeId, filterHistory, strictReadOnly } = ctx;
  const { defaultDestination } = turn.frame.framed;
  const { surfaceToolDeps, spine, spineFirst, postKeys, postProvenance } = turn.ready.turnTools;
  const { inbound, importedOverheard, priorTurns, baseText, turnInput, isPollFire } = turn.ready.prepared;
  const { effectiveTurnWallClockMs, adoptRuntime, runtimeState } = turn.selected;
  const { session, run } = turn;
  const { lease, turnAbort } = turn.held;
  const { historyWindow } = turn.begun;
  const { turnStart } = run;
  const runHarnessSegment = createHarnessSegment(ctx, turn);
  const runHarnessTurn = async (...args: Parameters<typeof runHarnessSegment>) => {
    let segment = await runHarnessSegment(...args);
    while (segment.runtimeHandoff && !segment.stopped && !turnAbort.signal.aborted) {
      if (++run.runtimeHandoffs > 8) throw new NonRetryableTurnError("Too many runtime changes in one task");
      if (effectiveTurnWallClockMs && Date.now() - turnStart >= effectiveTurnWallClockMs)
        throw new NonRetryableTurnError("The task reached its wall-clock limit during runtime handoff");
      const recovery = "context" in segment.runtimeHandoff;
      if ("choice" in segment.runtimeHandoff) {
        await adoptRuntime(segment.runtimeHandoff.choice, segment.runtimeHandoff.lifetime);
      }
      let resumedHistory = filterHistory(forModelContext((await historyWindow()).items));
      if (recovery)
        resumedHistory = await withManagedRosterVersion(() =>
          compactRecent({
            session,
            lease,
            visibleHistory: resumedHistory,
            scopeId,
            orgScopeId: resolution.orgScopeId,
            actorId: actor.id,
            ...(runtimeState.requestedRuntime.modelId ? { model: runtimeState.requestedRuntime.modelId } : {}),
            cancel: turnAbort.signal,
          }),
        );
      run.contextRecovered ||= recovery;
      turnAbort.signal.throwIfAborted();
      segment = await runHarnessSegment(
        runtimeSwitchNote("choice" in segment.runtimeHandoff ? segment.runtimeHandoff.choice : undefined) +
          (recovery && !resumedHistory.some((entry) => isUserMessage(entry) && !!entry.text?.startsWith(baseText))
            ? `\nCurrent request:\n${baseText}`
            : ""),
        inbound.images.length ? { images: inbound.images } : {},
        { history: resumedHistory },
      );
    }
    return {
      ...segment,
      ...(segment.reply ? { reply: absoluteAppLinks(segment.reply, deps.publicWebUrl) } : {}),
    };
  };
  const postToDefault = async (outbound: Outbound, destination: Destination, text: string): Promise<void> => {
    const key = postKeys.key(destination, postKeys.take());
    await reachPost({ outbound, destination, text, idempotencyKey: key, provenance: postProvenance(key) });
    spine.surfaceOutboundCount += 1;
    if (input.runId) deps.turnStream?.markSurfacePosted(input.runId);
  };
  let result = await runHarnessTurn(turnInput, {
    ...(priorTurns?.length ? { priorTurns } : {}),
    ...(importedOverheard.length ? { overheard: importedOverheard } : {}),
    ...(inbound.metas.length ? { attachments: inbound.metas } : {}),
    ...(inbound.images.length ? { images: inbound.images } : {}),
  });
  if (
    input.addressed &&
    !strictReadOnly &&
    input.surfaceTools &&
    surfaceToolDeps &&
    !input.cancel?.aborted &&
    spine.surfaceOutboundCount === 0 &&
    !result.silent &&
    !result.stopped
  ) {
    const primaryReply = stripAckPrefix(result.reply ?? "", spineFirst.ackText).trim();
    if (primaryReply && defaultDestination && deps.outbound) {
      try {
        await postToDefault(deps.outbound, defaultDestination, primaryReply);
      } catch (e) {
        reportFailure("orchestrator: direct reply delivery", e, `session=${session.id}`);
      }
    }
    if (spine.surfaceOutboundCount === 0 && (!isPollFire || primaryReply)) {
      const nudgeHistory = filterHistory(forModelContext((await historyWindow()).items));
      result = await runHarnessTurn(ADDRESSED_NUDGE_MD, inbound.images.length ? { images: inbound.images } : {}, {
        history: nudgeHistory,
      });
      if (spine.surfaceOutboundCount === 0 && !result.silent && !result.stopped) {
        const fallback = stripAckPrefix(result.reply ?? "", spineFirst.ackText).trim();
        if (fallback && defaultDestination && deps.outbound) {
          try {
            await postToDefault(deps.outbound, defaultDestination, fallback);
          } catch (e) {
            reportFailure("orchestrator: shed-reply fallback delivery", e, `session=${session.id}`);
          }
        } else {
          console.error(`[orchestrator] addressed turn ended silent after nudge session=${session.id}`);
        }
      }
    }
  }
  return result;
}
