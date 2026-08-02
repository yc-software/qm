import { randomBytes } from "node:crypto";
import { CONFIG_DEFAULTS, type Config } from "../config.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import {
  contextTokenBudgetForModel,
  DEFAULT_AGENT_MODEL_ID,
  harnessEffort,
  modelSupportedByHarness,
} from "../model/pi-models.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { startSignalPoll, type RunSignalStore } from "../runs/run-signal-store.ts";
import { parseSecurityScreenVerdict, SECURITY_SCREEN_SYSTEM_PROMPT } from "../security/security-posture.ts";
import type { ScopeId, SessionEntry } from "../types.ts";
import { sleep } from "../util/async.ts";
import { errMessage, swallow, swallowAs } from "../util/errors.ts";
import { countTokens } from "../util/tokens.ts";
import { hashId } from "../util/crypto.ts";
import {
  CmaApiError,
  cmaBlockText,
  createCmaClient,
  isTerminalCmaStatus,
  type CmaClient,
  type CmaCustomTool,
  type CmaEvent,
  type CmaNativeToolset,
  type CmaOutboundEvent,
  type CmaSessionTool,
  type CmaStreamFrame,
  type CmaUserContent,
} from "./cma-client.ts";
import { createCmaWorkAttendant, type CmaWorkAttendant } from "./cma-work.ts";
import { compactTranscript, deterministicCompactSummary } from "./context-compaction.ts";
import { defineHarness, type Harness, type HarnessTurnInput, type HarnessTurnResult } from "./harness.ts";
import {
  buildDetectionPrompt,
  CONTEXT_COMPACTION_PROMPT,
  parseDetectVerdict,
  renderDetectPrompt,
  sanitizeTitle,
  TITLE_GENERATION_PROMPT,
} from "./pi-harness.ts";
import {
  bridgedTools,
  bridgedToolText,
  coreToolOptions,
  turnToolContext,
  turnToolOptions,
  type BridgedTool,
} from "./pi-tools.ts";
import { reconstructMessagesFromHistory, replayTranscript, seedPriorTurns } from "./replay.ts";

const CMA_POLL_INTERVAL_MS = 1_500;
const CMA_LIST_PAGE_LIMIT = 100;
const CMA_LIST_PAGE_CAP = 50;
const CMA_INTERRUPT_SETTLE_MS = 15_000;
const CMA_STREAM_RETRIES = 5;
const CMA_ONESHOT_RETRIES = 2;

export interface CmaSessionRecord {
  cmaSessionId: string;
  contextKey: string;
  toolsKey: string;
  lastSeq: number;
  updatedAt: number;
}

export interface CmaAgentRecord {
  agentId: string;
  createdAt: number;
}

export interface CmaHarnessOptions {
  modelId?: string | ((scope?: ScopeId) => string | undefined);
  defaultModelId?: string;
  judgeModelId?: string;
  orgId?: string;
  environmentId?: string;
  environmentKey?: string;
  agentId?: string;
  apiKey?: string;
  baseUrl?: string;
  delivery?: "stream" | "poll";
  pollIntervalMs?: number;
  sessions?: DurableMap<CmaSessionRecord>;
  agents?: DurableMap<CmaAgentRecord>;
  scratchExec?: boolean;
  ownerAuthExec?: boolean;
  reachExec?: boolean;
  controlTools?: boolean;
  turnWallClockMs?: number;
  execTimeoutMs?: number;
  execTimeoutCeilingMs?: number;
  backgroundJobTtlMs?: number;
  backgroundJobTtlMaxMs?: number;
  signals?: RunSignalStore;
}

export function cmaHarnessConfigOptions(config: Config): CmaHarnessOptions {
  return {
    ...(config.cmaModel ? { defaultModelId: config.cmaModel } : {}),
    ...(config.judgeModelId && modelSupportedByHarness(config.judgeModelId, "cma")
      ? { judgeModelId: config.judgeModelId }
      : {}),
    orgId: config.orgId,
    ...(config.cmaEnvironmentId ? { environmentId: config.cmaEnvironmentId } : {}),
    ...(config.cmaEnvironmentKey ? { environmentKey: config.cmaEnvironmentKey } : {}),
    ...(config.cmaAgentId ? { agentId: config.cmaAgentId } : {}),
    ...(config.anthropicApiKey ? { apiKey: config.anthropicApiKey } : {}),
    ...(config.cmaBaseUrl ? { baseUrl: config.cmaBaseUrl } : {}),
    delivery: config.cmaDelivery,
    ...coreToolOptions(config),
    turnWallClockMs: config.turnWallClockMs,
  };
}

