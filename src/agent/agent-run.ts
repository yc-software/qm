import {
  applyFastSpeed,
  buildModelRuntime,
  piUsageToCallUsage,
  wantsFastMode,
  withRequestHeaders,
  type ProviderKeys,
} from "../model/model-runtime.ts";
import {
  recordSteerIntake,
  recordStoppedTurn,
  resumeInterruptedToolCall,
  runApprovedToolCall,
  approvedCallSteerNote,
  deniedCallSteerNote,
  type BridgedTool,
  type SteerIntake,
} from "./turn-support.ts";
import { withDocumentInputs, type DocumentModel } from "./document-inputs.ts";
import { guardOutputBudget, sanitizeLlmPayload, trimPayloadToByteBudget } from "./provider-payload.ts";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  type Api,
  type AssistantMessage,
  type Model,
  type ModelThinkingLevel,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { CONFIG_DEFAULTS, type Config } from "../config.ts";
import type { ConversationTurn, StopScope } from "../types.ts";
import type { Item } from "../sessions/items.ts";
import type { LlmCallUsage } from "../sessions/session-store.ts";
import { NonRetryableTurnError, ProviderTurnError } from "../core/turn-error.ts";
import { TITLE_GENERATION_PROMPT, TITLE_MODEL_ID, sanitizeTitle, titleUserPrompt } from "./session-title-prompt.ts";
import { NEXT_PROMPT_MODEL_ID, NEXT_PROMPT_PROMPT } from "./next-prompt-prompt.ts";
import { providerTurnError } from "../model/provider-error.ts";
import { asError, reportFailure, swallow, swallowAs } from "../util/errors.ts";
import { startPhase } from "../../plugins/chassis/src/error-reporting.ts";
import {
  defaultInteractiveThinkingLevel,
  resolveModel,
  contextTokenBudgetForModel,
  modelHasPrices,
} from "../model/pi-models.ts";
import {
  modelGatewayRequest,
  type ModelGatewayTransportConfig,
  type ModelRequestPurpose,
} from "../model/provider-endpoints.ts";
import { createModelRoutes, routeLabel, type ModelRoute, type ModelRoutes } from "../model/model-route.ts";
import {
  type Agent,
  type CompactInput,
  type DetectInput,
  type DetectResult,
  type TurnLlmRequestRecord,
  type AgentTurnInput,
  type AgentTurnResult,
  REPLY_CHECK_LIMITS,
  replyCheckPrompt,
} from "./agent.ts";
import {
  coreToolOptions,
  createAgentTools,
  endedOnPurpose,
  pauseStampAfterToolCall,
  type ToolContextRef,
} from "./agent-tools.ts";
import { startSignalPoll, type RunSignalStore } from "../runs/run-signal-store.ts";
import {
  reconstructMessagesFromHistory,
  recordedMessageTimestamps,
  seedPriorTurns,
  legacyAssistant,
  type PiReplayMessage,
  type SeededMessage,
} from "./replay.ts";
import { estimateHistoryTokens } from "./context-compaction.ts";
import { createStepRecorder, recordingTools, type StepRecorder } from "./step-recorder.ts";
import { restoreReplayImages, type ReplayImageLoader } from "./replay-images.ts";
import { summarizeHistory } from "./history-summary.ts";
import { countTokens } from "../util/tokens.ts";
import {
  parseSecurityScreenVerdict,
  SECURITY_SCREEN_STEP,
  SECURITY_SCREEN_SYSTEM_PROMPT,
} from "../security/security-posture.ts";
import { errMessage } from "../util/errors.ts";
import type { TurnSession } from "./turn-session.ts";
import { recordCapturedRequests, subscribeTurnStream } from "./turn-stream.ts";
import { settleTurnGoal, turnResult } from "./turn-settle.ts";
import { openTurnPrompt, replayApprovedCalls, turnToolRef } from "./turn-open.ts";
import { applyReasoningMode, applyTurnEffort } from "./turn-effort.ts";
import {
  ACK_EMOJI_PROMPT,
  APPROVAL_SUMMARY_PROMPT,
  buildDetectionPrompt,
  parseDetectVerdict,
  renderDetectPrompt,
} from "./utility-prompts.ts";
import {
  messagesSince,
  piAssistantFailure,
  piGoalWork,
  piLastAssistantTextOrThrow,
  piRoundFailed,
  piTurnError,
  textFromContent,
  type AssistantTextSession,
} from "./pi-messages.ts";
import {
  DOCUMENT_REJECTION_CODES,
  documentsDroppedNote,
  FALLBACK_CODES,
  fallbackFailed,
  refusalFallbackNote,
  routeFailed,
} from "./turn-fallback.ts";
import {
  EMPTY_ENDING_MIN_BUDGET_MS,
  emptyEndingNote,
  raceTurnWallClock,
  wallClockTurnFailure,
  type TurnWallClockOutcome,
} from "./turn-wall-clock.ts";

import { createFloorCapPolicy, createGrindMeter, enforceGoal, type GovernorVerdict } from "./goal.ts";

export interface AgentOptions {
  routes?: ModelRoutes;
  detectModelId?: string;
  titleModelId?: string;
  judgeModelId?: string;
  tempDirPrefix?: string;
  captureRequests?: boolean;
  controlTools?: boolean;
  sandboxResources?: boolean;
  memorySizedBackends?: string[];
  turnWallClockMs?: number;
  execTimeoutMs?: number;
  execTimeoutCeilingMs?: number;
  backgroundJobTtlMs?: number;
  backgroundJobTtlMaxMs?: number;
  signals?: RunSignalStore;
}

export function agentConfigOptions(config: Config): AgentOptions {
  return {
    ...(config.detectModelId ? { detectModelId: config.detectModelId } : {}),
    ...(config.titleModelId ? { titleModelId: config.titleModelId } : {}),
    ...(config.judgeModelId ? { judgeModelId: config.judgeModelId } : {}),
    captureRequests: config.captureLlmRequests,
    ...coreToolOptions(config),
    turnWallClockMs: config.turnWallClockMs,
  };
}

interface IsolatedResources {
  resourceLoader: DefaultResourceLoader;
  settingsManager: SettingsManager;
  cwd: string;
  agentDir: string;
  ephemeralCwd?: string;
}

