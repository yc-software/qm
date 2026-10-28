import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { reportFailure, swallow } from "../util/errors.ts";
import type { TurnHalt, TurnToolState } from "./turn-tool-state.ts";
import type { ModelCallLog } from "./model-call-log.ts";
import type { TurnRequestSettings } from "./turn-request.ts";
import { textAssistant, type PiReplayMessage, type SeededMessage } from "./replay.ts";
import { documentsDroppedNote } from "./turn-recovery.ts";
import { gatewayAttemptHeaders } from "./call-telemetry.ts";
import { withDocumentInputs, type DocumentModel } from "./document-inputs.ts";
import { SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Api, type Model } from "@earendil-works/pi-ai";
import type { ConversationTurn } from "../types.ts";
import { type Item } from "../sessions/items.ts";
import { modelGatewayRequest } from "../model/provider-endpoints.ts";
import { type HarnessTurnInput } from "./harness.ts";
import { createAgentTools, pauseStampAfterToolCall } from "./agent-tools.ts";
import { planColdStartSeed, reconstructMessagesFromHistory, replayPreamble, seedPriorTurns } from "./replay.ts";
import { restoreReplayImages, type ReplayImageLoader } from "./replay-images.ts";
import { countTokens } from "../util/tokens.ts";
import {
  GATEWAY_REQUEST_MAX_BYTES,
  trimPayloadToByteBudget,
  transportFromModel,
  guardOutputBudget,
} from "./pi-payload.ts";
import { type ProviderKeys, buildModelRuntime, applyFastSpeed, applyReasoningMode } from "./pi-model-runtime.ts";
import type { CoreToolOptions } from "./agent-tools.ts";
import type { ModelGatewayTransportConfig } from "../model/provider-endpoints.ts";

export interface TurnSession {
  agentSession: AgentSession;
  composedPromptTokens: number;
  cwd: string;
  agentDir: string;
  ephemeralCwd?: string;
}

interface IsolatedResources {
  resourceLoader: DefaultResourceLoader;
  settingsManager: SettingsManager;
  cwd: string;
  agentDir: string;
  ephemeralCwd?: string;
}

type PiPayloadHook = (payload: unknown, model: unknown) => unknown | Promise<unknown>;
type PiResponseHook = (
  response: { status: number; headers: Record<string, string> },
  model: unknown,
) => void | Promise<void>;
type PiTransformContextHook = (messages: unknown, signal?: unknown) => unknown | Promise<unknown>;
type PiPrepareNextTurnHook = (signal?: unknown) => unknown | Promise<unknown>;
export interface PiAgentWithPayloadHook {
  onPayload?: PiPayloadHook;
  onResponse?: PiResponseHook;
  transformContext?: PiTransformContextHook;
  prepareNextTurn?: PiPrepareNextTurnHook;
  afterToolCall?: (
    info: unknown,
    signal?: unknown,
  ) => Promise<{ terminate?: boolean } | undefined> | { terminate?: boolean } | undefined;
  subscribe?(listener: (event: unknown) => Promise<void> | void): () => void;
}

export function continuableContext<M extends { role?: unknown }>(messages: readonly M[]): M[] | null {
  let end = messages.length;
  while (messages[end - 1]?.role === "assistant") end--;
  const role = messages[end - 1]?.role;
  return role === "user" || role === "toolResult" ? messages.slice(0, end) : null;
}

export function continueAssistantTurn(session: AgentSession): Promise<void> {
  return (session as unknown as { _runAgentPrompt(messages: readonly unknown[]): Promise<void> })._runAgentPrompt([]);
}

interface PiSeedTarget {
  agent?: { state?: { messages?: unknown[] } };
  sessionManager?: { appendMessage?: (message: unknown) => unknown };
}

export function toPiMessage(m: SeededMessage): PiReplayMessage {
  return m.role === "assistant"
    ? textAssistant([{ type: "text", text: m.text }], Date.now())
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

export function removeIsolatedDirs(dirs: { agentDir: string; ephemeralCwd?: string }): void {
  for (const dir of [dirs.agentDir, dirs.ephemeralCwd]) {
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      swallow("pi: temp dir cleanup", e);
    }
  }
}

async function openAgentSession(
  prefix: string,
  systemPrompt: string,
  options: Pick<
    Parameters<typeof createAgentSession>[0] & object,
    "model" | "modelRuntime" | "customTools" | "sessionManager" | "thinkingLevel"
  >,
): Promise<{ session: AgentSession; dirs: IsolatedResources }> {
  const dirs = await createIsolatedResources(prefix, systemPrompt);
  try {
    const { resourceLoader, settingsManager, cwd, agentDir } = dirs;
    const { session } = await createAgentSession({
      ...options,
      resourceLoader,
      settingsManager,
      noTools: "builtin",
      cwd,
      agentDir,
    });
    return { session, dirs };
  } catch (err) {
    removeIsolatedDirs(dirs);
    throw err;
  }
}
export function createTurnTools(
  opts: CoreToolOptions | undefined,
  state: TurnToolState,
  turn: HarnessTurnInput,
): ToolDefinition[] {
  return createAgentTools(state, {
    reachExec: opts?.reachExec,
    controlTools: opts?.controlTools,
    execTimeoutMs: opts?.execTimeoutMs,
    execTimeoutCeilingMs: opts?.execTimeoutCeilingMs,
    backgroundJobTtlMs: opts?.backgroundJobTtlMs,
    backgroundJobTtlMaxMs: opts?.backgroundJobTtlMaxMs,
    sessionTools: Boolean(turn.tools.sessionSyscalls),
    delegateWork: turn.delegateWork === true,
    mcpTools: turn.mcpTools,
    surfaceTools: turn.surfaceTools,
    surfaceName: turn.surfaceName || undefined,
    clientTools: turn.clientTools,
    readOnly: turn.readOnly,
  });
}

