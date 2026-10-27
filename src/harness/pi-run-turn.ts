import { goalWorkDigest } from "./goal.ts";
import { textFromContent } from "./pi-payload.ts";
import { finishTurn } from "./turn-finish.ts";
import { watchTurnSignals, type TurnStop } from "./turn-signals.ts";
import { createTurnRecovery } from "./turn-recovery.ts";
import { FALLBACK_CODES, piRoundFailed, piTurnError } from "./turn-recovery.ts";
import { createCallTelemetry } from "./call-telemetry.ts";
import {
  recordSteerIntake,
  imageRefs,
  resumeInterruptedToolCall,
  type BridgedTool,
  type SteerIntake,
} from "./harness-shared.ts";
import { type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { isUserMessage } from "../sessions/items.ts";
import { NonRetryableTurnError, ProviderTurnError } from "../core/turn-error.ts";
import { asError, swallow, swallowAs } from "../util/errors.ts";
import { defaultInteractiveThinkingLevel, modelHasPrices } from "../model/pi-models.ts";
import { type HarnessTurnInput, type HarnessTurnResult } from "./harness.ts";
import { dayMarkerPrefix, userPromptText } from "./replay.ts";
import { estimateHistoryTokens } from "./context-compaction.ts";
import { createStepRecorder, recordingTools, type StepRecorder } from "./pi-step-recorder.ts";
import { countTokens } from "../util/tokens.ts";
import { createGrindMeter } from "./grind.ts";
import { createFloorCapPolicy, enforceGoal, goalPausedNote, goalSteeringNote, type GovernorVerdict } from "./goal.ts";
import {
  type TurnWallClockOutcome,
  EMPTY_ENDING_MIN_BUDGET_MS,
  emptyEndingNote,
  raceTurnWallClock,
  wallClockTurnFailure,
} from "./pi-turn-clock.ts";
import { wantsFastMode, withRequestHeaders, applyTurnEffort } from "./pi-model-runtime.ts";
import {
  type TurnSession,
  type PiAgentWithPayloadHook,
  continuableContext,
  continueAssistantTurn,
  removeIsolatedDirs,
  createTurnTools,
  createTurnSession,
} from "./pi-turn-session.ts";
import type { PiModelAccess } from "./pi-model-access.ts";
import type { CoreToolOptions } from "./agent-tools.ts";
import type { ModelGatewayTransportConfig } from "../model/provider-endpoints.ts";
import type { RunSignalStore } from "../runs/run-signal-store.ts";
import { createTurnToolState, type TurnGoal, type TurnHalt, type TurnToolState } from "./turn-tool-state.ts";
import { createModelCallLog, type ModelCallLog } from "./model-call-log.ts";
import { createTurnRequestSettings, type TurnRequestSettings } from "./turn-request.ts";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { GrindMeter } from "./grind.ts";

function piGoalWork(messages: ReadonlyArray<unknown>): string {
  const lines: string[] = [];
  for (const m of messages as ReadonlyArray<{ role?: string; content?: unknown; toolName?: string }>) {
    if (m.role === "toolResult") lines.push(`tool_result ${m.toolName ?? ""}: ${textFromContent(m.content)}`);
    else if (m.role === "user" || m.role === "assistant") {
      const said = textFromContent(m.content);
      if (said) lines.push(`${m.role}: ${said}`);
      for (const c of Array.isArray(m.content) ? m.content : [])
        if ((c as { type?: string }).type === "toolCall")
          lines.push(
            `tool_call ${(c as { name?: string }).name ?? ""}: ${JSON.stringify((c as { arguments?: unknown }).arguments ?? {})}`,
          );
    }
  }
  return goalWorkDigest(lines);
}
interface OpenedPiTurn {
  turn: HarnessTurnInput;
  entry: TurnSession;
  state: TurnToolState;
  request: TurnRequestSettings;
  calls: ModelCallLog;
  desiredModelId: string;
  wantFast: boolean;
  turnModelGateway: ModelGatewayTransportConfig | undefined;
  active: { steps?: StepRecorder };
}

async function openPiTurn(opts: PiTurnOptions, dispatched: HarnessTurnInput): Promise<OpenedPiTurn> {
  const { access } = opts;
  const desiredModelId = dispatched.runtime?.modelId ?? opts.primaryModelId();
  const baseModel = access.model(desiredModelId, !dispatched.providerKeys);
  const turnModelGateway = dispatched.providerKeys ? undefined : access.gateway;
  const wantFast = wantsFastMode(dispatched.runtime?.fastMode, desiredModelId);
  const state = createTurnToolState({
    current: dispatched.tools,
    runtimeActorId: dispatched.runtimeActorId,
    pollFire: !!dispatched.pollFire,
    observeToolResult: dispatched.observeToolResult,
    governGoal: dispatched.governGoal,
    saveGoal: dispatched.saveGoal,
    emit: dispatched.emit,
    scopeLabel: dispatched.scopeLabel,
    toolApprovalGate: dispatched.toolApprovalGate,
    shutdown: dispatched.shutdown,
  });
  const request = createTurnRequestSettings(dispatched.documents);
  const calls = createModelCallLog();
  const active: OpenedPiTurn["active"] = {};
  const tools = recordingTools(createTurnTools(opts.toolOptions, state, dispatched), () => active.steps);
  const resumed = await resumeInterruptedToolCall(dispatched, state, tools as unknown as BridgedTool[]);
  const turn = resumed ? { ...dispatched, history: resumed } : dispatched;
  const entry = await createTurnSession({
    model: withRequestHeaders(baseModel, !turnModelGateway?.models[desiredModelId], wantFast),
    sessionId: turn.session.id,
    systemPrompt: turn.systemPrompt,
    history: turn.history,
    priorTurns: turn.priorTurns,
    providerKeys: async () => turn.providerKeys ?? (await access.providerKeys()),
    modelGateway: turnModelGateway,
    tempDirPrefix: opts.tempDirPrefix,
    captureRequests: opts.captureRequests,
    calls,
    request,
    halt: state.halt,
    abortSignal: () => state.tools.abortSignal,
    tools,
    loadImage: turn.loadImage,
  });
  return { turn, entry, state, request, calls, desiredModelId, wantFast, turnModelGateway, active };
}

async function preparePiPrompt({
  turn,
  entry,
  state,
  request,
  calls,
  desiredModelId,
  wantFast,
}: Omit<OpenedPiTurn, "turnModelGateway" | "active">) {
  const { goal } = state;
  const activeModel = entry.agentSession.model as { id?: string; headers?: Record<string, string> } | undefined;
  request.setFast(wantFast);
  goal.setModelHasPrices(() => !entry.agentSession.model || modelHasPrices(entry.agentSession.model));
  const effectiveModel = activeModel?.id ?? desiredModelId;
  const defaultThinkingLevel = entry.agentSession.model
    ? defaultInteractiveThinkingLevel(entry.agentSession.model)
    : "auto";
  request.setEffortLevel(turn.runtime?.effortLevel ?? defaultThinkingLevel);
  applyTurnEffort(entry.agentSession, request.effortLevel());

  const telemetry = createCallTelemetry(turn, entry.agentSession, calls, request.fast, goal.current);
  const { collectGapWork } = telemetry;
  turn.onGapWork?.(collectGapWork);
  state.reportGapWorkTo(collectGapWork);
  const continued = turn.continueTurn ? continuableContext(entry.agentSession.agent.state.messages) : null;
  if (continued) entry.agentSession.agent.state.messages = continued;
  else if (turn.continueTurn)
    console.log(`[pi] resume has no seeded context to continue; prompting the input session=${turn.session.id}`);
  const continueTurn = !!continued;
  const grindMeter = createGrindMeter();

  goal.set(turn.goal ?? null);
  goal.setMeter(grindMeter);
  goal.setRound(turn.continueTurn ? 1 : 0);
  const startGoal = goal.current();
  const activeGoalAtStart = startGoal?.status === "active" ? startGoal : null;
  const pausedGoalAtStart = startGoal?.status === "paused" ? startGoal : null;
  const goalNote = (() => {
    if (activeGoalAtStart) return goalSteeringNote(activeGoalAtStart);
    if (pausedGoalAtStart) return goalPausedNote(pausedGoalAtStart);
    return "";
  })();
  const userEntry = continueTurn
    ? turn.history.find((e) => e.seq === turn.resumeUserSeq)
    : await turn.emit({
        kind: "UserMessage",
        text: turn.input,
        externalId: turn.triggerTs ?? turn.entryTs ?? null,
        author: turn.runtimeActorId ?? null,
        body: {
          ...(turn.environment ? { environment: turn.environment } : {}),
          ...(goalNote.trim() ? { goalNote } : {}),
          ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
          ...imageRefs(turn.images),
        },
      });
  const modelPrompt =
    (userEntry
      ? dayMarkerPrefix(
          turn.history.findLast((e) => isUserMessage(e) && e.seq < userEntry.seq),
          userEntry,
        )
      : "") + userPromptText({ goalNote, text: turn.input, environment: turn.environment });
  turn.recordModelCall({
    model: effectiveModel,
    inputTokens:
      entry.composedPromptTokens + estimateHistoryTokens(turn.history) + (continueTurn ? 0 : countTokens(modelPrompt)),
    entryCount: turn.history.length,
  });
  return { effectiveModel, telemetry, continueTurn, grindMeter, userEntry, modelPrompt };
}

type TurnPersistence = ReturnType<typeof createTurnPersistence>;

function createTurnPersistence(session: AgentSession, toolAbort: AbortController) {
  let thinkTail: Promise<unknown> = Promise.resolve();
  let persistError: Error | undefined;
  const persist = (write: () => Promise<unknown>): void => {
    thinkTail = thinkTail.then(async () => {
      if (persistError) return;
      try {
        await write();
      } catch (err) {
        persistError = asError(err);
        toolAbort.abort();
        void session.abort().catch(swallowAs("pi: persist-failure abort", undefined));
      }
    });
  };
  const rethrow = (): void => {
    if (persistError) throw persistError;
  };
  const drain = async (): Promise<void> => {
    await thinkTail;
  };
  const settled = async (): Promise<void> => {
    await thinkTail;
    rethrow();
  };
  return { persist, rethrow, drain, settled };
}

function subscribeMessageEnds(opts: {
  turn: HarnessTurnInput;
  session: AgentSession;
  steps: StepRecorder;
  persistence: TurnPersistence;
  pendingSteers: Array<SteerIntake & { prompt: string }>;
  toolAbort: AbortController;
  continueTurn: boolean;
  noteDocumentRejection: (message: unknown) => void;
}): (() => void) | undefined {
  const { turn, session, steps, persistence, pendingSteers, toolAbort, noteDocumentRejection } = opts;
  const { persist } = persistence;
  let triggerSeen = opts.continueTurn;
  const onMessageEnd = async (message: unknown): Promise<void> => {
    const role = (message as { role?: string }).role;
    if (role === "assistant") steps.assistant(message as AssistantMessage);
    else if (role === "toolResult") steps.toolResult(message as ToolResultMessage);
    else if (role === "user" && !triggerSeen) triggerSeen = true;
    else if (role === "user") {
      steps.flush();
      const text = textFromContent((message as { content?: unknown }).content);
      const steerAt = pendingSteers.findIndex((steer) => steer.prompt === text);
      const steer = steerAt >= 0 ? pendingSteers.splice(steerAt, 1)[0]! : undefined;
      persist(() =>
        steer ? recordSteerIntake(turn, steer) : turn.emit({ kind: "Wake", wakeCause: "system", body: { text } }),
      );
    }
    await persistence.settled();
  };
  return (session as unknown as { agent?: PiAgentWithPayloadHook }).agent?.subscribe?.((event) => {
    const e = event as { type?: string; message?: unknown };
    if (e.type === "agent_start" && toolAbort.signal.aborted) session.agent.abort();
    if (e.type === "message_end") noteDocumentRejection(e.message);
    return e.type === "message_end" ? onMessageEnd(e.message) : undefined;
  });
}

type TurnRace = (prompting: Promise<void>, capMs?: number) => Promise<TurnWallClockOutcome>;

async function continueGoal(o: {
  turn: HarnessTurnInput;
  session: AgentSession;
  stop: TurnStop;
  goal: TurnGoal;
  halt: Pick<TurnHalt, "handoff" | "pausedOnApproval" | "approvals" | "setSilent">;
  drain: () => Promise<void>;
  grindMeter: GrindMeter;
  messagesBefore: number;
  wallClock: TurnWallClockOutcome;
  promptRound: (note: string) => Promise<TurnWallClockOutcome>;
}): Promise<TurnWallClockOutcome> {
  const { turn, session, stop, goal, halt, drain, grindMeter, messagesBefore, promptRound } = o;
  let { wallClock } = o;
  const goalAfterPrompt = goal.current();
  if (wallClock === "ok" && goalAfterPrompt && !stop.userAborted && !turn.cancel?.aborted) {
    const governGoal = goal.governor();
    wallClock = await enforceGoal({
      goal: goalAfterPrompt,
      meter: grindMeter,
      outcome: wallClock,
      ok: "ok" as const,
      blocked: () =>
        stop.userAborted ||
        !!turn.cancel?.aborted ||
        !!halt.handoff() ||
        halt.pausedOnApproval() ||
        !!halt.approvals().length ||
        piRoundFailed(session, messagesBefore),
      ...(governGoal
        ? {
            govern: (previous: GovernorVerdict | undefined) =>
              governGoal({
                objective: goalAfterPrompt.objective,
                trigger: "checkpoint",
                recentWork: goal.recentWork(),
                ...(previous ? { previous } : {}),
              }),
          }
        : {}),
      beforePrompt: async () => {
        console.error(`[goal] continuation session=${turn.session.id} round=${goal.round() + 1}`);
        goal.setRound(goal.round() + 1);
        halt.setSilent(false);
        await drain();
      },
      prompt: promptRound,
    });
  }
  return wallClock;
}

async function repromptEmptyEnding(o: {
  turn: HarnessTurnInput;
  session: AgentSession;
  stop: TurnStop;
  halt: Pick<TurnHalt, "halted">;
  calls: Pick<ModelCallLog, "count">;
  drain: () => Promise<void>;
  race: TurnRace;
  wallClock: TurnWallClockOutcome;
  turnWallClockMs: number;
  elapsedMs: number;
  raceCapMs: () => number;
}): Promise<boolean> {
  const { turn, session, stop, halt, calls, drain, race, wallClock, turnWallClockMs, elapsedMs, raceCapMs } = o;
  let recoveryDead = false;
  const note = emptyEndingNote({
    wallClock,
    userAborted: stop.userAborted,
    cancelled: !!turn.cancel?.aborted,
    surfaceTools: !!turn.surfaceTools,
    pollFire: !!turn.pollFire,
    halted: halt.halted(),
    modelCalls: calls.count(),
    session,
    turnWallClockMs,
    elapsedMs,
  });
  if (note) {
    console.error(
      `[pi] empty final response after ${calls.count()} model calls — re-prompting once session=${turn.session.id}`,
    );
    await drain();
    const capMs = raceCapMs();
    if (!stop.userAborted && !turn.cancel?.aborted && (turnWallClockMs <= 0 || capMs >= EMPTY_ENDING_MIN_BUDGET_MS)) {
      try {
        const outcome = await race(session.prompt(note), capMs);
        if (outcome !== "ok" && !stop.userAborted) {
          recoveryDead = true;
        } else if (outcome === "ok" && !stop.userAborted && !(session.getLastAssistantText() ?? "").trim()) {
          console.error(`[pi] turn still ended empty after re-prompt session=${turn.session.id}`);
        }
      } catch (e) {
        swallow("pi: empty-ending re-prompt", e);
        recoveryDead = true;
      }
    }
  }
  return recoveryDead;
}

async function recoverTurnError(
  err: unknown,
  o: {
    turn: HarnessTurnInput;
    session: AgentSession;
    stop: TurnStop;
    rethrowPersistFailure: () => void;
    messagesBefore: number;
    recovery: Pick<ReturnType<typeof createTurnRecovery>, "retryWithoutDocuments" | "attemptRefusalFallback">;
  },
): Promise<void> {
  const { turn, session, stop, rethrowPersistFailure, messagesBefore } = o;
  const { retryWithoutDocuments, attemptRefusalFallback } = o.recovery;
  rethrowPersistFailure();
  const cancelAbortRejection =
    turn.cancel?.aborted === true && (err as { name?: string } | null)?.name === "AbortError";
  if (!stop.userAborted && !cancelAbortRejection) {
    const turnErr = piTurnError(session, err, messagesBefore);
    let recovered = false;
    try {
      recovered = await retryWithoutDocuments();
    } catch (e) {
      swallow("pi: document-free retry", e);
    }
    if (!recovered && turnErr instanceof ProviderTurnError && FALLBACK_CODES.has(turnErr.code)) {
      try {
        recovered = await attemptRefusalFallback(turnErr.message);
      } catch (e) {
        swallow("pi: refusal fallback", e);
      }
    }
    if (!recovered && !stop.userAborted) throw turnErr;
  }
}

export interface PiTurnOptions {
  access: PiModelAccess;
  primaryModelId: () => string;
  toolOptions: CoreToolOptions | undefined;
  tempDirPrefix: string;
  captureRequests: boolean;
  turnWallClockMs: number;
  signals: RunSignalStore | undefined;
  resolveFallbackRuntime: () => { modelId: string; effortLevel?: string; fastMode?: boolean } | undefined;
}

function wallClockLimitError(turnWallClockMs: number, wallClock: TurnWallClockOutcome): NonRetryableTurnError {
  const capLabel =
    turnWallClockMs % 60_000 === 0
      ? `${turnWallClockMs / 60_000}-minute`
      : `${Math.round(turnWallClockMs / 1000)}-second`;
  return new NonRetryableTurnError(
    `the turn hit its ${capLabel} wall-clock limit and was stopped` +
      (wallClock === "abandoned" ? " (a stuck operation did not respond to cancellation)" : ""),
  );
}

function firstPrompt(
  session: AgentSession,
  turn: HarnessTurnInput,
  modelPrompt: string,
  continueTurn: boolean,
): Promise<void> {
  const images = turn.images?.length
    ? turn.images.map((i) => ({ type: "image" as const, data: i.dataBase64, mimeType: i.mimeType }))
    : undefined;
  return continueTurn ? continueAssistantTurn(session) : session.prompt(modelPrompt, images ? { images } : undefined);
}

export async function runPiTurn(opts: PiTurnOptions, dispatched: HarnessTurnInput): Promise<HarnessTurnResult> {
  const { access, signals } = opts;
  const opened = await openPiTurn(opts, dispatched);
  const { turn, entry, state, request, calls, turnModelGateway, active } = opened;
  const session = entry.agentSession;
  const { goal, halt } = state;
  try {
    const turnWallClockMs = turn.turnWallClockMs ?? opts.turnWallClockMs;
    const { effectiveModel, telemetry, continueTurn, grindMeter, userEntry, modelPrompt } =
      await preparePiPrompt(opened);
    const { callStats } = telemetry;
    const toolAbort = new AbortController();
    const pendingSteers: Array<SteerIntake & { prompt: string }> = [];
    const persistence = createTurnPersistence(session, toolAbort);
    const steps = createStepRecorder(turn, persistence.persist);
    active.steps = steps;
    state.routeEmit(steps.emit);
    const unsubscribeMessageEnd = subscribeMessageEnds({
      turn,
      session,
      steps,
      persistence,
      pendingSteers,
      toolAbort,
      continueTurn,
      noteDocumentRejection: (message) => noteDocumentRejection(message),
    });
    const unsubscribe = session.subscribe(telemetry.onSessionEvent(steps, grindMeter));
    let wallClock!: TurnWallClockOutcome;
    const messagesBefore = session.messages.length;
    goal.setRecentWork(() => piGoalWork(session.messages.slice(-80)));
    const stop: TurnStop = { userAborted: false };
    let recoveryDead = false;
    state.bindAbort(toolAbort.signal);
    const { release: releaseSignals } = watchTurnSignals({
      turn,
      session,
      settings: request,
      halt,
      signals,
      toolAbort,
      pendingSteers,
      stop,
    });
    const promptStart = Date.now();
    const floorCap = createFloorCapPolicy({ goal: goal.current, meter: grindMeter, promptStart, turnWallClockMs });
    const rawRemainingCapMs = floorCap.remainingCapMs;
    const raceCapMs = floorCap.raceCapMs;
    const extendCapMs = floorCap.extendMs;
    const race: TurnRace = (prompting, capMs = raceCapMs()) =>
      raceTurnWallClock(prompting, { capMs, extendMs: extendCapMs, abort: () => session.abort() });
    const { noteDocumentRejection, retryWithoutDocuments, attemptRefusalFallback, recoverFailedRound } =
      createTurnRecovery({
        turn,
        session,
        request,
        halt,
        messagesBefore,
        turnWallClockMs,
        raceCapMs,
        race,
        stopped: () => stop.userAborted,
        directModel: (id) => !turnModelGateway?.models[id],
        servedModelId: (id) => (turn.providerKeys ? id : access.servedId(id)),
        resolveFallbackRuntime: opts.resolveFallbackRuntime,
      });
    const promptRound = async (note: string): Promise<TurnWallClockOutcome> => {
      if (turnWallClockMs > 0 && rawRemainingCapMs() < EMPTY_ENDING_MIN_BUDGET_MS) return "aborted";
      const outcome = await race(session.prompt(note));
      if (outcome === "ok") await recoverFailedRound();
      return outcome;
    };
    try {
      wallClock = await race(firstPrompt(session, turn, modelPrompt, continueTurn));
      if (wallClock === "ok") await recoverFailedRound();
      const drain = persistence.drain;
      wallClock = await continueGoal({
        turn,
        session,
        stop,
        goal,
        halt,
        drain,
        grindMeter,
        messagesBefore,
        wallClock,
        promptRound,
      });
      recoveryDead = await repromptEmptyEnding({
        turn,
        session,
        stop,
        halt,
        calls,
        drain,
        race,
        wallClock,
        turnWallClockMs,
        elapsedMs: turnWallClockMs > 0 ? turnWallClockMs - rawRemainingCapMs() : Date.now() - promptStart,
        raceCapMs,
      });
    } catch (err) {
      await recoverTurnError(err, {
        turn,
        session,
        stop,
        rethrowPersistFailure: persistence.rethrow,
        messagesBefore,
        recovery: { retryWithoutDocuments, attemptRefusalFallback },
      });
      wallClock = "ok";
    } finally {
      await releaseSignals();
      if (pendingSteers.length) session.clearQueue();
      unsubscribeMessageEnd?.();
      unsubscribe?.();
      steps.settleResults();
      active.steps = undefined;
      state.routeEmit(turn.emit);
      await persistence.drain();
      await telemetry.drainCaptured(userEntry?.seq ?? null, effectiveModel);
      state.reportGapWorkTo(undefined);
      toolAbort.abort();
      state.bindAbort(undefined);
      state.stopObserving();
    }
    persistence.rethrow();
    if (wallClockTurnFailure(wallClock, stop.userAborted, turn.cancel?.aborted === true))
      throw wallClockLimitError(turnWallClockMs, wallClock);
    return await finishTurn({
      turn,
      session,
      goal,
      halt,
      calls,
      steps,
      grindMeter,
      stop,
      callStats,
      messagesBefore,
      recoveryDead,
      settled: persistence.settled,
    });
  } finally {
    removeIsolatedDirs(entry);
  }
}