export function continuableContext<M extends { role?: unknown }>(messages: readonly M[]): M[] | null {
  let end = messages.length;
  while (messages[end - 1]?.role === "assistant") end--;
  const role = messages[end - 1]?.role;
  return role === "user" || role === "toolResult" ? messages.slice(0, end) : null;
}

function continueAssistantTurn(session: AgentSession): Promise<void> {
  return (session as unknown as { _runAgentPrompt(messages: readonly unknown[]): Promise<void> })._runAgentPrompt([]);
}

interface PiSeedTarget {
  agent?: { state?: { messages?: unknown[] } };
  sessionManager?: { appendMessage?: (message: unknown) => unknown };
}

export function toPiMessage(m: SeededMessage): PiReplayMessage {
  return m.role === "assistant"
    ? legacyAssistant([{ type: "text", text: m.text }], Date.now())
    : { role: "user", content: [{ type: "text", text: m.text }], timestamp: Date.now() };
}

export function seedRawMessagesIntoSession(session: unknown, messages: readonly PiReplayMessage[]): void {
  if (!messages.length) return;
  const target = session as PiSeedTarget;
  const liveMessages = target.agent?.state?.messages;
  const appendMessage = target.sessionManager?.appendMessage?.bind(target.sessionManager);
  for (const message of messages) {
    if (Array.isArray(liveMessages)) liveMessages.push(message);
    if (appendMessage) {
      try {
        appendMessage(message);
      } catch (e) {
        swallow("pi: replay message append", e);
      }
    }
  }
}

const DOCUMENTS_DROPPED_RETRY_NOTE =
  "[system] The previous request failed while it carried inline attachments; they have been replaced with notes on how to read them from saved files. Continue with the request.";

function dropFailedAssistant(session: AgentSession, messagesBefore: number): void {
  const state = session.agent.state;
  for (let i = state.messages.length - 1; i >= messagesBefore; i--) {
    const m = state.messages[i] as { role?: string; stopReason?: string } | undefined;
    if (m?.role === "assistant" && m.stopReason === "error") {
      state.messages = [...state.messages.slice(0, i), ...state.messages.slice(i + 1)];
      break;
    }
  }
}

export function stableCwd(prefix: string): string {
  return join(tmpdir(), `${prefix}-cwd`);
}

async function createIsolatedResources(prefix: string, systemPrompt: string): Promise<IsolatedResources> {
  let cwd = stableCwd(prefix);
  let ephemeralCwd: string | undefined;
  try {
    mkdirSync(cwd, { recursive: true });
    if (!statSync(cwd).isDirectory()) throw new Error(`${cwd} is not a directory`);
  } catch (e) {
    swallow("pi: shared cwd unavailable; using a per-turn cwd (prompt cache prefix changes)", e);
    cwd = mkdtempSync(join(tmpdir(), `${prefix}-cwd-`));
    ephemeralCwd = cwd;
  }
  const agentDir = mkdtempSync(join(tmpdir(), `${prefix}-agent-`));
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    systemPrompt,
    appendSystemPrompt: [],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  return { resourceLoader, settingsManager, cwd, agentDir, ...(ephemeralCwd ? { ephemeralCwd } : {}) };
}

function removeIsolatedDirs(dirs: { agentDir: string; ephemeralCwd?: string }): void {
  for (const dir of [dirs.agentDir, dirs.ephemeralCwd]) {
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      swallow("pi: temp dir cleanup", e);
    }
  }
}