export interface TurnSessionInput {
  model: Model<Api>;
  sessionId: string;
  systemPrompt: string;
  history: Item[];
  priorTurns: ConversationTurn[] | undefined;
  providerKeys: () => Promise<ProviderKeys>;
  modelGateway: ModelGatewayTransportConfig | undefined;
  tempDirPrefix: string;
  captureRequests: boolean;
  calls: ModelCallLog;
  request: TurnRequestSettings;
  halt: Pick<TurnHalt, "stopsTools">;
  abortSignal: () => AbortSignal | undefined;
  tools: ToolDefinition[];
  loadImage: ReplayImageLoader | undefined;
}

export async function createTurnSession({
  model,
  sessionId,
  systemPrompt,
  history,
  priorTurns,
  providerKeys,
  modelGateway,
  tempDirPrefix,
  captureRequests,
  calls,
  request,
  halt,
  abortSignal,
  tools,
  loadImage,
}: TurnSessionInput): Promise<TurnSession> {
  let reconstructed: PiReplayMessage[] | null;
  try {
    reconstructed = await restoreReplayImages(reconstructMessagesFromHistory(history), loadImage);
  } catch (err) {
    reportFailure("pi-harness: history reconstruction (falling back)", err);
    reconstructed = null;
  }
  const seedPlan = planColdStartSeed(reconstructed, !!priorTurns?.length);
  const composedPrompt = systemPrompt + (seedPlan === "preamble" ? replayPreamble(history) : "");

  const modelRuntime = await buildModelRuntime(await providerKeys(), modelGateway, "long");
  const { session, dirs } = await openAgentSession(tempDirPrefix, composedPrompt, {
    model,
    modelRuntime,
    customTools: tools,
    sessionManager: SessionManager.inMemory(undefined, { id: sessionId }),
  });

  if (seedPlan === "structured" || seedPlan === "priorTurns") {
    const structured = seedPlan === "structured";
    try {
      seedRawMessagesIntoSession(
        session,
        structured ? reconstructed! : seedPriorTurns(priorTurns!, []).map(toPiMessage),
      );
    } catch (err) {
      reportFailure(
        `pi-harness: seed ${structured ? "reconstructed history" : "prior turns"} (continuing without it)`,
        err,
      );
    }
  }

  const agent = (session as unknown as { agent?: PiAgentWithPayloadHook }).agent;
  if (agent) {
    const prior = agent.onPayload;
    agent.onPayload = async (payload, model) => {
      calls.dispatched();
      applyFastSpeed(payload, request.fast(), (model as { api?: string } | undefined)?.api);
      applyReasoningMode(payload, model as Model<Api>, request.effortLevel());
      const result = prior ? await prior(payload, model) : payload;
      let finalPayload = await withDocumentInputs(
        result ?? payload,
        model as DocumentModel,
        request.documents() ?? [],
        abortSignal(),
        request.documentsStubbed() ? documentsDroppedNote(request.documents() ?? []) : undefined,
      );
      const guarded = guardOutputBudget(finalPayload, model);
      if (guarded.kind === "raised") {
        console.error(
          `[pi] output-budget guard raised output cap ${guarded.from} -> ${guarded.to} (estimated prompt ${guarded.estimatedPromptTokens} tokens) session=${sessionId}`,
        );
      }
      try {
        const gateway = modelGatewayRequest(modelGateway, model as Model<Api>);
        finalPayload = trimPayloadToByteBudget(finalPayload, gateway ? GATEWAY_REQUEST_MAX_BYTES : undefined);
      } catch (e) {
        swallow("pi: request byte budget", e);
      }
      if (captureRequests) calls.capture({ transport: transportFromModel(model) });
      return finalPayload;
    };
    const priorResponse = agent.onResponse;
    agent.onResponse = async (response, model) => {
      calls.responded(() => gatewayAttemptHeaders(response.headers));
      if (priorResponse) await priorResponse(response, model);
    };
    const priorTransform = agent.transformContext;
    agent.transformContext = async (messages, signal) => {
      calls.markTransformContext();
      return priorTransform ? await priorTransform(messages, signal) : messages;
    };
    agent.afterToolCall = pauseStampAfterToolCall(halt, agent.afterToolCall);
    const priorPrepare = agent.prepareNextTurn;
    agent.prepareNextTurn = async (signal) => {
      calls.markPrepareNextTurn();
      return priorPrepare ? await priorPrepare(signal) : undefined;
    };
  }

  return {
    agentSession: session,
    composedPromptTokens: countTokens(composedPrompt),
    cwd: dirs.cwd,
    agentDir: dirs.agentDir,
    ...(dirs.ephemeralCwd ? { ephemeralCwd: dirs.ephemeralCwd } : {}),
  };
}