export function cmaCustomTools(bridged: readonly BridgedTool[]): CmaCustomTool[] {
  return bridged.map((tool) => ({
    type: "custom",
    name: cmaToolName(tool.name),
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

export function cmaContextKey(runtimeKey: string, stableSystem: string): string {
  return `${runtimeKey}\n${hashId([stableSystem], 64)}`;
}

function cmaToolsKey(tools: readonly CmaSessionTool[]): string {
  return hashId([JSON.stringify(tools)], 64);
}

const NATIVE_TOOLS_DISABLED = ["read", "write", "edit", "glob", "grep", "web_fetch", "web_search"] as const;

export const CMA_NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set(["bash", ...NATIVE_TOOLS_DISABLED]);

export function cmaToolName(name: string): string {
  return CMA_NATIVE_TOOL_NAMES.has(name) ? `qm_${name}` : name;
}

const CMA_NATIVE_TOOLSET: CmaNativeToolset = {
  type: "agent_toolset_20260401",
  default_config: { permission_policy: { type: "always_allow" } },
  configs: [{ name: "bash", enabled: true }, ...NATIVE_TOOLS_DISABLED.map((name) => ({ name, enabled: false }))],
};

function splitSystemPrompt(turn: Pick<HarnessTurnInput, "systemPrompt" | "systemCacheBoundary">): {
  stable: string;
  volatile: string;
} {
  const boundary = turn.systemCacheBoundary;
  const valid =
    typeof boundary === "number" &&
    boundary > 0 &&
    boundary < turn.systemPrompt.length &&
    turn.systemPrompt.slice(0, boundary).isWellFormed();
  if (!valid) return { stable: turn.systemPrompt, volatile: "" };
  return { stable: turn.systemPrompt.slice(0, boundary), volatile: turn.systemPrompt.slice(boundary).trim() };
}

function turnPrompt(
  turn: HarnessTurnInput,
  volatileSystem: string,
  replaySource: readonly SessionEntry[],
  seedTurns: boolean,
): string {
  const replay = replayTranscript(reconstructMessagesFromHistory(replaySource));
  const prior = seedTurns
    ? seedPriorTurns(turn.priorTurns ?? [])
        .map((message) => message.text)
        .join("\n")
    : "";
  return [volatileSystem, replay, prior, turn.input, turn.environment].filter((value) => value?.trim()).join("\n\n");
}

function userMessage(text: string, images: HarnessTurnInput["images"] = []): CmaOutboundEvent {
  const content: CmaUserContent[] = [
    { type: "text", text },
    ...images.map((image) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: image.mimeType, data: image.dataBase64 },
    })),
  ];
  return { type: "user.message", content };
}

function eventKey(event: CmaEvent): string | null {
  if (event.id) return event.id;
  if (event.processed_at) return `hash:${hashId([JSON.stringify(event)], 64)}`;
  return null;
}

function classifyTurnError(error: unknown): Error {
  if (error instanceof CmaApiError && isTerminalCmaStatus(error.status)) {
    return new NonRetryableTurnError(error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

class CmaEventWindowExceeded extends Error {}

async function listAllEvents(client: CmaClient, sessionId: string): Promise<CmaEvent[]> {
  const events: CmaEvent[] = [];
  let page: string | undefined;
  for (let i = 0; i < CMA_LIST_PAGE_CAP; i++) {
    const listed = await client.listEvents(sessionId, {
      limit: CMA_LIST_PAGE_LIMIT,
      ...(page ? { page } : {}),
    });
    events.push(...listed.data);
    if (!listed.nextPage) return events.sort((a, b) => (a.processed_at ?? "").localeCompare(b.processed_at ?? ""));
    page = listed.nextPage;
  }
  throw new CmaEventWindowExceeded(
    `CMA session ${sessionId} has more than ${CMA_LIST_PAGE_CAP * CMA_LIST_PAGE_LIMIT} listable events; rotating to a fresh session`,
  );
}

export function createCmaHarness(opts: CmaHarnessOptions = {}): Harness {
  const configuredModel = opts.modelId;
  const judgeModelId = opts.judgeModelId ?? "claude-haiku-4-5";
  const resolveModelId = (scope?: ScopeId) =>
    [
      typeof configuredModel === "function" ? configuredModel(scope) : configuredModel,
      opts.defaultModelId,
      DEFAULT_AGENT_MODEL_ID,
    ].find((id): id is string => modelSupportedByHarness(id, "cma"))!;
  const defaultTurnWallClockMs = opts.turnWallClockMs ?? CONFIG_DEFAULTS.turnWallClockSec * 1000;
  const sessionRecords = opts.sessions ?? createMemoryMap<CmaSessionRecord>();
  const agentRecords = opts.agents ?? createMemoryMap<CmaAgentRecord>();
  const delivery = opts.delivery ?? "stream";
  const pollIntervalMs = opts.pollIntervalMs ?? CMA_POLL_INTERVAL_MS;
  const active = new Set<AbortController>();
  let client: CmaClient | null = null;
  let attendant: CmaWorkAttendant | null = null;

  const ensureAttendant = (): CmaWorkAttendant => {
    attendant ??= createCmaWorkAttendant({
      client: createCmaClient({
        auth: () => ({ authorization: `Bearer ${opts.environmentKey!}` }),
        ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      }),
      environmentId: opts.environmentId!,
    });
    return attendant;
  };

  const ensureClient = (): CmaClient => {
    if (client) return client;
    if (!opts.apiKey || !opts.environmentId || !opts.environmentKey) {
      throw new NonRetryableTurnError(
        "The CMA harness is not configured — set CMA_ENVIRONMENT_ID, CMA_ENVIRONMENT_KEY, and ANTHROPIC_API_KEY.",
      );
    }
    client = createCmaClient({
      auth: () => ({ "x-api-key": opts.apiKey! }),
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    });
    return client;
  };

  const agentKey = (model: string, effort: string | undefined): string => `${model}|${effort ?? "-"}`;

  const ensureAgent = async (api: CmaClient, model: string, effort: string | undefined): Promise<string> => {
    if (opts.agentId) return opts.agentId;
    const key = agentKey(model, effort);
    const existing = await agentRecords.get(key);
    if (existing) return existing.agentId;
    const name = ["qm", opts.orgId, model, effort].filter(Boolean).join(" ");
    const created = await api.createAgent(name, { id: model, ...(effort ? { effort } : {}) });
    const winner = await agentRecords.putIfAbsent(key, { agentId: created.id, createdAt: Date.now() });
    if (winner.agentId !== created.id) {
      await api.archiveAgent(created.id).catch(swallowAs("cma: duplicate agent cleanup", undefined));
    }
    return winner.agentId;
  };

  const waitForIdle = async (api: CmaClient, sessionId: string, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const session = await api.getSession(sessionId);
      if (session.status !== "running") return;
      await sleep(250);
    }
    throw new Error("CMA session did not settle after an interrupt");
  };

  const ensureSession = async (
    api: CmaClient,
    turn: HarnessTurnInput,
    agentId: string,
    model: string,
    stableSystem: string,
    tools: CmaSessionTool[],
  ): Promise<{ cmaSessionId: string; replaySource: readonly SessionEntry[]; fresh: boolean; priorLastSeq: number }> => {
    const contextKey = cmaContextKey(`${opts.environmentId}|${agentId}|${model}`, stableSystem);
    const toolsKey = cmaToolsKey(tools);
    const record = await sessionRecords.get(turn.session.id);
    if (record && record.contextKey === contextKey) {
      const live = await api.getSession(record.cmaSessionId).catch((error: unknown) => {
        if (error instanceof CmaApiError && isTerminalCmaStatus(error.status)) return null;
        throw error;
      });
      if (live && live.status !== "terminated") {
        if (live.status === "running") {
          await api
            .sendEvents(record.cmaSessionId, [{ type: "user.interrupt" }])
            .catch(swallowAs("cma: stale interrupt", undefined));
          await waitForIdle(api, record.cmaSessionId, CMA_INTERRUPT_SETTLE_MS);
        }
        if (record.toolsKey !== toolsKey) {
          await api.updateSessionTools(record.cmaSessionId, tools);
          await sessionRecords.merge(turn.session.id, { toolsKey, updatedAt: Date.now() });
        }
        return {
          cmaSessionId: record.cmaSessionId,
          replaySource: turn.history.filter((entry) => entry.seq > record.lastSeq),
          fresh: false,
          priorLastSeq: record.lastSeq,
        };
      }
    }
    if (record)
      await api.deleteSession(record.cmaSessionId).catch(swallowAs("cma: rotated session cleanup", undefined));
    const created = await api.createSession({
      agent: {
        type: "agent_with_overrides",
        id: agentId,
        system: stableSystem,
        ...(opts.agentId ? { model: { id: model } } : {}),
        tools,
      },
      environment_id: opts.environmentId!,
      metadata: { qm_session: turn.session.id, qm_scope: String(turn.scopeLabel) },
    });
    await sessionRecords.put(turn.session.id, {
      cmaSessionId: created.id,
      contextKey,
      toolsKey,
      lastSeq: 0,
      updatedAt: Date.now(),
    });
    return { cmaSessionId: created.id, replaySource: turn.history, fresh: true, priorLastSeq: 0 };
  };

  const runPrompt = async (turn: HarnessTurnInput): Promise<HarnessTurnResult> => {
    if (turn.cancel?.aborted) return { reply: "", stopped: true };
    const api = ensureClient();
    const model = modelSupportedByHarness(turn.model, "cma") ? turn.model! : resolveModelId(turn.scopeLabel);
    const effort = harnessEffort(turn.thinkingLevel);
    const system = splitSystemPrompt(turn);
    let maxSeq = turn.history.at(-1)?.seq ?? 0;
    const emit: HarnessTurnInput["emit"] = async (entry) => {
      const saved = await turn.emit(entry);
      maxSeq = Math.max(maxSeq, saved.seq);
      return saved;
    };
    const ref = turnToolContext(turn);
    ref.emit = emit;
    const controller = new AbortController();
    ref.abortSignal = controller.signal;
    active.add(controller);
    const bridged = bridgedTools(ref, turnToolOptions(opts, turn));
    const toolsByName = new Map(bridged.map((tool) => [cmaToolName(tool.name), tool]));
    const customTools = cmaCustomTools(bridged);
    const sessionTools: CmaSessionTool[] = [CMA_NATIVE_TOOLSET, ...customTools];
    const provision = () =>
      ensureAgent(api, model, effort).then((agentId) =>
        ensureSession(api, turn, agentId, model, system.stable, sessionTools),
      );
    const ensured = await provision()
      .catch(async (error: unknown) => {
        if (opts.agentId || !(error instanceof CmaApiError && isTerminalCmaStatus(error.status))) throw error;
        await agentRecords.delete(agentKey(model, effort));
        return provision();
      })
      .catch((error: unknown) => {
        active.delete(controller);
        throw classifyTurnError(error);
      });
    const cmaSessionId = ensured.cmaSessionId;
    let releaseWork: (() => Promise<void>) | null = null;
    if (turn.cancel?.aborted) {
      active.delete(controller);
      return { reply: "", stopped: true };
    }
    const userEntry = await emit({
      type: "user",
      payload: {
        text: turn.input,
        ...((turn.triggerTs ?? turn.entryTs) ? { ts: turn.triggerTs ?? turn.entryTs } : {}),
        ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
      },
      scopeLabel: turn.scopeLabel,
    });
    const promptText = turnPrompt(turn, system.volatile, ensured.replaySource, ensured.fresh && !turn.history.length);
    const initial = userMessage(promptText, turn.images);

    let stopped = false;
    let done = false;
    let messageSent = false;
    let tapeWriteFailed = false;
    const seenEventIds = new Set<string>();
    const pendingTools = new Map<string, { name: string; input: unknown; kind: "custom" | "native" }>();
    const resulted = new Set<string>();
    const texts = new Map<string, string>();
    const deltaTexts = new Map<string, string>();
    const steerQueue: Array<{ text: string; seq: number }> = [];
    const recordedPrompts: string[] = [promptText];
    const estimateTexts: string[] = [turn.systemPrompt, promptText];
    const estimateMarks: number[] = [];
    const spanUsages: Array<{ input: number; cacheRead: number; cacheWrite: number }> = [];
    let recordedSteps = 0;
    let modelCalls = 0;
    let sawAgentEvent = false;
    let sentSinceLastAgentEvent = true;

    const appendTape = async (payload: unknown, trigger = false) => {
      if (!turn.tape) return;
      try {
        await turn.tape({
          kind: "message",
          harness: "cma",
          payload,
          scopeLabel: turn.scopeLabel,
          ...(trigger
            ? {
                entrySeq: userEntry.seq,
                meta: {
                  bareText: turn.input,
                  ...((turn.triggerTs ?? turn.entryTs) ? { ts: (turn.triggerTs ?? turn.entryTs)! } : {}),
                },
              }
            : {}),
        });
      } catch (error) {
        tapeWriteFailed = true;
        swallow("cma: tape append", error);
      }
    };

    let interruptSend: Promise<void> | null = null;
    const interrupt = async (fromUser: boolean) => {
      stopped ||= fromUser;
      const wasAborted = controller.signal.aborted;
      controller.abort();
      if (!wasAborted) {
        interruptSend = api
          .sendEvents(cmaSessionId, [{ type: "user.interrupt" }])
          .catch(swallowAs("cma: interrupt", undefined));
      }
      await interruptSend;
    };
    const onCancel = () => {
      void interrupt(false);
    };
    if (turn.cancel) {
      if (turn.cancel.aborted) onCancel();
      else turn.cancel.addEventListener("abort", onCancel, { once: true });
    }
    const stopSignals =
      opts.signals && turn.runId
        ? startSignalPoll(
            opts.signals,
            turn.runId,
            {
              onAbort: async () => interrupt(true),
              onSteer: async (steer, ts) => {
                const saved = await emit({
                  type: "user",
                  payload: { text: steer, ...(ts ? { ts } : {}), steered: true },
                  scopeLabel: turn.scopeLabel,
                });
                steerQueue.push({ text: steer, seq: saved.seq });
              },
            },
            { onError: (error) => swallow("cma signal poll", error), drainOnStop: true },
          )
        : null;

    const recordStep = async () => {
      const step = recordedSteps++;
      try {
        await turn.recordLlmRequest?.({
          turnSeq: userEntry.seq,
          step,
          model,
          request:
            step === 0
              ? { system: turn.systemPrompt, prompt: promptText, tools: customTools.map((tool) => tool.name) }
              : { prompt: recordedPrompts[step] ?? "[steer]" },
          truncated: false,
          transport: { modelId: model },
        });
      } catch (error) {
        swallow("cma: llm request record", error);
      }
    };

    const nativeDispatch = (call: {
      name: string;
      input: unknown;
    }): { tool?: BridgedTool; args?: unknown; refusal?: string } => {
      if (call.name !== "bash") return { refusal: `[tool not supported by this deployment: ${call.name}]` };
      const input = (call.input ?? {}) as { command?: unknown; timeout?: unknown; restart?: unknown };
      if (input.restart === true && typeof input.command !== "string") {
        return {
          refusal: "[error] this bash tool does not keep a persistent shell to restart; rerun the command instead",
        };
      }
      if (typeof input.command !== "string" || !input.command) {
        return { refusal: "[error] the bash call carried no command" };
      }
      const tool = toolsByName.get("execute");
      if (!tool) return { refusal: "[tool unavailable: execute]" };
      const timeoutSeconds =
        typeof input.timeout === "number" && input.timeout > 0 ? Math.ceil(input.timeout / 1000) : undefined;
      return {
        tool,
        args: { command: input.command, ...(timeoutSeconds ? { timeout_seconds: timeoutSeconds } : {}) },
      };
    };

    const runTool = async (
      toolUseId: string,
      call: { name: string; input: unknown; kind: "custom" | "native" },
    ): Promise<CmaOutboundEvent> => {
      const dispatch =
        call.kind === "native"
          ? nativeDispatch(call)
          : { tool: toolsByName.get(call.name), args: call.input ?? {}, refusal: `[tool unavailable: ${call.name}]` };
      let text: string;
      let terminate = false;
      if (!dispatch.tool) {
        text = dispatch.refusal!;
      } else {
        try {
          const result = await dispatch.tool.execute(toolUseId, dispatch.args);
          text = bridgedToolText(result);
          terminate = Boolean(result.terminate);
        } catch (error) {
          text = errMessage(error);
        }
      }
      resulted.add(toolUseId);
      estimateTexts.push(text);
      if (terminate || ref.pausedOnApproval || ref.silentRequested) done = true;
      return call.kind === "native"
        ? { type: "user.tool_result", tool_use_id: toolUseId, content: [{ type: "text", text }] }
        : { type: "user.custom_tool_result", custom_tool_use_id: toolUseId, content: [{ type: "text", text }] };
    };

    const unseenEvents = async (): Promise<CmaEvent[]> =>
      (await listAllEvents(api, cmaSessionId)).filter((event) => {
        const key = eventKey(event);
        return !key || !seenEventIds.has(key);
      });

    const sendEventsWithRetry = async (
      events: CmaOutboundEvent[],
      landed?: (unseen: CmaEvent[]) => boolean,
    ): Promise<void> => {
      for (let attempt = 0; ; attempt++) {
        try {
          await api.sendEvents(cmaSessionId, events);
          return;
        } catch (error) {
          if (landed && (await unseenEvents().then(landed, () => false))) return;
          const terminal = error instanceof CmaApiError && isTerminalCmaStatus(error.status);
          if (terminal || controller.signal.aborted || attempt >= CMA_STREAM_RETRIES) throw error;
          await sleep(Math.min(5_000, 250 * 2 ** attempt), { signal: controller.signal });
          if (controller.signal.aborted) throw error;
        }
      }
    };

    const resultsLanded = (results: readonly CmaOutboundEvent[]) => (unseen: CmaEvent[]) =>
      results.every((outbound) =>
        unseen.some((event) => {
          const echo = event as { type?: string; custom_tool_use_id?: string; tool_use_id?: string };
          if (outbound.type === "user.custom_tool_result")
            return echo.type === outbound.type && echo.custom_tool_use_id === outbound.custom_tool_use_id;
          if (outbound.type === "user.tool_result")
            return echo.type === outbound.type && echo.tool_use_id === outbound.tool_use_id;
          return false;
        }),
      );

    const handleIdle = async (stopReason: CmaEvent["stop_reason"]): Promise<void> => {
      if (stopReason?.type === "requires_action") {
        const referenced = stopReason.event_ids ?? [...pendingTools.keys()];
        const ids = referenced.filter((id) => pendingTools.has(id) && !resulted.has(id));
        if (!ids.length) {
          if (referenced.every((id) => resulted.has(id))) return;
          throw new Error("CMA session requires an action this adapter cannot provide");
        }
        const results: CmaOutboundEvent[] = [];
        for (const id of ids) {
          const result = await runTool(id, pendingTools.get(id)!);
          await appendTape(result);
          results.push(result);
        }
        await sendEventsWithRetry(results, resultsLanded(results));
        sentSinceLastAgentEvent = true;
        if (done) await interrupt(false);
        return;
      }
      if (stopReason?.type === "end_turn" || stopReason === undefined) {
        await recordStep();
        if (steerQueue.length) {
          const steers = [...steerQueue];
          recordedPrompts.push(steers.map((steer) => steer.text).join("\n"));
          for (const steer of steers) {
            estimateTexts.push(steer.text);
            await appendTape(userMessage(steer.text));
          }
          const priorEchoes = await unseenEvents().then(
            (events) =>
              new Set(
                events
                  .filter((event) => event.type === "user.message")
                  .map(eventKey)
                  .filter((key): key is string => key !== null),
              ),
            () => null,
          );
          await sendEventsWithRetry(
            steers.map((steer) => userMessage(steer.text)),
            (unseen) => {
              if (!priorEchoes) return false;
              const fresh = unseen.filter((event) => {
                if (event.type !== "user.message") return false;
                const key = eventKey(event);
                return key !== null && !priorEchoes.has(key);
              });
              return (
                fresh.length >= steers.length &&
                steers.every((steer) => fresh.some((event) => cmaBlockText(event.content) === steer.text))
              );
            },
          );
          steerQueue.splice(0, steers.length);
          sentSinceLastAgentEvent = true;
          return;
        }
        done = true;
        return;
      }
      if (stopReason.type === "retries_exhausted") throw new Error("CMA session exhausted its retries mid-turn");
      done = true;
    };

    const handleEvent = async (event: CmaEvent): Promise<void> => {
      const key = eventKey(event);
      if (key) {
        if (seenEventIds.has(key)) return;
        seenEventIds.add(key);
      }
      if (event.type.startsWith("agent.")) sawAgentEvent = true;
      if (event.type.startsWith("agent.") || event.type.startsWith("session.")) sentSinceLastAgentEvent = false;
      if (event.type === "agent.message") {
        const text = cmaBlockText(event.content);
        const eventId = key ?? randomBytes(8).toString("hex");
        const sawStart = deltaTexts.has(eventId);
        const streamedSoFar = deltaTexts.get(eventId) ?? "";
        if (text.length > streamedSoFar.length && text.startsWith(streamedSoFar)) {
          if (!streamedSoFar && !sawStart) turn.onTextBlockStart?.();
          turn.onDelta?.(text.slice(streamedSoFar.length));
        }
        texts.set(eventId, text);
        modelCalls++;
        estimateMarks.push(estimateTexts.length);
        await appendTape(event);
        return;
      }
      if (event.type === "span.model_request_end") {
        const usage = event.model_usage;
        if (typeof usage?.input_tokens === "number") {
          const cacheRead = usage.cache_read_input_tokens ?? 0;
          const cacheWrite = usage.cache_creation_input_tokens ?? 0;
          spanUsages.push({ input: usage.input_tokens, cacheRead, cacheWrite });
          turn.recordModelCall({
            model,
            inputTokens: usage.input_tokens + cacheRead + cacheWrite,
            entryCount: turn.history.length,
          });
        }
        return;
      }
      if (event.type === "agent.thinking") {
        const thinking = typeof event.thinking === "string" ? event.thinking.trim() : "";
        if (thinking) await emit({ type: "thinking", payload: { thinking }, scopeLabel: turn.scopeLabel });
        return;
      }
      if (event.type === "agent.custom_tool_use" || event.type === "agent.tool_use") {
        if (typeof event.name === "string" && event.id) {
          pendingTools.set(event.id, {
            name: event.name,
            input: event.input,
            kind: event.type === "agent.tool_use" ? "native" : "custom",
          });
          await appendTape(event);
        }
        return;
      }
      if (event.type === "session.status_idle") {
        await handleIdle(event.stop_reason);
        return;
      }
      if (event.type === "session.status_terminated") {
        await sessionRecords.delete(turn.session.id);
        throw new Error("CMA session terminated mid-turn");
      }
      if (event.type === "session.error") {
        await sessionRecords.delete(turn.session.id);
        throw new Error(`CMA session error: ${event.error?.message ?? event.error?.type ?? "unknown"}`);
      }
    };

    const handleFrame = async (frame: CmaStreamFrame): Promise<void> => {
      if (frame.kind === "start") {
        if (frame.eventType === "agent.message") {
          deltaTexts.set(frame.eventId, "");
          turn.onTextBlockStart?.();
        }
        return;
      }
      if (frame.kind === "delta") {
        if (!deltaTexts.has(frame.eventId)) return;
        deltaTexts.set(frame.eventId, (deltaTexts.get(frame.eventId) ?? "") + frame.text);
        turn.onDelta?.(frame.text);
        return;
      }
      await handleEvent(frame.event);
    };

    let priorEventsMarked: Promise<void> | null = null;
    const markExistingEventsSeen = (): Promise<void> => {
      priorEventsMarked ??= (async () => {
        if (ensured.fresh) return;
        for (const event of await listAllEvents(api, cmaSessionId)) {
          const key = eventKey(event);
          if (key) seenEventIds.add(key);
        }
      })().catch((error: unknown) => {
        priorEventsMarked = null;
        throw error;
      });
      return priorEventsMarked;
    };

    let fatal: unknown = null;
    const handled = async (frame: CmaStreamFrame): Promise<void> => {
      try {
        await handleFrame(frame);
      } catch (error) {
        fatal = error;
        throw error;
      }
    };
    const retryOrThrow = async (error: unknown, attempts: number): Promise<void> => {
      if (fatal) throw fatal instanceof Error ? fatal : new Error(String(fatal));
      if (error instanceof CmaEventWindowExceeded) throw error;
      if (error instanceof CmaApiError && isTerminalCmaStatus(error.status)) throw error;
      if (attempts > CMA_STREAM_RETRIES) throw error;
      await sleep(Math.min(5_000, 250 * 2 ** attempts), { signal: controller.signal });
    };
    const sendInitial = async (): Promise<void> => {
      await sendEventsWithRetry([initial], (unseen) => unseen.some((event) => event.type === "user.message"));
      messageSent = true;
      await appendTape(initial, true);
    };

    const consumeStream = async (): Promise<void> => {
      let attempts = 0;
      void markExistingEventsSeen().catch(() => undefined);
      while (!done && !controller.signal.aborted) {
        try {
          const stream = await api.streamEvents(cmaSessionId, { signal: controller.signal });
          await markExistingEventsSeen();
          if (!messageSent) {
            await sendInitial();
          } else {
            for (const event of await listAllEvents(api, cmaSessionId)) {
              await handled({ kind: "event", event });
              if (done) return;
            }
          }
          for await (const frame of stream) {
            attempts = 0;
            await handled(frame);
            if (done) return;
          }
          if (!done && !controller.signal.aborted) throw new Error("CMA event stream ended before the turn settled");
        } catch (error) {
          if (done || controller.signal.aborted) return;
          await retryOrThrow(error, ++attempts);
        }
      }
    };

    const consumePoll = async (): Promise<void> => {
      let attempts = 0;
      let quietPolls = 0;
      while (!done && !controller.signal.aborted) {
        try {
          if (!messageSent) {
            await markExistingEventsSeen();
            await sendInitial();
          } else {
            await sleep(pollIntervalMs, { signal: controller.signal });
          }
          if (done || controller.signal.aborted) return;
          const before = seenEventIds.size;
          for (const event of await listAllEvents(api, cmaSessionId)) {
            await handled({ kind: "event", event });
            if (done) return;
          }
          attempts = 0;
          if (seenEventIds.size > before) {
            quietPolls = 0;
            continue;
          }
          quietPolls++;
          if (quietPolls < 2) continue;
          const session = await api.getSession(cmaSessionId);
          if (session.status === "terminated") {
            await handled({ kind: "event", event: { type: "session.status_terminated" } });
          } else if (session.status === "idle" && sawAgentEvent && !sentSinceLastAgentEvent) {
            const unresolved = [...pendingTools.keys()].filter((id) => !resulted.has(id));
            await handled({
              kind: "event",
              event: {
                type: "session.status_idle",
                stop_reason: unresolved.length
                  ? { type: "requires_action", event_ids: unresolved }
                  : { type: "end_turn" },
              },
            });
            quietPolls = 0;
          }
        } catch (error) {
          if (done || controller.signal.aborted) return;
          await retryOrThrow(error, ++attempts);
        }
      }
    };

    const wallMs = turn.turnWallClockMs ?? defaultTurnWallClockMs;
    let timer: NodeJS.Timeout | undefined;
    const assembleReply = (): string => {
      const byEvent = new Map<string, string>(deltaTexts);
      for (const [id, text] of texts) byEvent.set(id, text);
      return [...byEvent.values()]
        .filter((text) => text.trim())
        .join("\n\n")
        .trim();
    };
    const finish = async (interrupted: boolean): Promise<HarnessTurnResult> => {
      const stop = stopped || interrupted;
      const terminal = ref.silentRequested || ref.pausedOnApproval;
      const reply = terminal ? "" : assembleReply();
      if (reply)
        await emit({
          type: "assistant",
          payload: { text: reply, ...(stop ? { stopped: true } : {}) },
          scopeLabel: turn.scopeLabel,
        });
      const usageTotals = spanUsages.reduce(
        (acc, usage) => {
          acc.input += usage.input;
          acc.cacheRead += usage.cacheRead;
          acc.cacheWrite += usage.cacheWrite;
          return acc;
        },
        { input: 0, cacheRead: 0, cacheWrite: 0 },
      );
      return {
        reply,
        ...(stop ? { stopped: true as const } : {}),
        ...(ref.silentRequested ? { silent: true } : {}),
        ...(ref.pendingApprovals?.length ? { pendingApprovals: ref.pendingApprovals } : {}),
        ...(ref.pausedOnApproval ? { pausedOnApproval: true } : {}),
        modelCalls: Math.max(1, modelCalls),
        ...(spanUsages.length
          ? {
              cacheUsage: {
                cacheRead: usageTotals.cacheRead,
                cacheWrite: usageTotals.cacheWrite,
                uncachedInput: usageTotals.input,
              },
            }
          : {}),
        ...(tapeWriteFailed ? { tapeWriteFailed: true } : {}),
      };
    };
    try {
      releaseWork = ensureAttendant().beginTurn(cmaSessionId);
      const consume = delivery === "poll" ? consumePoll() : consumeStream();
      consume.catch(() => undefined);
      try {
        await (wallMs > 0
          ? Promise.race([
              consume,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  void interrupt(false);
                  reject(new NonRetryableTurnError(`CMA turn exceeded ${Math.round(wallMs / 1000)}s wall clock`));
                }, wallMs);
              }),
            ])
          : consume);
      } catch (error) {
        if (controller.signal.aborted && !(error instanceof NonRetryableTurnError)) return await finish(true);
        if (error instanceof CmaEventWindowExceeded) {
          await sessionRecords.delete(turn.session.id).catch(swallowAs("cma: overflow rotation", undefined));
        }
        throw classifyTurnError(error);
      }
      if (!done && controller.signal.aborted) return await finish(true);
      return await finish(false);
    } finally {
      if (timer) clearTimeout(timer);
      if (recordedSteps === 0) await recordStep();
      if (!spanUsages.length) {
        let counted = 0;
        let total = 0;
        for (const mark of estimateMarks) {
          while (counted < mark) total += countTokens(estimateTexts[counted++]!);
          turn.recordModelCall({ model, inputTokens: total, entryCount: turn.history.length });
        }
      }
      await stopSignals?.();
      await interruptSend;
      turn.cancel?.removeEventListener("abort", onCancel);
      controller.abort();
      active.delete(controller);
      await releaseWork?.();
      if (messageSent) {
        const seqCeiling = steerQueue.length ? steerQueue[0]!.seq - 1 : maxSeq;
        await sessionRecords
          .merge(turn.session.id, {
            lastSeq: Math.max(Math.min(maxSeq, seqCeiling), ensured.priorLastSeq),
            updatedAt: Date.now(),
          })
          .catch(swallowAs("cma: session record", undefined));
      }
    }
  };

  const single = async (
    systemPrompt: string,
    prompt: string,
    signal?: AbortSignal,
    observe?: Pick<HarnessTurnInput, "recordModelCall" | "recordLlmRequest">,
    modelOverride?: string,
  ): Promise<string | undefined> => {
    const api = ensureClient();
    const model = modelOverride ?? resolveModelId();
    try {
      let result;
      for (let attempt = 0; ; attempt++) {
        try {
          result = await api.createMessage({ model, system: systemPrompt, prompt }, signal);
          break;
        } catch (error) {
          const terminal = error instanceof CmaApiError && isTerminalCmaStatus(error.status);
          if (terminal || signal?.aborted || attempt >= CMA_ONESHOT_RETRIES) throw error;
          await sleep(Math.min(2_000, 250 * 2 ** attempt), { signal });
        }
      }
      observe?.recordModelCall({
        model,
        inputTokens: result.usage?.inputTokens ?? countTokens(`${systemPrompt}\n${prompt}`),
        entryCount: 0,
      });
      try {
        await observe?.recordLlmRequest?.({
          turnSeq: null,
          step: 0,
          model,
          request: { system: systemPrompt, prompt },
          truncated: false,
          transport: { modelId: model },
          usage: result.usage
            ? {
                input: result.usage.inputTokens,
                output: result.usage.outputTokens,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: result.usage.inputTokens + result.usage.outputTokens,
                costUsd: 0,
              }
            : null,
        });
      } catch (error) {
        swallow("cma: one-shot llm request record", error);
      }
      return result.text.trim() || undefined;
    } catch (error) {
      throw classifyTurnError(error);
    }
  };

  return defineHarness(
    {
      id: "cma",
      controlTransport: "api",
      toolTransport: "dynamic",
      transcriptFormat: "cma-events",
      capabilities: new Set([
        "abort",
        "steer",
        "images",
        "provider-sessions",
        ...(opts.agentId ? [] : (["thinking-level"] as const)),
      ]),
    },
    {
      runTurn: runPrompt,
      close: async () => {
        for (const controller of active) controller.abort();
        active.clear();
        await attendant?.stop();
        attendant = null;
      },
      resetSession: async (sessionId) => {
        const record = await sessionRecords.take(sessionId);
        if (!record) return;
        try {
          await ensureClient().deleteSession(record.cmaSessionId);
        } catch (error) {
          swallow("cma: reset session cleanup", error);
        }
      },
      async shouldRespond(detect) {
        try {
          const out = await single(
            buildDetectionPrompt(detect.reactionGuidance),
            renderDetectPrompt(detect),
            undefined,
            { recordModelCall: detect.recordModelCall },
            judgeModelId,
          );
          return parseDetectVerdict((out ?? "").trim(), Boolean(detect.reactionGuidance?.trim()));
        } catch (error) {
          swallow("cma: detect", error);
          return { respond: false };
        }
      },
      async compactHistory(input) {
        try {
          const out = await single(CONTEXT_COMPACTION_PROMPT, compactTranscript(input.history), undefined, {
            recordModelCall: input.recordModelCall,
          });
          return out ?? deterministicCompactSummary(input.history);
        } catch (error) {
          swallow("cma: compact", error);
          return deterministicCompactSummary(input.history);
        }
      },
      contextTokenBudget(scopeLabel, model) {
        const id = modelSupportedByHarness(model, "cma") ? model! : resolveModelId(scopeLabel as ScopeId | undefined);
        return contextTokenBudgetForModel(id);
      },
      oneShot: (system, prompt) => single(system, prompt),
      judge: (system, prompt) => single(system, prompt, undefined, undefined, judgeModelId),
      screenSecurity: async ({ payload, signal, recordModelCall, recordLlmRequest }) =>
        parseSecurityScreenVerdict(
          await single(SECURITY_SCREEN_SYSTEM_PROMPT, payload, signal, {
            recordModelCall,
            ...(recordLlmRequest ? { recordLlmRequest } : {}),
          }),
        ),
      generateTitle: async (transcript) => sanitizeTitle(await single(TITLE_GENERATION_PROMPT, transcript)),
      summarizeApproval: async (command, reason, purpose) =>
        single(
          "Explain this command in one plain-English sentence for an approver.",
          [command, reason, purpose].filter(Boolean).join("\n"),
        ),
    },
  );
}