export async function oneShot(
  prefix: string,
  model: Model<Api>,
  keys: ProviderKeys | string,
  systemPrompt: string,
  prompt: string,
  opts?: {
    signal?: AbortSignal;
    modelGateway?: ModelGatewayTransportConfig;
    purpose?: ModelRequestPurpose;
    thinkingLevel?: ModelThinkingLevel;
    recordLlmRequest?: (rec: TurnLlmRequestRecord) => void | Promise<void>;
  },
): Promise<string | undefined> {
  const modelRuntime = await buildModelRuntime(keys, opts?.modelGateway, opts?.purpose);
  const { resourceLoader, settingsManager, cwd, agentDir, ephemeralCwd } = await createIsolatedResources(
    prefix,
    systemPrompt,
  );
  try {
    const { session } = await createAgentSession({
      model,
      modelRuntime,
      resourceLoader,
      settingsManager,
      customTools: [],
      noTools: "builtin",
      sessionManager: SessionManager.inMemory(),
      ...(opts?.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
      cwd,
      agentDir,
    });
    const messagesBefore = session.messages.length;
    if (opts?.signal?.aborted) return undefined;
    const onAbort = () => {
      void session.abort().catch(() => undefined);
    };
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    let recorded: Promise<void> = Promise.resolve();
    let step = 0;
    const unsubscribe = session.agent.subscribe((event) => {
      if (event.type === "agent_start" && opts?.signal?.aborted) session.agent.abort();
      if (event.type === "message_end" && event.message.role === "assistant" && opts?.recordLlmRequest) {
        const record = opts.recordLlmRequest;
        const call = event.message;
        const at = step++;
        recorded = recorded.then(() => recordOneShotCall(record, call, at, model));
      }
    });
    try {
      await session.prompt(prompt);
    } catch (err) {
      throw piTurnError(session, err, messagesBefore);
    } finally {
      unsubscribe();
      opts?.signal?.removeEventListener("abort", onAbort);
      await recorded;
    }
    return piLastAssistantTextOrThrow(session);
  } finally {
    removeIsolatedDirs({ agentDir, ephemeralCwd });
  }
}

async function recordOneShotCall(
  record: (rec: TurnLlmRequestRecord) => void | Promise<void>,
  call: AssistantMessage,
  step: number,
  model: Model<Api>,
): Promise<void> {
  try {
    await record({
      turnSeq: null,
      step,
      model: model.id,
      truncated: false,
      usage: piUsageToCallUsage(call.usage, model, false, (call as { serviceTier?: string }).serviceTier),
    });
  } catch (e) {
    swallow("pi: one-shot request record", e);
  }
}

export function createAgent(opts?: AgentOptions): Agent {
  const routes = opts?.routes ?? createModelRoutes();
  const baseModelId = routes.baseModelId;
  const servable = routes.servable;
  const sessionRoute = routes.session;
  const utilityRoute = routes.utility;
  const fallbackRoute = routes.fallback;
  const tempDirPrefix = opts?.tempDirPrefix ?? "pi";
  const captureRequests = opts?.captureRequests ?? true;
  const controlTools = opts?.controlTools ?? false;
  const defaultTurnWallClockMs = opts?.turnWallClockMs ?? CONFIG_DEFAULTS.turnWallClockSec * 1000;
  const signals = opts?.signals;
  function createTurnTools(ref: ToolContextRef, turn: AgentTurnInput): ToolDefinition[] {
    return createAgentTools(ref, {
      sessionTools: Boolean(turn.tools.sessionSyscalls),
      delegateWork: turn.delegateWork === true,
      ...(turn.mcpTools?.length ? { mcpTools: turn.mcpTools } : {}),
      controlTools,
      ...(turn.surfaceTools ? { surfaceTools: true } : {}),
      ...(turn.surfaceName ? { surfaceName: turn.surfaceName } : {}),
      ...(turn.surfacePrompt ? { surfacePrompt: turn.surfacePrompt } : {}),
      ...(turn.clientTools?.length ? { clientTools: turn.clientTools } : {}),
      ...(turn.readOnly ? { readOnly: true } : {}),
      ...(turn.botActor ? { botActor: true } : {}),
      ...(turn.memoryNotebookOnly ? { memoryNotebookOnly: true } : {}),
      ...(opts?.execTimeoutMs !== undefined ? { execTimeoutMs: opts.execTimeoutMs } : {}),
      ...(opts?.execTimeoutCeilingMs !== undefined ? { execTimeoutCeilingMs: opts.execTimeoutCeilingMs } : {}),
      ...(opts?.backgroundJobTtlMs !== undefined ? { backgroundJobTtlMs: opts.backgroundJobTtlMs } : {}),
      ...(opts?.backgroundJobTtlMaxMs !== undefined ? { backgroundJobTtlMaxMs: opts.backgroundJobTtlMaxMs } : {}),
      sandboxResources: opts?.sandboxResources,
      ...(opts?.memorySizedBackends?.length ? { memorySizedBackends: opts.memorySizedBackends } : {}),
    });
  }
  async function createTurnSession(
    model: Model<Api>,
    sessionId: string,
    systemPrompt: string,
    history: Item[],
    priorTurns: ConversationTurn[] | undefined,
    route: ModelRoute,
    ref: TurnSession["ref"],
    tools: ToolDefinition[],
    loadImage: ReplayImageLoader | undefined,
  ): Promise<{ entry: TurnSession }> {
    const reconstructed = await restoreReplayImages(reconstructMessagesFromHistory(history), loadImage);

    const modelRuntime = await buildModelRuntime(route.keys, route.gateway, "turn", "long");
    const { resourceLoader, settingsManager, cwd, agentDir, ephemeralCwd } = await createIsolatedResources(
      tempDirPrefix,
      systemPrompt,
    );

    let session: AgentSession;
    try {
      ({ session } = await createAgentSession({
        model,
        modelRuntime,
        resourceLoader,
        settingsManager,
        customTools: tools,
        noTools: "builtin",
        sessionManager: SessionManager.inMemory(undefined, { id: sessionId }),
        cwd,
        agentDir,
      }));
    } catch (err) {
      removeIsolatedDirs({ agentDir, ephemeralCwd });
      throw err;
    }

    if (reconstructed.length) {
      try {
        seedRawMessagesIntoSession(session, reconstructed);
      } catch (err) {
        console.error("[agent] failed to seed reconstructed history (continuing without it):", errMessage(err));
      }
    } else if (priorTurns?.length) {
      try {
        seedRawMessagesIntoSession(session, seedPriorTurns(priorTurns, []).map(toPiMessage));
      } catch (err) {
        console.error("[agent] failed to seed prior turns (continuing without them):", errMessage(err));
      }
    }

    session.agent.onPayload = async (payload, model) => {
      ref.modelCalls = (ref.modelCalls ?? 0) + 1;
      ref.onModelRequest?.();
      ref.stepPhase?.end();
      ref.stepPhase = undefined;
      ref.firstTokenPhase?.end();
      ref.firstTokenPhase = startPhase("model.first_token");
      applyFastSpeed(payload, ref.fast, (model as { api?: string } | undefined)?.api);
      applyReasoningMode(payload, model as Model<Api>, ref.effortLevel);
      const capturedPayload = ref.llmCapture ? sanitizeLlmPayload(payload, model) : undefined;
      let finalPayload = await withDocumentInputs(
        payload,
        model as DocumentModel,
        ref.documents ?? [],
        ref.abortSignal,
        ref.documentsStubbed ? documentsDroppedNote(ref.documents ?? []) : undefined,
      );
      const guarded = guardOutputBudget(finalPayload, model);
      if (guarded.kind === "raised") {
        console.error(
          `[pi] output-budget guard raised output cap ${guarded.from} -> ${guarded.to} (estimated prompt ${guarded.estimatedPromptTokens} tokens) session=${sessionId}`,
        );
      }
      try {
        const gateway = modelGatewayRequest(route.gateway, model as Model<Api>);
        finalPayload = trimPayloadToByteBudget(finalPayload, gateway ? 9_000_000 : undefined);
      } catch (e) {
        swallow("pi: request byte budget", e);
      }
      if (capturedPayload) ref.llmCapture?.push(capturedPayload);
      return finalPayload;
    };
    session.agent.afterToolCall = pauseStampAfterToolCall(ref);

    const entry: TurnSession = {
      agentSession: session,
      ref,
      composedPromptTokens: countTokens(systemPrompt),
      agentDir,
      ...(ephemeralCwd ? { ephemeralCwd } : {}),
    };
    return { entry };
  }

  const agent: Agent = {
    async runTurn(dispatched: AgentTurnInput): Promise<AgentTurnResult> {
      const route = await sessionRoute(dispatched);
      const desiredModelId = route.modelId;
      const wantFast = wantsFastMode(dispatched.runtime?.fastMode, desiredModelId);
      const ref = turnToolRef(dispatched);
      let activeSteps: StepRecorder | undefined;
      const tools = recordingTools(createTurnTools(ref, dispatched), () => activeSteps);
      const approvedTurn = await replayApprovedCalls(dispatched, ref, tools);
      const resumed = await resumeInterruptedToolCall(approvedTurn, ref, tools as unknown as BridgedTool[]);
      const turn = resumed ? { ...approvedTurn, history: resumed.history } : approvedTurn;
      const { entry } = await createTurnSession(
        withRequestHeaders(route.model, route.billing !== "model_gateway", wantFast),
        turn.session.id,
        turn.systemPrompt,
        turn.history,
        turn.priorTurns,
        route,
        ref,
        tools,
        turn.loadImage,
      );
      try {
        const turnWallClockMs = turn.turnWallClockMs ?? defaultTurnWallClockMs;

        const activeModel = entry.agentSession.model as { id?: string; headers?: Record<string, string> } | undefined;
        entry.ref.fast = wantFast;
        entry.ref.modelHasPrices = () => !entry.agentSession.model || modelHasPrices(entry.agentSession.model);
        const effectiveModel = activeModel?.id ?? desiredModelId;
        const defaultThinkingLevel = entry.agentSession.model
          ? defaultInteractiveThinkingLevel(entry.agentSession.model)
          : "auto";
        entry.ref.effortLevel = turn.runtime?.effortLevel ?? defaultThinkingLevel;
        applyTurnEffort(entry.agentSession, entry.ref.effortLevel);

        const continued = turn.continueTurn ? continuableContext(entry.agentSession.agent.state.messages) : null;
        if (continued) entry.agentSession.agent.state.messages = continued;
        else if (turn.continueTurn)
          console.log(`[pi] resume has no seeded context to continue; prompting the input session=${turn.session.id}`);
        const continueTurn = !!continued;
        const grindMeter = createGrindMeter();

        const { userEntry, modelPrompt } = await openTurnPrompt({ entry, turn, continueTurn, grindMeter });
        entry.ref.llmCapture = captureRequests && turn.recordLlmRequest ? [] : undefined;
        entry.ref.modelCalls = 0;
        entry.ref.onModelRequest = () => {
          turn.onModelRequest?.();
          if (turn.park?.requested()) turn.park.now();
        };
        turn.recordModelCall({
          model: effectiveModel,
          inputTokens:
            entry.composedPromptTokens +
            estimateHistoryTokens(turn.history) +
            (continueTurn ? 0 : countTokens(modelPrompt)),
          entryCount: turn.history.length,
        });

        const callUsage: Array<LlmCallUsage | null> = [];
        let thinkTail: Promise<unknown> = Promise.resolve();
        let triggerSeen = continueTurn;
        const toolAbort = new AbortController();
        let steerWake = new AbortController();
        entry.ref.steered = steerWake.signal;
        const pendingSteers: Array<SteerIntake & { prompt: string }> = [];
        const unrecordedPrompts = new Set<string>();
        const retractedMessages = new Set<unknown>();
        const checked = { retry: [] as string[], prod: [] as string[] };
        const approvalSteers = new Map<string, string>();
        let persistError: Error | undefined;
        const persist = (write: () => Promise<unknown>): void => {
          thinkTail = thinkTail.then(async () => {
            if (persistError) return;
            try {
              await write();
            } catch (err) {
              persistError = asError(err);
              toolAbort.abort();
              void entry.agentSession.abort().catch(swallowAs("pi: persist-failure abort", undefined));
            }
          });
        };
        const steps = createStepRecorder(turn, persist);
        activeSteps = steps;
        entry.ref.emit = steps.emit;
        const onMessageEnd = async (message: unknown): Promise<void> => {
          const role = (message as { role?: string }).role;
          if (role === "assistant") steps.assistant(message as AssistantMessage);
          else if (role === "toolResult") steps.toolResult(message as ToolResultMessage);
          else if (role === "user" && !triggerSeen) triggerSeen = true;
          else if (role === "user") {
            steps.flush();
            const text = textFromContent((message as { content?: unknown }).content);
            if (unrecordedPrompts.delete(text)) return;
            const steerAt = pendingSteers.findIndex((steer) => steer.prompt === text);
            const steer = steerAt >= 0 ? pendingSteers.splice(steerAt, 1)[0]! : undefined;
            if (steerWake.signal.aborted && !entry.agentSession.agent.hasQueuedMessages()) {
              steerWake = new AbortController();
              entry.ref.steered = steerWake.signal;
            }
            const recorded = approvalSteers.get(text) ?? text;
            approvalSteers.delete(text);
            persist(() =>
              steer
                ? recordSteerIntake(turn, steer)
                : turn.emit({ kind: "Wake", wakeCause: "system", body: { text: recorded } }),
            );
          }
          await thinkTail;
          if (persistError) throw persistError;
        };
        const unsubscribeMessageEnd = entry.agentSession.agent.subscribe((event) => {
          const e = event as { type?: string; message?: unknown };
          if (e.type === "agent_start" && toolAbort.signal.aborted) entry.agentSession.agent.abort();
          if (e.type === "message_end") noteDocumentRejection(e.message);
          return e.type === "message_end" ? onMessageEnd(e.message) : undefined;
        });
        const unsubscribe = subscribeTurnStream({ entry, steps, turn, grindMeter, callUsage });
        let wallClock!: TurnWallClockOutcome;
        const messagesBefore = entry.agentSession.messages.length;
        entry.ref.goalRecentWork = () => piGoalWork(entry.agentSession.messages.slice(-80));
        const freshAssistantStopReason = (): string | undefined => {
          const fresh = entry.agentSession.messages.slice(messagesBefore);
          const last = [...fresh].reverse().find((m) => (m as { role?: string }).role === "assistant") as
            { stopReason?: string } | undefined;
          return last?.stopReason;
        };
        let userAborted = false;
        let abortReason: string | undefined;
        let abortScope: StopScope | undefined;
        let recoveryDead = false;
        entry.ref.abortSignal = toolAbort.signal;
        const onCancel = (): void => {
          toolAbort.abort();
          entry.agentSession.clearQueue();
          void entry.agentSession.abort().catch(swallowAs("pi: lease-lost abort", undefined));
        };
        if (turn.cancel) {
          if (turn.cancel.aborted) onCancel();
          else turn.cancel.addEventListener("abort", onCancel, { once: true });
        }
        const steeredSeen = recordedMessageTimestamps(turn.history);
        let liveApprovalTail: Promise<void> = Promise.resolve();
        const stopSignalPoll =
          signals && turn.runId
            ? startSignalPoll(
                signals,
                turn.runId,
                {
                  onSteer: async (text, ts, request, acknowledge) => {
                    if (request?.approval) {
                      if (!turn.resolveSteeredApproval) return false;
                      if (!entry.agentSession.isStreaming || toolAbort.signal.aborted) return false;
                      const decided = await turn.resolveSteeredApproval(request);
                      if (decided.kind === "ignored") return;
                      const settled = liveApprovalTail
                        .then(async () => {
                          const ran =
                            decided.kind === "run"
                              ? await runApprovedToolCall(decided.call, entry.ref, tools as unknown as BridgedTool[], {
                                  cancel: toolAbort.signal,
                                })
                              : null;
                          const note = (withResult: boolean) =>
                            decided.kind === "run" && ran
                              ? approvedCallSteerNote(decided, ran, withResult)
                              : deniedCallSteerNote(decided);
                          if (entry.agentSession.isStreaming) {
                            approvalSteers.set(note(true), note(false));
                            await entry.agentSession.steer(note(true));
                            steerWake.abort();
                          } else await entry.ref.emit?.({ kind: "UserMessage", hidden: true, text: note(false) });
                        })
                        .catch((error: unknown) => reportFailure("pi: live approval outcome", error, decided.kind));
                      liveApprovalTail = settled;
                      return;
                    }
                    if (ts && steeredSeen.has(ts)) return;
                    if (!entry.agentSession.isStreaming || toolAbort.signal.aborted) return false;
                    const prepared = await turn.prepareSteer?.(text, request);
                    const prompt = prepared?.text ?? text;
                    if (!entry.agentSession.isStreaming || toolAbort.signal.aborted) return false;
                    const steer = {
                      text,
                      prompt,
                      ts,
                      attachments: prepared?.attachments,
                      images: prepared?.images,
                      author: prepared?.author,
                      authorName: prepared?.authorName,
                      withheld: prepared?.withheld,
                      acknowledge,
                    };
                    pendingSteers.push(steer);
                    if (ts) steeredSeen.add(ts);
                    if (prepared?.documents?.length)
                      entry.ref.documents = [...(entry.ref.documents ?? []), ...prepared.documents];
                    entry.ref.silentRequested = false;
                    try {
                      await entry.agentSession.steer(
                        prompt,
                        prepared?.images?.map((image) => ({
                          type: "image" as const,
                          mimeType: image.mimeType,
                          data: image.dataBase64,
                        })),
                      );
                      steerWake.abort();
                    } catch (error) {
                      const at = pendingSteers.indexOf(steer);
                      if (at >= 0) pendingSteers.splice(at, 1);
                      if (ts) steeredSeen.delete(ts);
                      throw error;
                    }
                    return false;
                  },
                  onAbort: async ({ reason, scope }) => {
                    userAborted = true;
                    abortReason ??= reason;
                    abortScope ??= scope;
                    toolAbort.abort();
                    entry.agentSession.clearQueue();
                    await entry.agentSession.abort();
                  },
                },
                { onError: (e) => swallow("pi: run signal poll", e) },
              )
            : null;
        const promptStart = Date.now();
        const floorCap = createFloorCapPolicy({
          goal: () => entry.ref.goal,
          meter: grindMeter,
          promptStart,
          turnWallClockMs,
        });
        const raceCapMs = floorCap.raceCapMs;
        const roomToReprompt = () => turnWallClockMs <= 0 || raceCapMs() >= EMPTY_ENDING_MIN_BUDGET_MS;
        const reprompt = (note: string) =>
          raceTurnWallClock(entry.agentSession.prompt(note), {
            capMs: raceCapMs(),
            extendMs: floorCap.extendMs,
            abort: () => entry.agentSession.abort(),
          });
        const refusedModelIds = new Set<string>();
        let fallbackFailure: ProviderTurnError | undefined;
        const attemptRefusalFallback = async (failure: ProviderTurnError): Promise<boolean> => {
          if (userAborted || turn.cancel?.aborted) return false;
          const fromId = (entry.agentSession.model as { id?: string } | undefined)?.id;
          if (!fromId) return false;
          refusedModelIds.add(fromId);
          const fallback = await fallbackRoute(refusedModelIds, turn.providerKeys);
          if (!fallback || !roomToReprompt()) return false;
          console.error(
            `[pi] provider ${failure.code} — retrying on fallback model ${fromId} -> ${fallback.modelId} session=${turn.session.id}: ${failure.message}`,
          );
          try {
            const wantFast = wantsFastMode(fallback.runtime.fastMode ?? turn.runtime?.fastMode, fallback.modelId);
            await entry.agentSession.setModel(
              withRequestHeaders(fallback.model, fallback.billing !== "model_gateway", wantFast),
            );
            entry.ref.fast = wantFast;
            entry.ref.effortLevel =
              fallback.runtime.effortLevel ??
              turn.runtime?.effortLevel ??
              defaultInteractiveThinkingLevel(fallback.model);
            applyTurnEffort(entry.agentSession, entry.ref.effortLevel);
            dropFailedAssistant(entry.agentSession, messagesBefore);
            const outcome = await reprompt(
              refusalFallbackNote(routeLabel(route), routeLabel(fallback), failure.message),
            );
            if (userAborted) return false;
            if (outcome !== "ok") throw new Error(`the retry ended ${outcome}`);
            const failed = piAssistantFailure(messagesSince(entry.agentSession, messagesBefore));
            if (failed) throw failed;
            return true;
          } catch (e) {
            if (userAborted || turn.cancel?.aborted) return false;
            fallbackFailure = fallbackFailed(failure, fallback, errMessage(e));
            throw fallbackFailure;
          }
        };
        let documentRejection: ProviderTurnError | undefined;
        let documentRetried = false;
        const noteDocumentRejection = (message: unknown): void => {
          if (documentRejection || !entry.ref.documents?.length) return;
          const failed = message as AssistantMessage | undefined;
          if (failed?.role !== "assistant" || failed.stopReason !== "error") return;
          const failure = piAssistantFailure({ messages: [failed] } as unknown as AssistantTextSession);
          if (!failure || !DOCUMENT_REJECTION_CODES.has(failure.code)) return;
          documentRejection = failure;
          entry.ref.documentsStubbed = true;
          console.error(
            `[pi] request with ${entry.ref.documents.length} inline document(s) rejected (${failure.code}: ${failure.raw || failure.message}) — replacing them with stubs session=${turn.session.id}`,
          );
        };
        const retryWithoutDocuments = async (): Promise<boolean> => {
          if (!documentRejection || documentRetried || userAborted || turn.cancel?.aborted) return false;
          const lastAssistant = entry.agentSession.messages
            .slice(messagesBefore)
            .findLast((m) => (m as { role?: string }).role === "assistant") as AssistantMessage | undefined;
          if (lastAssistant && lastAssistant.stopReason !== "error") return false;
          if (!roomToReprompt()) return false;
          documentRetried = true;
          dropFailedAssistant(entry.agentSession, messagesBefore);
          const outcome = await reprompt(DOCUMENTS_DROPPED_RETRY_NOTE);
          if (userAborted) return false;
          if (outcome !== "ok")
            throw new NonRetryableTurnError(
              `${documentRejection.message} (retry without inline documents was ${outcome})`,
            );
          return true;
        };
        const recoverFailedRound = async (thrown?: Error): Promise<boolean> => {
          const retried = await retryWithoutDocuments();
          const failure =
            (retried ? null : thrown) ?? piAssistantFailure(messagesSince(entry.agentSession, messagesBefore));
          if (!(failure instanceof ProviderTurnError && FALLBACK_CODES.has(failure.code))) return retried;
          return attemptRefusalFallback(failure);
        };
        try {
          const images = turn.images?.length
            ? turn.images.map((i) => ({ type: "image" as const, data: i.dataBase64, mimeType: i.mimeType }))
            : undefined;
          wallClock = await raceTurnWallClock(
            continueTurn
              ? continueAssistantTurn(entry.agentSession)
              : entry.agentSession.prompt(modelPrompt, images ? { images } : undefined),
            {
              capMs: raceCapMs(),
              extendMs: floorCap.extendMs,
              abort: () => entry.agentSession.abort(),
            },
          );
          if (wallClock === "ok" && !entry.ref.runtimeHandoff) await recoverFailedRound();
          const goalAfterPrompt = entry.ref.goal;
          if (wallClock === "ok" && goalAfterPrompt && !userAborted && !turn.cancel?.aborted) {
            await enforceGoal({
              goal: goalAfterPrompt,
              meter: grindMeter,
              blocked: () =>
                userAborted ||
                !!turn.cancel?.aborted ||
                !!entry.ref.runtimeHandoff ||
                !!entry.ref.pausedOnApproval ||
                !!entry.ref.pendingApprovals?.length ||
                piRoundFailed(entry.agentSession, messagesBefore),
              ...(entry.ref.governGoal
                ? {
                    govern: (previous: GovernorVerdict | undefined) =>
                      entry.ref.governGoal!({
                        objective: goalAfterPrompt.objective,
                        trigger: "checkpoint",
                        recentWork: entry.ref.goalRecentWork?.() ?? "",
                        ...(previous ? { previous } : {}),
                      }),
                  }
                : {}),
              ...(turn.goalInbox ? { inbox: turn.goalInbox } : {}),
              prompt: async (note) => {
                console.error(`[goal] continuation session=${turn.session.id} round=${(entry.ref.goalRound ?? 0) + 1}`);
                entry.ref.goalRound = (entry.ref.goalRound ?? 0) + 1;
                entry.ref.silentRequested = false;
                await thinkTail;
                wallClock = roomToReprompt() ? await reprompt(note) : "aborted";
                if (wallClock === "ok" && !entry.ref.runtimeHandoff) await recoverFailedRound();
                return wallClock === "ok";
              },
            });
          }
          const note = emptyEndingNote({
            wallClock,
            userAborted,
            cancelled: !!turn.cancel?.aborted,
            surfaceTools: !!turn.surfaceTools,
            replyOptional: !!turn.replyOptional,
            ref: entry.ref,
            session: entry.agentSession,
            turnWallClockMs,
            elapsedMs: turnWallClockMs > 0 ? turnWallClockMs - floorCap.remainingCapMs() : Date.now() - promptStart,
          });
          if (note) {
            console.error(
              `[pi] empty final response after ${entry.ref.modelCalls} model calls — re-prompting once session=${turn.session.id}`,
            );
            await thinkTail;
            if (!userAborted && !turn.cancel?.aborted && roomToReprompt()) {
              try {
                const outcome = await reprompt(note);
                if (outcome !== "ok" && !userAborted) {
                  recoveryDead = true;
                } else if (
                  outcome === "ok" &&
                  !userAborted &&
                  !(entry.agentSession.getLastAssistantText() ?? "").trim()
                ) {
                  console.error(`[pi] turn still ended empty after re-prompt session=${turn.session.id}`);
                }
              } catch (e) {
                swallow("pi: empty-ending re-prompt", e);
                recoveryDead = true;
              }
            }
          }
          const checkable = () =>
            wallClock === "ok" &&
            !userAborted &&
            !turn.cancel?.aborted &&
            !recoveryDead &&
            !entry.ref.silentRequested &&
            !entry.ref.runtimeHandoff &&
            !entry.ref.pausedOnApproval &&
            !entry.ref.pendingApprovals?.length &&
            !endedOnPurpose(entry.ref) &&
            roomToReprompt();
          while (turn.checkReply && checkable()) {
            const draft = (entry.agentSession.getLastAssistantText() ?? "").trim();
            if (!draft) break;
            const verdict = await turn.checkReply(draft).catch(swallowAs("pi: reply check", undefined));
            if (!verdict || checked[verdict.action].length >= REPLY_CHECK_LIMITS[verdict.action] || !checkable()) break;
            if (
              verdict.action === "prod" &&
              !(await Promise.resolve(turn.onInterimReply?.(draft) ?? false).catch(
                swallowAs("pi: interim reply", false),
              ))
            )
              break;
            checked[verdict.action].push(verdict.reason);
            console.error(
              `[pi] reply check ${verdict.action === "prod" ? "prodded" : "retracted"} the reply session=${turn.session.id} reason=${verdict.reason} round=${checked.retry.length + checked.prod.length}`,
            );
            steps.mark(verdict);
            await thinkTail;
            if (persistError) throw persistError;
            await turn.onTextBlockStart?.();
            const prompt = replyCheckPrompt(verdict);
            const before = entry.agentSession.agent.state.messages.length;
            if (verdict.action === "retry") unrecordedPrompts.add(prompt);
            wallClock = await reprompt(prompt);
            if (verdict.action === "retry")
              for (const m of entry.agentSession.agent.state.messages.slice(before - 1, before + 1))
                retractedMessages.add(m);
            if (wallClock === "ok" && !entry.ref.runtimeHandoff) await recoverFailedRound();
          }
          if (retractedMessages.size)
            entry.agentSession.agent.state.messages = entry.agentSession.agent.state.messages.filter(
              (m) => !retractedMessages.has(m),
            );
        } catch (err) {
          if (persistError) throw persistError;
          if (fallbackFailure) throw fallbackFailure;
          const cancelAbortRejection =
            turn.cancel?.aborted === true && (err as { name?: string } | null)?.name === "AbortError";
          if (!userAborted && !cancelAbortRejection) {
            const turnErr = piTurnError(entry.agentSession, err, messagesBefore);
            const recovered = await recoverFailedRound(turnErr).catch(swallowAs("pi: failed-round recovery", false));
            if (fallbackFailure) throw fallbackFailure;
            if (!recovered && !userAborted) throw turnErr;
          }
          wallClock = "ok";
        } finally {
          turn.cancel?.removeEventListener("abort", onCancel);
          await stopSignalPoll?.();
          await liveApprovalTail;
          if (pendingSteers.length) entry.agentSession.clearQueue();
          unsubscribeMessageEnd?.();
          unsubscribe?.();
          entry.ref.stepPhase?.end();
          entry.ref.stepPhase = undefined;
          entry.ref.firstTokenPhase?.end();
          entry.ref.firstTokenPhase = undefined;
          steps.settleResults();
          activeSteps = undefined;
          entry.ref.emit = turn.emit;
          await thinkTail;
          await recordCapturedRequests({ entry, turn, callUsage, userEntry, effectiveModel });
          entry.ref.onModelRequest = undefined;
          toolAbort.abort();
          entry.ref.abortSignal = undefined;
          entry.ref.steered = undefined;
          entry.ref.screenToolResult = undefined;
        }
        if (persistError) throw persistError;
        if (wallClockTurnFailure(wallClock, userAborted, turn.cancel?.aborted === true)) {
          const capLabel =
            turnWallClockMs % 60_000 === 0
              ? `${turnWallClockMs / 60_000}-minute`
              : `${Math.round(turnWallClockMs / 1000)}-second`;
          throw new NonRetryableTurnError(
            `the turn hit its ${capLabel} wall-clock limit and was stopped` +
              (wallClock === "abandoned" ? " (a stuck operation did not respond to cancellation)" : ""),
          );
        }
        const settleGoal = (pause: boolean): Promise<void> => settleTurnGoal({ entry, turn, grindMeter }, pause);
        const result = (reply: string, extra: Partial<AgentTurnResult>): AgentTurnResult =>
          turnResult({ entry, callUsage, checked }, reply, extra);
        if (entry.ref.runtimeHandoff && !userAborted && !turn.cancel?.aborted) {
          steps.flush();
          await thinkTail;
          if (persistError) throw persistError;
          await settleGoal(false);
          return result("", { runtimeHandoff: entry.ref.runtimeHandoff });
        }
        const freshStopReason = freshAssistantStopReason();
        const cancelStoppedCleanly =
          turn.cancel?.aborted === true && (freshStopReason === "aborted" || freshStopReason === undefined);
        if (userAborted || cancelStoppedCleanly) {
          const freshMessages = entry.agentSession.messages.slice(messagesBefore);
          const lastFreshAssistant = [...freshMessages]
            .reverse()
            .find((m) => (m as { role?: string }).role === "assistant");
          const partial = lastFreshAssistant
            ? textFromContent((lastFreshAssistant as { content?: unknown }).content)
            : "";
          const reply = partial.trim() ? partial : "";
          await settleGoal(userAborted);
          await recordStoppedTurn(
            turn,
            partial,
            userAborted ? abortReason : "because the run was cancelled",
            steps.closing(reply),
          );
          return result(reply, { stopped: true, ...(abortScope ? { stopScope: abortScope } : {}) });
        }

        await settleGoal(false);
        const closingText = recoveryDead ? "" : (piLastAssistantTextOrThrow(entry.agentSession) ?? "");
        const reply = entry.ref.silentRequested ? "" : closingText;
        const closing = steps.closing(reply);
        await turn.emit({ kind: "AgentMessage", text: reply, step: closing?.step ?? null, body: { ...closing?.body } });
        const pendingApprovals = entry.ref.pendingApprovals ?? [];
        return result(reply, {
          ...(pendingApprovals.length ? { pendingApprovals } : {}),
          ...(pendingApprovals.length && entry.ref.pausedOnApproval ? { pausedOnApproval: true } : {}),
          ...(entry.ref.silentRequested ? { silent: true } : {}),
        });
      } finally {
        removeIsolatedDirs(entry);
      }
    },

    async shouldRespond(detect: DetectInput): Promise<DetectResult> {
      const route = await utilityRoute(opts?.detectModelId);
      if (!route) return { respond: true };
      const detectSystemPrompt = buildDetectionPrompt(detect.reactionGuidance);
      const prompt = renderDetectPrompt(detect);
      detect.recordModelCall({
        model: route.modelId,
        inputTokens: countTokens(detectSystemPrompt) + countTokens(prompt),
        entryCount: detect.history.length,
      });
      const out = (
        (await oneShot("pi-detect", route.model, route.keys, detectSystemPrompt, prompt, {
          modelGateway: route.gateway,
          purpose: "detect",
          ...(detect.recordLlmRequest ? { recordLlmRequest: detect.recordLlmRequest } : {}),
        })) ?? ""
      ).trim();
      return parseDetectVerdict(out, Boolean(detect.reactionGuidance?.trim()));
    },

    async compactHistory(input: CompactInput): Promise<string> {
      const summarize = async (route: ModelRoute) => {
        const runtime = await buildModelRuntime(route.keys, route.gateway, "compaction");
        return summarizeHistory(input.history, route.model, (summaryModel, context, options) => {
          input.recordModelCall({
            model: route.modelId,
            inputTokens: countTokens(context.systemPrompt ?? "") + countTokens(JSON.stringify(context.messages)),
            entryCount: input.history.length,
          });
          return runtime.streamSimple(summaryModel, context, options);
        });
      };
      const primary = servable(await sessionRoute(input));
      if (!primary)
        throw new Error(`no configured credential can serve ${input.runtime?.modelId ?? baseModelId()} for a summary`);
      try {
        return await summarize(primary);
      } catch (error) {
        if (!(error instanceof ProviderTurnError)) throw error;
        const failure = routeFailed(error, primary);
        const fallback = FALLBACK_CODES.has(error.code)
          ? await fallbackRoute(new Set([primary.modelId, primary.model.id]), input.providerKeys)
          : undefined;
        if (!fallback) throw failure;
        console.error(
          `[pi] compaction failed on ${primary.modelId}; retrying on fallback ${fallback.modelId}: ${error.message}`,
        );
        try {
          return await summarize(fallback);
        } catch (fallbackError) {
          throw fallbackFailed(failure, fallback, errMessage(fallbackError));
        }
      }
    },

    contextTokenBudget(model?: string): number | undefined {
      return contextTokenBudgetForModel(model && resolveModel(model) ? model : baseModelId());
    },

    async oneShot(systemPrompt: string, prompt: string, purpose?: ModelRequestPurpose): Promise<string | undefined> {
      const route = await utilityRoute();
      if (!route) return undefined;
      return oneShot("pi-oneshot", route.model, route.keys, systemPrompt, prompt, {
        modelGateway: route.gateway,
        purpose,
      });
    },

    async judge(
      systemPrompt: string,
      prompt: string,
      signal?: AbortSignal,
      purpose: ModelRequestPurpose = "judge",
    ): Promise<string | undefined> {
      const route = await utilityRoute(opts?.judgeModelId);
      if (!route) return undefined;
      return oneShot("pi-judge", route.model, route.keys, systemPrompt, prompt, {
        modelGateway: route.gateway,
        purpose,
        signal,
        thinkingLevel: "low",
      });
    },

    async screenSecurity({ payload, signal, recordModelCall, recordLlmRequest }) {
      const systemPrompt = SECURITY_SCREEN_SYSTEM_PROMPT;
      try {
        const route = await utilityRoute(opts?.detectModelId);
        if (!route) return undefined;
        recordModelCall({
          model: route.modelId,
          inputTokens: countTokens(systemPrompt) + countTokens(payload),
          entryCount: 1,
        });
        await recordLlmRequest?.({
          turnSeq: null,
          step: SECURITY_SCREEN_STEP,
          model: route.modelId,
          promptEnvelope: { system: systemPrompt, messages: [{ role: "user", content: payload }] },
          truncated: false,
        });
        return parseSecurityScreenVerdict(
          await oneShot("pi-security-screen", route.model, route.keys, systemPrompt, payload, {
            signal,
            modelGateway: route.gateway,
            purpose: "security_screen",
          }),
        );
      } catch (e) {
        swallow("pi: security screen", e);
        return undefined;
      }
    },

    async pickAckEmoji(text: string, candidates: readonly string[]): Promise<string | undefined> {
      if (!text.trim() || candidates.length === 0) return undefined;
      const route = await utilityRoute();
      if (!route) return undefined;
      const prompt = `Candidates: ${candidates.join(", ")}\n\nMessage: ${text.slice(0, 2000)}`;
      const runtime = await buildModelRuntime(route.keys, route.gateway, "ack_emoji");
      const reply = await runtime.completeSimple(
        route.model,
        { systemPrompt: ACK_EMOJI_PROMPT, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
        { maxTokens: 64, signal: AbortSignal.timeout(2_000) },
      );
      if (reply.stopReason === "error") throw providerTurnError(reply);
      const raw = reply.content.find((block) => block.type === "text")?.text;
      if (!raw) return undefined;
      const emoji = (JSON.parse(raw.replace(/```json|```/g, "").trim()) as { emoji?: unknown }).emoji;
      return typeof emoji === "string" && candidates.includes(emoji) ? emoji : undefined;
    },

    async generateTitle(transcript: string): Promise<string | undefined> {
      if (!transcript.trim()) return undefined;
      const route = (await utilityRoute(opts?.titleModelId ?? TITLE_MODEL_ID)) ?? (await utilityRoute());
      if (!route) return undefined;
      const out = await oneShot(
        "pi-title",
        route.model,
        route.keys,
        TITLE_GENERATION_PROMPT,
        titleUserPrompt(transcript),
        { modelGateway: route.gateway, purpose: "title" },
      );
      return sanitizeTitle(out);
    },

    async suggestNextPrompt(transcript: string): Promise<string | undefined> {
      const route = await utilityRoute(NEXT_PROMPT_MODEL_ID);
      if (!route) return undefined;
      const runtime = await buildModelRuntime(route.keys, route.gateway, "next_prompt");
      const reply = await runtime.completeSimple(
        route.model,
        { systemPrompt: NEXT_PROMPT_PROMPT, messages: [{ role: "user", content: transcript, timestamp: Date.now() }] },
        { reasoning: "minimal" },
      );
      if (reply.stopReason === "error") throw providerTurnError(reply);
      return reply.content.find((block) => block.type === "text")?.text.trim() || undefined;
    },

    async summarizeApproval(command: string, reason: string, purpose?: string): Promise<string | undefined> {
      if (!command.trim()) return undefined;
      const route = await utilityRoute(opts?.titleModelId);
      if (!route) return undefined;
      const prompt = [
        `Policy flagged this as: ${reason}`,
        purpose ? `Agent's stated purpose: ${purpose}` : "",
        "",
        "Command:",
        command.slice(0, 4000),
      ].join("\n");
      const out = (
        await oneShot("pi-approval-summary", route.model, route.keys, APPROVAL_SUMMARY_PROMPT, prompt, {
          modelGateway: route.gateway,
          purpose: "approval_summary",
        })
      )?.trim();
      if (!out || out === "NONE") return undefined;
      return out.replace(/^["']|["']$/g, "").slice(0, 300);
    },
  };
  return agent;
}
