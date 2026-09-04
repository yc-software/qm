import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { sanitizeTitle, TITLE_GENERATION_PROMPT, titleUserPrompt } from "./pi-harness.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { CONFIG_DEFAULTS, type Config } from "../config.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import { DEFAULT_CODEX_MODEL_ID, modelSupportedByHarness } from "../model/pi-models.ts";
import { startSignalPoll, type RunSignalStore } from "../runs/run-signal-store.ts";
import type { TaskStatus, TaskStore } from "../tasks/task-store.ts";
import type { LlmCallUsage } from "../sessions/session-store.ts";
import type { ScopeId, SessionEntry } from "../types.ts";
import { swallow } from "../util/errors.ts";
import { countTokens } from "../util/tokens.ts";
import { parseSecurityScreenVerdict, SECURITY_SCREEN_SYSTEM_PROMPT } from "../security/security-posture.ts";
import { CodexAppServer, CodexRpcError, redactCodexDiagnostics } from "./codex-app-server.ts";
import { codexAuthFileForEnv, readCodexOAuthAuthFile } from "./codex-auth.ts";
import {
  childCodexAuthFromDerived,
  childCodexOAuthAuth,
  fileCodexAuthStore,
  type CodexAuthStore,
} from "./codex-auth-store.ts";
import { defineHarness, type Harness, type HarnessTurnInput, type HarnessTurnResult } from "./harness.ts";
import { coreToolOptions, createPiTools, type PiToolsOptions, type ToolContextRef } from "./pi-tools.ts";
import type { McpToolDescriptor } from "../mcp/mcp-tool-service.ts";
import { reconstructMessagesFromHistory, seedPriorTurns, type PiReplayMessage } from "./replay.ts";

export interface CodexHarnessOptions {
  modelId?: string | ((scope?: ScopeId) => string | undefined);
  defaultModelId?: string;
  judgeModelId?: string;
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  scratchExec?: boolean;
  ownerAuthExec?: boolean;
  reachExec?: boolean;
  mcpTools?: () => McpToolDescriptor[];
  controlTools?: boolean;
  turnWallClockMs?: number;
  execTimeoutMs?: number;
  execTimeoutCeilingMs?: number;
  backgroundJobTtlMs?: number;
  backgroundJobTtlMaxMs?: number;
  appServerStartTimeoutMs?: number;
  /** Cap on simultaneous per-user app-server launches (default 8). */
  maxConcurrentUserServers?: number;
  /** Custodian of the ChatGPT-subscription Codex login (keychain-backed in production). */
  authStore?: CodexAuthStore;
  signals?: RunSignalStore;
  tasks?: TaskStore;
}

export function codexHarnessConfigOptions(config: Config): CodexHarnessOptions {
  return {
    ...(config.codexModel ? { defaultModelId: config.codexModel } : {}),
    ...(config.judgeModelId && modelSupportedByHarness(config.judgeModelId, "codex")
      ? { judgeModelId: config.judgeModelId }
      : {}),
    ...(config.codexBinPath ? { binaryPath: config.codexBinPath } : {}),
    env: config.codexProcessEnv,
    ...coreToolOptions(config),
    turnWallClockMs: config.turnWallClockMs,
  };
}

export function codexToolContext(turn: HarnessTurnInput): ToolContextRef {
  return {
    current: turn.tools,
    pendingApprovals: [],
    pausedOnApproval: false,
    silentRequested: false,
    pollFire: Boolean(turn.pollFire),
    emit: turn.emit,
    scopeLabel: turn.scopeLabel,
    orgScopeId: turn.orgScopeId,
    screenExternalContent: turn.screenExternalContent,
    toolApprovalGate: turn.toolApprovalGate,
  };
}

type BridgedTool = {
  name: string;
  description: string;
  parameters: unknown;
  execute(
    callId: string,
    args: unknown,
  ): Promise<{ content?: Array<{ type?: string; text?: string }>; terminate?: boolean }>;
};

type CodexItem = Record<string, unknown> & { type: string };
type CodexTurn = { id: string; status: string; error?: { message?: string } | null; items?: CodexItem[] };
const CODEX_TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "canceled"]);

function isCodexThreadStart(value: unknown): value is { thread: { id: string }; model?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  const thread = response.thread;
  return Boolean(
    thread &&
    typeof thread === "object" &&
    !Array.isArray(thread) &&
    typeof (thread as Record<string, unknown>).id === "string" &&
    (!("model" in response) || typeof response.model === "string"),
  );
}

function isCodexTurnStart(value: unknown): value is { turn: CodexTurn } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const turn = (value as Record<string, unknown>).turn;
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return false;
  const response = turn as Record<string, unknown>;
  return typeof response.id === "string" && typeof response.status === "string";
}

function isCodexTurn(value: unknown): value is CodexTurn {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const turn = value as Record<string, unknown>;
  if (typeof turn.id !== "string" || typeof turn.status !== "string") return false;
  if (!CODEX_TERMINAL_TURN_STATUSES.has(turn.status)) return false;
  if (
    "items" in turn &&
    (!Array.isArray(turn.items) ||
      turn.items.some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          Array.isArray(item) ||
          typeof (item as Record<string, unknown>).type !== "string" ||
          !(item as Record<string, unknown>).type,
      ))
  )
    return false;
  const error = turn.error;
  return (
    error === undefined ||
    error === null ||
    (typeof error === "object" &&
      !Array.isArray(error) &&
      (!("message" in error) || typeof (error as Record<string, unknown>).message === "string"))
  );
}

type ActiveTurn = {
  server: CodexAppServer;
  threadId: string;
  turn: HarnessTurnInput;
  tools: Map<string, BridgedTool>;
  resolve(turn: CodexTurn): void;
  reject(error: Error): void;
  responseItems: CodexItem[];
  completedItems: CodexItem[];
  taskIds: Map<string, string>;
  taskStatuses: Map<string, TaskStatus>;
  taskResults: Set<string>;
  model: string;
  modelCalls: number;
  usageInputTotals: Map<string, number>;
  usageByThread: Map<string, LlmCallUsage>;
  firstOutputAt: number | null;
  fallbackInputTokens: number;
  tapeWriteFailed: boolean;
  interrupt?: () => Promise<void>;
  stopped: boolean;
};

type Runtime = {
  server: CodexAppServer;
  jail: string;
};
type StartingRuntime = {
  promise: Promise<Runtime>;
  abort: AbortController;
  waiters: number;
};
const CODEX_START_TIMEOUT_MS = 30_000;

const CODEX_NON_RETRYABLE_PATTERN =
  /\b(?:401|402|403)\b|unauthoriz|forbidden|invalid[_ -]?api[_ -]?key|incorrect api key|authentication (?:error|failed)|missing bearer|missing (?:api key|credentials)|not logged in|codex login|insufficient[_ -]?quota|exceeded your current quota|billing|credit(?: balance| limit)|out of credits|credits_depleted|must be verified|model[_ -]?not[_ -]?found|does not exist or you do not have access|unsupported[_ -]?model/i;

export function codexNonRetryable(message: string): boolean {
  return CODEX_NON_RETRYABLE_PATTERN.test(message);
}

export function codexProviderFailure(message: string): Error {
  const safe = redactCodexDiagnostics(message);
  return codexNonRetryable(safe) ? new NonRetryableTurnError(safe) : new Error(safe);
}
const CODEX_CHILD_TOOL_NAMES = new Set(["execute", "read", "write", "publish", "memory", "history", "background"]);

export function codexChildToolAllowed(name: string): boolean {
  return CODEX_CHILD_TOOL_NAMES.has(name);
}

function usageNumber(value: unknown, ...names: string[]): number {
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  for (const name of names) {
    if (!(name in record)) continue;
    const parsed = Number(record[name]);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

export function codexUsageTotals(params: unknown): LlmCallUsage | null {
  if (!params || typeof params !== "object") return null;
  const tokenUsage = (params as Record<string, unknown>).tokenUsage;
  if (!tokenUsage || typeof tokenUsage !== "object") return null;
  const total = (tokenUsage as Record<string, unknown>).total;
  if (!total || typeof total !== "object") return null;
  const input = usageNumber(total, "inputTokens", "input_tokens");
  const output = usageNumber(total, "outputTokens", "output_tokens");
  const cacheRead = usageNumber(total, "cachedInputTokens", "cached_input_tokens");
  return { input, output, cacheRead, cacheWrite: 0, totalTokens: input + output, costUsd: 0 };
}

function sumUsage(byThread: ReadonlyMap<string, LlmCallUsage>): LlmCallUsage | null {
  if (!byThread.size) return null;
  const total: LlmCallUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };
  for (const usage of byThread.values()) {
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.totalTokens += usage.totalTokens;
  }
  return total;
}

export function codexTokenUsageUpdate(
  params: unknown,
  priorInputTokens = 0,
): { inputTokens: number; totalInputTokens: number } | null {
  if (!params || typeof params !== "object") return null;
  const tokenUsage = (params as Record<string, unknown>).tokenUsage;
  if (!tokenUsage || typeof tokenUsage !== "object") return null;
  const usage = tokenUsage as Record<string, unknown>;
  const totalInputTokens = usageNumber(usage.total, "inputTokens", "input_tokens");
  if (totalInputTokens <= priorInputTokens) return null;
  const lastInputTokens = usageNumber(usage.last, "inputTokens", "input_tokens");
  return { inputTokens: lastInputTokens || totalInputTokens - priorInputTokens, totalInputTokens };
}

const CODEX_ENV_PASSTHROUGH = [
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_ACCESS_TOKEN",
] as const;

export function codexChildEnv(
  source: NodeJS.ProcessEnv,
  jail: string,
  auth?: Record<string, unknown> | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: jail,
    CODEX_HOME: join(jail, "codex-home"),
  };
  const authPath = codexAuthFileForEnv(source, true);
  const fileAuth = () => (authPath ? readCodexOAuthAuthFile(authPath) : null);
  const oauthAuth = auth !== undefined ? auth : fileAuth();
  for (const name of CODEX_ENV_PASSTHROUGH) {
    if (oauthAuth && (name === "OPENAI_API_KEY" || name === "OPENAI_BASE_URL" || name === "CODEX_ACCESS_TOKEN"))
      continue;
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

export function prepareCodexHome(
  source: NodeJS.ProcessEnv,
  jail: string,
  auth?: Record<string, unknown> | null,
): string {
  const target = join(jail, "codex-home");
  mkdirSync(target, { recursive: true });
  const authPath = codexAuthFileForEnv(source, true);
  const fileAuth = () => (authPath ? readCodexOAuthAuthFile(authPath) : null);
  const oauthAuth = auth !== undefined ? auth : fileAuth();
  if (oauthAuth) {
    // The child receives derived, ephemeral material only: no refresh token.
    writeFileSync(join(target, "auth.json"), JSON.stringify(childCodexOAuthAuth(oauthAuth)), { mode: 0o600 });
    return target;
  }
  if (source.OPENAI_API_KEY) {
    writeFileSync(
      join(target, "auth.json"),
      JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: source.OPENAI_API_KEY }),
      { mode: 0o600 },
    );
  }
  return target;
}

async function transitionTask(
  store: TaskStore | undefined,
  id: string,
  expected: TaskStatus,
  next: TaskStatus,
  runId: string,
): Promise<void> {
  if (!store) return;
  const updated = await store.transitionStatus(id, expected, next, runId);
  if (!updated) throw new Error(`task ${id} was not ${expected} while transitioning to ${next}`);
}

function toolOptions(opts: CodexHarnessOptions, turn?: HarnessTurnInput): PiToolsOptions {
  return {
    scratchExec: opts.scratchExec,
    ownerAuthExec: opts.ownerAuthExec,
    reachExec: opts.reachExec,
    ...(opts.mcpTools ? { mcpTools: opts.mcpTools } : {}),
    controlTools: opts.controlTools,
    execTimeoutMs: opts.execTimeoutMs,
    execTimeoutCeilingMs: opts.execTimeoutCeilingMs,
    backgroundJobTtlMs: opts.backgroundJobTtlMs,
    backgroundJobTtlMaxMs: opts.backgroundJobTtlMaxMs,
    ...(turn
      ? {
          readOnly: turn.readOnly,
          surfaceTools: turn.surfaceTools,
          surfaceName: turn.surfaceName,
          credentialExecServices: turn.credentialExecServices,
        }
      : { surfaceTools: true, surfaceName: "slack" }),
  };
}

function asTools(ref: ToolContextRef, options: PiToolsOptions): BridgedTool[] {
  return createPiTools(ref, options) as unknown as BridgedTool[];
}

function userInput(text: string): Record<string, unknown> {
  return { type: "text", text, text_elements: [] };
}

export function codexReplayCallId(id: string): string {
  return id.length <= 64 ? id : createHash("sha256").update(id).digest("hex");
}

function replayItems(messages: readonly PiReplayMessage[]): CodexItem[] {
  const out: CodexItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({
        type: "message",
        role: "user",
        content: message.content.map((part) => ({ type: "input_text", text: part.text })),
      });
      continue;
    }
    if (message.role === "toolResult") {
      out.push({
        type: "function_call_output",
        call_id: codexReplayCallId(message.toolCallId),
        output: message.content.map((part) => part.text).join("\n"),
      });
      continue;
    }
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text) out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
    for (const part of message.content) {
      if (part.type === "toolCall")
        out.push({
          type: "function_call",
          call_id: codexReplayCallId(part.id),
          name: part.name,
          arguments: JSON.stringify(part.arguments),
        });
    }
  }
  return out;
}

function textFromTurn(turn: CodexTurn): string {
  const messages = (turn.items ?? []).filter((item) => item.type === "agentMessage" && typeof item.text === "string");
  const final = messages.filter((item) => item.phase === "final_answer");
  const unphased = messages.filter((item) => item.phase === undefined || item.phase === null);
  let selected = messages;
  if (final.length) selected = final;
  else if (unphased.length) selected = unphased;
  return selected
    .map((item) => String(item.text))
    .join("\n")
    .trim();
}

function reasoningFromTurn(turn: CodexTurn): string[] {
  return (turn.items ?? []).flatMap((item) =>
    item.type === "reasoning" && Array.isArray(item.summary)
      ? item.summary.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      : [],
  );
}

function toolText(result: Awaited<ReturnType<BridgedTool["execute"]>>): string {
  return (result.content ?? [])
    .filter((item): item is { type?: string; text: string } => typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

export function codexTaskTitle(prompt: unknown): string {
  if (typeof prompt !== "string" || !prompt.trim()) return "subagent task";
  const normalized = prompt.replace(/\s+/g, " ").trim();
  const named = /\bYou are (?:the )?([^.!?]{1,80}? subagent)\b/i.exec(normalized)?.[1];
  const title = named ?? normalized;
  return title.length > 120 ? `${title.slice(0, 119).trimEnd()}…` : title;
}

export function codexReasoningEffort(value: string | undefined): "low" | "medium" | "high" | "xhigh" | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : undefined;
}

export function codexTurnInputText(
  turn: Pick<HarnessTurnInput, "history" | "priorTurns" | "input" | "environment">,
): string {
  const prior = turn.history.length
    ? ""
    : seedPriorTurns(turn.priorTurns ?? [])
        .map((message) => message.text)
        .join("\n");
  return [prior, turn.input, turn.environment].filter((item) => item?.trim()).join("\n\n");
}

export function createCodexHarness(opts: CodexHarnessOptions = {}): Harness {
  const active = new Map<string, ActiveTurn>();
  const configuredModel = opts.modelId;
  const judgeModelId = opts.judgeModelId ?? "gpt-5.4-mini";
  const resolveModelId = (scope?: ScopeId) =>
    [
      typeof configuredModel === "function" ? configuredModel(scope) : configuredModel,
      opts.defaultModelId,
      DEFAULT_CODEX_MODEL_ID,
    ].find((id): id is string => modelSupportedByHarness(id, "codex"))!;
  const defaultTurnWallClockMs = opts.turnWallClockMs ?? CONFIG_DEFAULTS.turnWallClockSec * 1000;
  const sourceEnv = opts.env ?? {};
  const authPath = codexAuthFileForEnv(sourceEnv, true);
  const authStore: CodexAuthStore | undefined =
    opts.authStore ?? (authPath && readCodexOAuthAuthFile(authPath) ? fileCodexAuthStore(authPath) : undefined);
  const oauthConfigured = Boolean(authStore);
  const closeAbort = new AbortController();
  let runtime: Runtime | null = null;
  let starting: StartingRuntime | null = null;
  let startingServer: CodexAppServer | null = null;
  let setupUsers = 0;
  let runtimeCleanupRequested = false;
  // Per-user turns get their own short-lived app-server (own jail, own auth) —
  // measured at ~0.5s/9MB per spawn — so accounts never share a process and
  // org turns are never serialized behind them. The semaphore only bounds
  // simultaneous process launches.
  const ephemeralServers = new Set<CodexAppServer>();
  const maxConcurrentSpawns = opts.maxConcurrentUserServers ?? 8;
  let activeSpawns = 0;
  const spawnWaiters: Array<() => void> = [];
  const acquireSpawnSlot = async (): Promise<() => void> => {
    while (activeSpawns >= maxConcurrentSpawns)
      await new Promise<void>((resolveWait) => spawnWaiters.push(resolveWait));
    activeSpawns += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeSpawns -= 1;
      spawnWaiters.shift()?.();
    };
  };

  const processCollabItem = async (state: ActiveTurn, item: CodexItem): Promise<void> => {
    if (item.type !== "collabAgentToolCall") return;
    const tool = String(item.tool ?? "");
    const receivers = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.filter((value): value is string => typeof value === "string")
      : [];
    if (tool === "spawnAgent") {
      for (const receiver of receivers) {
        if (state.taskIds.has(receiver)) continue;
        const taskId = `${String(item.id)}:${receiver}`;
        if (opts.tasks)
          await opts.tasks.create({
            id: taskId,
            sessionId: state.turn.session.id,
            originRunId: state.turn.runId ?? state.turn.session.id,
            title: codexTaskTitle(item.prompt),
            status: "in_progress",
          });
        state.taskIds.set(receiver, taskId);
        state.taskStatuses.set(taskId, "in_progress");
        active.set(receiver, state);
        await state.turn.emit({
          type: "tool_call",
          payload: { tool: "spawnAgent", callId: taskId, prompt: item.prompt, receiverThreadId: receiver },
          scopeLabel: state.turn.scopeLabel,
        });
      }
    }
    const agents =
      item.agentsStates && typeof item.agentsStates === "object"
        ? (item.agentsStates as Record<string, { status?: unknown; message?: unknown }>)
        : {};
    for (const [receiver, agent] of Object.entries(agents)) {
      const taskId = state.taskIds.get(receiver);
      if (!taskId) continue;
      let next: TaskStatus | undefined;
      if (agent.status === "completed" || agent.status === "shutdown") next = "completed";
      else if (agent.status === "errored" || agent.status === "interrupted" || agent.status === "notFound") {
        next = "failed";
      } else if (agent.status === "running") next = "in_progress";
      const prior = state.taskStatuses.get(taskId);
      if (next && prior && next !== prior) {
        await transitionTask(opts.tasks, taskId, prior, next, state.turn.runId ?? state.turn.session.id);
        state.taskStatuses.set(taskId, next);
      }
      if ((next === "completed" || next === "failed") && !state.taskResults.has(taskId)) {
        state.taskResults.add(taskId);
        await state.turn.emit({
          type: "tool_result",
          payload: {
            tool: "spawnAgent",
            callId: taskId,
            result: typeof agent.message === "string" ? agent.message : next,
            isError: next === "failed",
          },
          scopeLabel: state.turn.scopeLabel,
        });
      }
    }
  };

  const buildServer = (jail: string, childEnv: NodeJS.ProcessEnv): CodexAppServer => {
    const binaryPath = opts.binaryPath ?? resolve("node_modules/.bin/codex");
    const server: CodexAppServer = new CodexAppServer({
      binaryPath,
      cwd: jail,
      env: childEnv,
      onNotification: async (method, params) => {
        const p = (params ?? {}) as Record<string, unknown>;
        const threadId = typeof p.threadId === "string" ? p.threadId : "";
        const state = active.get(threadId);
        if (!state || state.server !== server) return;
        if (method === "thread/tokenUsage/updated") {
          const totals = codexUsageTotals(p);
          if (totals) state.usageByThread.set(threadId, totals);
          const usage = codexTokenUsageUpdate(p, state.usageInputTotals.get(threadId));
          if (!usage) return;
          state.usageInputTotals.set(threadId, usage.totalInputTokens);
          state.modelCalls++;
          state.turn.recordModelCall({
            model: state.model,
            inputTokens: usage.inputTokens,
            entryCount: state.turn.history.length,
          });
        }
        if (method === "item/agentMessage/delta" && threadId === state.threadId && typeof p.delta === "string") {
          state.firstOutputAt ??= Date.now();
          state.turn.onDelta?.(p.delta);
        }
        if ((method === "item/started" || method === "item/completed") && p.item && typeof p.item === "object") {
          const item = p.item as CodexItem;
          if (method === "item/completed") {
            state.completedItems.push(item);
            if (state.turn.tape) {
              try {
                await state.turn.tape({
                  kind: "message",
                  harness: "codex",
                  scopeLabel: state.turn.scopeLabel,
                  payload: item,
                });
              } catch (error) {
                state.tapeWriteFailed = true;
                swallow("codex: tape append", error);
              }
            }
          }
          await processCollabItem(state, item);
        }
        if (method === "turn/completed" && threadId === state.threadId) {
          const completed = p.turn as CodexTurn | undefined;
          if (!isCodexTurn(completed)) {
            state.reject(new CodexRpcError("Codex app-server sent an invalid turn/completed payload"));
            return;
          }
          state.resolve(completed.items?.length ? completed : { ...completed, items: state.completedItems });
        }
      },
      onRequest: async (method, params) => {
        if (method !== "item/tool/call") throw new Error(`unsupported Codex request ${method}`);
        const p = (params ?? {}) as Record<string, unknown>;
        const threadId = String(p.threadId ?? "");
        const state = active.get(threadId);
        if (!state || state.server !== server) throw new Error("inactive Codex thread");
        const name = String(p.tool ?? "");
        const callId = String(p.callId ?? "");
        if (threadId !== state.threadId && !codexChildToolAllowed(name))
          throw new Error(`Codex child requested unavailable tool ${name}`);
        const tool = state.tools.get(name);
        if (!tool) throw new Error(`Codex requested unavailable tool ${name}`);
        state.responseItems.push({
          type: "function_call",
          call_id: callId,
          name,
          arguments: JSON.stringify(p.arguments ?? {}),
        });
        try {
          const result = await tool.execute(callId, p.arguments ?? {});
          const output = toolText(result);
          state.responseItems.push({ type: "function_call_output", call_id: callId, output });
          if (result.terminate || state.turn.cancel?.aborted)
            setImmediate(() => {
              const requestingTurnId = String(p.turnId ?? "");
              if (threadId !== state.threadId && requestingTurnId) {
                void server.request("turn/interrupt", { threadId, turnId: requestingTurnId }).catch(() => undefined);
              }
              void state.interrupt?.();
            });
          return { contentItems: [{ type: "inputText", text: output }], success: true };
        } catch (error) {
          const output = error instanceof Error ? error.message : String(error);
          state.responseItems.push({ type: "function_call_output", call_id: callId, output });
          return { contentItems: [{ type: "inputText", text: output }], success: false };
        }
      },
    });
    return server;
  };

  const ensureRuntime = async (
    registerCancel?: (release: () => void) => void,
    startupDeadline = 0,
  ): Promise<Runtime> => {
    if (runtime && runtime.server.process.exitCode === null) return runtime;
    if (runtime) {
      const stale = runtime;
      runtime = null;
      runtimeCleanupRequested = false;
      const staleError = stale.server.error() ?? new Error("Codex app-server exited during a turn");
      for (const [threadId, state] of active) {
        if (state.server !== stale.server) continue;
        state.reject(staleError);
        active.delete(threadId);
      }
      await stale.server.close().catch(() => undefined);
      rmSync(stale.jail, { recursive: true, force: true });
    }
    let startup = starting;
    if (startup?.abort.signal.aborted) {
      if (starting === startup) starting = null;
      startup = null;
    }
    if (!startup) {
      const startupAbort = new AbortController();
      const promise = (async () => {
        const jail = mkdtempSync(join(tmpdir(), "qm-codex-"));
        const sourceAuth = authStore ? await authStore.load() : null;
        let server!: CodexAppServer;
        try {
          if (oauthConfigured && !sourceAuth)
            throw new Error(`Codex OAuth auth is unavailable (${authStore!.description})`);
          prepareCodexHome(sourceEnv, jail, oauthConfigured ? sourceAuth : undefined);
          if (startupAbort.signal.aborted) throw new Error("Codex app-server startup cancelled");
          server = buildServer(jail, codexChildEnv(sourceEnv, jail, oauthConfigured ? sourceAuth : undefined));
          startingServer = server;
          if (startupAbort.signal.aborted) throw new Error("Codex app-server startup cancelled");
        } catch (error) {
          await server?.close().catch(() => undefined);
          rmSync(jail, { recursive: true, force: true });
          throw error;
        }
        let startTimer: NodeJS.Timeout | undefined;
        try {
          const initializationTimeout = startupDeadline
            ? Math.min(
                opts.appServerStartTimeoutMs ?? CODEX_START_TIMEOUT_MS,
                Math.max(1, startupDeadline - Date.now()),
              )
            : (opts.appServerStartTimeoutMs ?? CODEX_START_TIMEOUT_MS);
          await Promise.race([
            server.initialize(),
            new Promise<never>((_, reject) => {
              startTimer = setTimeout(
                () => reject(new Error("Codex app-server initialization timed out")),
                initializationTimeout,
              );
            }),
          ]);
        } catch (error) {
          await server.close().catch(() => undefined);
          rmSync(jail, { recursive: true, force: true });
          throw error;
        } finally {
          if (startTimer) clearTimeout(startTimer);
          if (startingServer === server) startingServer = null;
        }
        runtime = { server, jail };
        runtimeCleanupRequested = false;
        server.process.once("close", () => {
          void (async () => {
            const currentRuntime = runtime?.server === server;
            const closeError = server.error() ?? new Error("Codex app-server exited during a turn");
            for (const [threadId, state] of active) {
              if (state.server !== server) continue;
              state.reject(closeError);
              active.delete(threadId);
            }
            if (!currentRuntime) {
              rmSync(jail, { recursive: true, force: true });
              return;
            }
            runtime = null;
            runtimeCleanupRequested = false;
            if (!closeAbort.signal.aborted) rmSync(jail, { recursive: true, force: true });
          })().catch((error) => {
            swallow("codex: provider close cleanup", error);
            try {
              rmSync(jail, { recursive: true, force: true });
            } catch (cleanupError) {
              swallow("codex: provider close jail cleanup", cleanupError);
            }
          });
        });
        return runtime;
      })();
      startup = { promise, abort: startupAbort, waiters: 0 };
      starting = startup;
      const current = startup;
      void promise.then(
        () => {
          if (starting === current) starting = null;
        },
        () => {
          if (starting === current) starting = null;
        },
      );
    }
    const current = startup;
    current.waiters += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      current.waiters -= 1;
      if (current.waiters === 0 && starting === current) {
        current.abort.abort();
        void startingServer?.close().catch(() => undefined);
      }
    };
    registerCancel?.(release);
    try {
      return await current.promise;
    } finally {
      release();
    }
  };

  const closeIdleRuntime = async (): Promise<void> => {
    const current = runtime;
    if (!current) return;
    if (active.size || setupUsers) {
      runtimeCleanupRequested = true;
      return;
    }
    runtimeCleanupRequested = false;
    if (runtime === current) runtime = null;
    await current.server.close().catch(() => undefined);
    rmSync(current.jail, { recursive: true, force: true });
  };

  const runPrompt = async (turn: HarnessTurnInput, toolsEnabled = true): Promise<HarnessTurnResult> => {
    if (turn.cancel?.aborted) return { reply: "", stopped: true };
    setupUsers += 1;
    let setupUserReleased = false;
    const releaseSetupUser = () => {
      if (setupUserReleased) return;
      setupUserReleased = true;
      setupUsers -= 1;
    };
    const wallMs = turn.turnWallClockMs ?? defaultTurnWallClockMs;
    const deadline = wallMs > 0 ? Date.now() + wallMs : 0;
    const runtimeRecoveryDeadline = Date.now() + Math.max(wallMs, CODEX_START_TIMEOUT_MS);
    const setupCancelled = new Error("Codex setup cancelled");
    const setupTimedOut = new NonRetryableTurnError(`Codex turn exceeded ${Math.round(wallMs / 1000)}s wall clock`);
    let rejectSetup!: (error: Error) => void;
    let setupSettled = false;
    let releaseStartupWaiter: () => void = () => {};
    const authAcquireAbort = new AbortController();
    const setupStop = new Promise<never>((_, reject) => {
      rejectSetup = reject;
    });
    const stopSetup = (error: Error) => {
      if (setupSettled) return;
      setupSettled = true;
      releaseStartupWaiter();
      authAcquireAbort.abort();
      rejectSetup(error);
    };
    const onSetupCancel = () => stopSetup(setupCancelled);
    turn.cancel?.addEventListener("abort", onSetupCancel, { once: true });
    const setupTimer = wallMs > 0 ? setTimeout(() => stopSetup(setupTimedOut), wallMs) : undefined;
    const finishSetup = () => {
      setupSettled = true;
      if (setupTimer) clearTimeout(setupTimer);
      turn.cancel?.removeEventListener("abort", onSetupCancel);
      releaseSetupUser();
    };
    const awaitSetup = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, setupStop]);
    let ephemeral: Runtime | undefined;
    let releaseSpawnSlot: (() => void) | undefined;
    const closeEphemeral = async (): Promise<void> => {
      const current = ephemeral;
      ephemeral = undefined;
      try {
        if (current) {
          ephemeralServers.delete(current.server);
          await current.server.close().catch(() => undefined);
          rmSync(current.jail, { recursive: true, force: true });
        }
      } finally {
        releaseSpawnSlot?.();
        releaseSpawnSlot = undefined;
      }
    };
    let rt: Runtime;
    if (turn.codexAuth) {
      // Per-user turn: a dedicated short-lived app-server on this user's
      // account. No shared jail, no cross-account serialization — the org
      // runtime is never touched.
      const userAuth = childCodexAuthFromDerived(turn.codexAuth);
      if (!userAuth) {
        finishSetup();
        throw new NonRetryableTurnError(
          "Your ChatGPT connection is incomplete — disconnect and sign in again from the AI account panel.",
        );
      }
      const jail = mkdtempSync(join(tmpdir(), "qm-codex-user-"));
      try {
        releaseSpawnSlot = await awaitSetup(acquireSpawnSlot());
        prepareCodexHome(sourceEnv, jail, userAuth);
        const server = buildServer(jail, codexChildEnv(sourceEnv, jail, userAuth));
        ephemeral = { server, jail };
        ephemeralServers.add(server);
        server.process.once("close", () => {
          const closeError = server.error() ?? new Error("Codex app-server exited during a turn");
          for (const [threadId, state] of active) {
            if (state.server !== server) continue;
            state.reject(closeError);
            active.delete(threadId);
          }
        });
        let startTimer: NodeJS.Timeout | undefined;
        try {
          await awaitSetup(
            Promise.race([
              server.initialize(),
              new Promise<never>((_, reject) => {
                startTimer = setTimeout(
                  () => reject(new Error("Codex app-server initialization timed out")),
                  opts.appServerStartTimeoutMs ?? CODEX_START_TIMEOUT_MS,
                );
              }),
            ]),
          );
        } finally {
          if (startTimer) clearTimeout(startTimer);
        }
        rt = ephemeral;
      } catch (error) {
        if (!ephemeral) rmSync(jail, { recursive: true, force: true });
        await closeEphemeral();
        finishSetup();
        if (error === setupCancelled) return { reply: "", stopped: true };
        throw error;
      }
    } else {
      try {
        rt = await awaitSetup(
          ensureRuntime((release) => {
            releaseStartupWaiter = release;
          }),
        );
      } catch (error) {
        finishSetup();
        await closeIdleRuntime();
        if (error === setupCancelled) return { reply: "", stopped: true };
        throw error;
      }
    }
    const failSetup = async (error: unknown): Promise<HarnessTurnResult> => {
      await closeEphemeral();
      finishSetup();
      await closeIdleRuntime();
      if (error === setupCancelled) return { reply: "", stopped: true };
      throw error;
    };
    try {
      if (!ephemeral && oauthConfigured) {
        // Re-materialize fresh, centrally refreshed tokens for this turn. The
        // store owns the refresh token; the child jail only ever holds
        // short-lived derived material.
        const sourceAuth = await awaitSetup(authStore!.load());
        if (!sourceAuth) {
          rmSync(join(rt.jail, "codex-home", "auth.json"), { force: true });
          throw new NonRetryableTurnError(`Codex OAuth auth is unavailable (${authStore!.description})`);
        }
        if (runtime !== rt || rt.server.process.exitCode !== null) {
          if (Date.now() >= runtimeRecoveryDeadline)
            throw new NonRetryableTurnError("Codex OAuth runtime recovery timed out");
          rt = await awaitSetup(
            ensureRuntime((release) => {
              releaseStartupWaiter = release;
            }, runtimeRecoveryDeadline),
          );
        } else {
          prepareCodexHome(sourceEnv, rt.jail, sourceAuth);
        }
      }
    } catch (error) {
      return failSetup(error);
    }
    let ref!: ToolContextRef;
    let toolAbort!: AbortController;
    let tools!: BridgedTool[];
    let dynamicTools!: Array<Record<string, unknown>>;
    let model: string | undefined;
    let threadStartRequest!: Record<string, unknown>;
    try {
      ref = codexToolContext(turn);
      toolAbort = new AbortController();
      ref.abortSignal = toolAbort.signal;
      tools = toolsEnabled ? asTools(ref, toolOptions(opts, turn)) : [];
      dynamicTools = tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      }));
      model = modelSupportedByHarness(turn.model, "codex") ? turn.model! : resolveModelId(turn.scopeLabel);
      threadStartRequest = {
        ...(model ? { model } : {}),
        cwd: rt.jail,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        baseInstructions: turn.systemPrompt,
        developerInstructions:
          "Use the supplied dynamic tools for all workspace, execution, memory, history, and surface operations. The built-in working directory is an empty read-only control jail, not the user's workspace.",
        dynamicTools,
        experimentalRawEvents: true,
        environments: [],
        config: {
          web_search: "disabled",
          ...(codexReasoningEffort(turn.thinkingLevel)
            ? { model_reasoning_effort: codexReasoningEffort(turn.thinkingLevel) }
            : {}),
          features: {
            shell_tool: false,
            unified_exec: false,
            shell_snapshot: false,
            apps: false,
            plugins: false,
            browser_use: false,
            browser_use_external: false,
            computer_use: false,
            image_generation: false,
            in_app_browser: false,
            multi_agent: !turn.readOnly,
            request_permissions_tool: false,
            tool_suggest: false,
          },
        },
      };
    } catch (error) {
      return failSetup(error);
    }
    let started: { thread: { id: string }; model?: string };
    try {
      const requestTimeoutMs = deadline ? Math.max(1, deadline - Date.now()) : CODEX_START_TIMEOUT_MS;
      let requestTimer: NodeJS.Timeout | undefined;
      const requestAbort = new AbortController();
      started = await awaitSetup(
        Promise.race([
          rt.server.request(
            "thread/start",
            threadStartRequest,
            isCodexThreadStart,
            AbortSignal.any([authAcquireAbort.signal, closeAbort.signal, requestAbort.signal]),
          ),
          new Promise<never>((_, reject) => {
            requestTimer = setTimeout(() => {
              requestAbort.abort();
              reject(new NonRetryableTurnError("Codex thread/start request timed out"));
            }, requestTimeoutMs);
          }),
        ]).finally(() => {
          if (requestTimer) clearTimeout(requestTimer);
        }),
      );
    } catch (error) {
      return failSetup(error);
    }
    let threadId!: string;
    let replay!: ReturnType<typeof replayItems>;
    let userEntry!: SessionEntry;
    try {
      threadId = started.thread.id;
      replay = replayItems(reconstructMessagesFromHistory(turn.history));
      if (replay.length) await awaitSetup(rt.server.request("thread/inject_items", { threadId, items: replay }));
      userEntry = await awaitSetup(
        turn.emit({
          type: "user",
          payload: {
            text: turn.input,
            ...((turn.triggerTs ?? turn.entryTs) ? { ts: turn.triggerTs ?? turn.entryTs } : {}),
            ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
          },
          scopeLabel: turn.scopeLabel,
        }),
      );
    } catch (error) {
      return failSetup(error);
    }
    let resolveCompleted!: (value: CodexTurn) => void;
    let rejectCompleted!: (error: Error) => void;
    let completed!: Promise<CodexTurn>;
    let inputText!: string;
    let input!: Array<Record<string, unknown>>;
    let selectedModel!: string;
    let state!: ActiveTurn;
    try {
      completed = new Promise<CodexTurn>((resolveTurn, rejectTurn) => {
        resolveCompleted = resolveTurn;
        rejectCompleted = rejectTurn;
      });
      void completed.catch(() => undefined);
      inputText = codexTurnInputText(turn);
      input = [
        userInput(inputText),
        ...(turn.images ?? []).map((image) => ({
          type: "image",
          url: `data:${image.mimeType};base64,${image.dataBase64}`,
        })),
      ];
      selectedModel = model ?? started.model ?? "codex-default";
      state = {
        server: rt.server,
        threadId,
        turn,
        tools: new Map(tools.map((tool) => [tool.name, tool])),
        resolve: resolveCompleted,
        reject: rejectCompleted,
        responseItems: [],
        completedItems: [],
        taskIds: new Map(),
        taskStatuses: new Map(),
        taskResults: new Set(),
        model: selectedModel,
        modelCalls: 0,
        usageInputTotals: new Map(),
        usageByThread: new Map(),
        firstOutputAt: null,
        fallbackInputTokens: countTokens(JSON.stringify({ replay, input })),
        tapeWriteFailed: false,
        stopped: false,
      };
    } catch (error) {
      return failSetup(error);
    }
    active.set(threadId, state);
    finishSetup();
    const promptEnvelope = {
      threadStart: {
        ...threadStartRequest,
        cwd: "[ephemeral control jail]",
      },
    };
    const startedAt = Date.now();
    const recordRequest = async (): Promise<void> => {
      if (!turn.recordLlmRequest) return;
      const recordAbort = new AbortController();
      let recordTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          turn.recordLlmRequest(
            {
              turnSeq: userEntry.seq,
              step: 0,
              model: selectedModel,
              promptEnvelope,
              truncated: Boolean(turn.images?.length),
              transport: { modelId: selectedModel },
              ttftMs: state.firstOutputAt ? state.firstOutputAt - startedAt : null,
              durationMs: Date.now() - startedAt,
              usage: sumUsage(state.usageByThread),
            },
            recordAbort.signal,
          ),
          new Promise<never>((_, reject) => {
            recordTimer = setTimeout(() => {
              recordAbort.abort();
              reject(new Error("Codex llm request recording timed out"));
            }, 5_000);
          }),
        ]);
      } catch (error) {
        swallow("codex: llm request record", error);
      } finally {
        if (recordTimer) clearTimeout(recordTimer);
      }
    };
    if (turn.tape) {
      try {
        await turn.tape({
          kind: "message",
          harness: "codex",
          scopeLabel: turn.scopeLabel,
          entrySeq: userEntry.seq,
          meta: {
            bareText: turn.input,
            ...((turn.triggerTs ?? turn.entryTs) ? { ts: (turn.triggerTs ?? turn.entryTs)! } : {}),
          },
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: inputText },
              ...(turn.images ?? []).map((image) => ({
                type: "input_image",
                image_url: "[image bytes omitted]",
                media_type: image.mimeType,
              })),
            ],
          },
        });
      } catch (error) {
        state.tapeWriteFailed = true;
        swallow("codex: tape append", error);
      }
    }
    let turnId = "";
    const interrupt = async (stopped: boolean) => {
      state.stopped ||= stopped;
      toolAbort.abort();
      if (turnId) await rt.server.request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
    };
    state.interrupt = () => interrupt(false);
    const onCancel = () => {
      runtimeCleanupRequested = true;
      void interrupt(true);
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
              onSteer: async (text, ts) => {
                await turn.emit({
                  type: "user",
                  payload: { text, ...(ts ? { ts } : {}), steered: true },
                  scopeLabel: turn.scopeLabel,
                });
                await rt.server.request("turn/steer", { threadId, expectedTurnId: turnId, input: [userInput(text)] });
              },
            },
            { onError: (error) => swallow("codex signal poll", error) },
          )
        : null;
    let timer: NodeJS.Timeout | undefined;
    const turnStartAbort = new AbortController();
    let turnStartTimedOut = false;
    const cleanupErrors: unknown[] = [];
    let turnResult: HarnessTurnResult | undefined;
    try {
      const turnStartSignals = [closeAbort.signal, turnStartAbort.signal];
      if (turn.cancel) turnStartSignals.push(turn.cancel);
      const turnStartTimeoutMs = deadline ? Math.max(1, deadline - Date.now()) : CODEX_START_TIMEOUT_MS;
      let turnStartTimer: NodeJS.Timeout | undefined;
      const response = await Promise.race([
        rt.server.request<{ turn: CodexTurn }>(
          "turn/start",
          { threadId, input, ...(model ? { model } : {}) },
          isCodexTurnStart,
          AbortSignal.any(turnStartSignals),
        ),
        new Promise<never>((_, reject) => {
          turnStartTimer = setTimeout(() => {
            turnStartTimedOut = true;
            runtimeCleanupRequested = true;
            turnStartAbort.abort();
            reject(new NonRetryableTurnError("Codex turn/start request timed out"));
          }, turnStartTimeoutMs);
        }),
      ])
        .finally(() => {
          if (turnStartTimer) clearTimeout(turnStartTimer);
        })
        .catch((error: unknown) => {
          if (turnStartTimedOut) {
            const timeoutError = new NonRetryableTurnError("Codex turn/start request timed out");
            timeoutError.cause = error;
            throw timeoutError;
          }
          throw error instanceof CodexRpcError ? codexProviderFailure(error.message) : error;
        });
      turnId = response.turn.id;
      if (toolAbort.signal.aborted || turn.cancel?.aborted) await interrupt(false);
      const remainingWallMs = deadline ? Math.max(1, deadline - Date.now()) : 0;
      const result =
        remainingWallMs > 0
          ? await Promise.race([
              completed,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  runtimeCleanupRequested = true;
                  void interrupt(false);
                  reject(setupTimedOut);
                }, remainingWallMs);
              }),
            ])
          : await completed;
      if (state.modelCalls === 0) {
        state.modelCalls = 1;
        turn.recordModelCall({
          model: selectedModel,
          inputTokens: state.fallbackInputTokens,
          entryCount: turn.history.length,
        });
      }
      if (result.status === "failed") throw codexProviderFailure(result.error?.message ?? "Codex turn failed");
      if (turn.cancel?.aborted) {
        runtimeCleanupRequested = true;
        turnResult = { reply: "", stopped: true };
      } else {
        const terminal = ref.silentRequested || ref.pausedOnApproval;
        const reply = terminal ? "" : textFromTurn(result);
        for (const thinking of reasoningFromTurn(result))
          await turn.emit({ type: "thinking", payload: { thinking }, scopeLabel: turn.scopeLabel });
        if (reply && !terminal)
          await turn.emit({
            type: "assistant",
            payload: { text: reply, stopped: state.stopped || undefined },
            scopeLabel: turn.scopeLabel,
          });
        turnResult = {
          reply,
          ...(state.stopped ? { stopped: true as const } : {}),
          ...(ref.silentRequested ? { silent: true } : {}),
          ...(ref.pendingApprovals?.length ? { pendingApprovals: ref.pendingApprovals } : {}),
          ...(ref.pausedOnApproval ? { pausedOnApproval: true } : {}),
          modelCalls: state.modelCalls,
          ...(state.tapeWriteFailed ? { tapeWriteFailed: true } : {}),
        };
      }
    } catch (error) {
      if (turn.cancel?.aborted) {
        runtimeCleanupRequested = true;
        turnResult = { reply: "", stopped: true };
      } else {
        throw error;
      }
    } finally {
      if (timer) clearTimeout(timer);
      try {
        await stopSignals?.();
      } catch (error) {
        cleanupErrors.push(error);
      }
      turn.cancel?.removeEventListener("abort", onCancel);
      for (const [taskId, status] of state.taskStatuses) {
        if (status === "pending" || status === "in_progress") {
          try {
            await transitionTask(opts.tasks, taskId, status, "failed", turn.runId ?? turn.session.id);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
      }
      for (const [activeThreadId, activeState] of active) {
        if (activeState === state) active.delete(activeThreadId);
      }
      try {
        await closeEphemeral();
      } catch (error) {
        swallow("codex: ephemeral runtime close", error);
      }
      if (runtimeCleanupRequested) await closeIdleRuntime();
      await recordRequest();
    }
    if (cleanupErrors.length) throw cleanupErrors[0];
    if (!turnResult) throw new Error("Codex turn did not produce a result");
    return turnResult;
  };

  const single = async (
    systemPrompt: string,
    prompt: string,
    signal?: AbortSignal,
    observe?: Pick<HarnessTurnInput, "recordModelCall" | "recordLlmRequest">,
    modelOverride?: string,
  ): Promise<string | undefined> => {
    const session = { id: `oneshot-${randomBytes(8).toString("hex")}` } as HarnessTurnInput["session"];
    const scope = { kind: "org", id: "oneshot" } as unknown as ScopeId;
    const emitted: SessionEntry[] = [];
    const result = await runPrompt(
      {
        session,
        input: prompt,
        systemPrompt,
        history: [],
        tools: {} as HarnessTurnInput["tools"],
        scopeLabel: scope,
        orgScopeId: scope,
        ...(signal ? { cancel: signal } : {}),
        ...(modelOverride ? { model: modelOverride } : {}),
        readOnly: true,
        emit: async (entry) => {
          const saved = {
            ...entry,
            sessionId: session.id,
            seq: emitted.length + 1,
            createdAt: Date.now(),
          } as SessionEntry;
          emitted.push(saved);
          return saved;
        },
        recordModelCall: observe?.recordModelCall ?? (() => {}),
        ...(observe?.recordLlmRequest ? { recordLlmRequest: observe.recordLlmRequest } : {}),
      },
      false,
    );
    return result.reply || undefined;
  };

  return defineHarness(
    {
      id: "codex",
      controlTransport: "json-rpc",
      toolTransport: "dynamic",
      transcriptFormat: "responses-api",
      capabilities: new Set(["abort", "steer", "images", "provider-sessions"]),
    },
    {
      runTurn: runPrompt,
      close: async () => {
        closeAbort.abort();
        await startingServer?.close().catch(() => undefined);
        await starting?.promise.catch(() => undefined);
        for (const server of ephemeralServers) {
          ephemeralServers.delete(server);
          await server.close().catch(() => undefined);
        }
        const current = runtime;
        if (current || active.size) {
          for (const state of active.values()) state.reject(new Error("Codex harness closed during a turn"));
          active.clear();
        }
        if (current) {
          await current.server.close();
          rmSync(current.jail, { recursive: true, force: true });
          if (runtime === current) runtime = null;
        }
      },
      resetSession: () => {},
      oneShot: (system, prompt) => single(system, prompt),
      judge: (system, prompt) => single(system, prompt, undefined, undefined, judgeModelId),
      screenSecurity: async ({ payload, signal, recordModelCall, recordLlmRequest }) =>
        parseSecurityScreenVerdict(
          await single(SECURITY_SCREEN_SYSTEM_PROMPT, payload, signal, {
            recordModelCall,
            ...(recordLlmRequest ? { recordLlmRequest } : {}),
          }),
        ),
      generateTitle: async (transcript) =>
        sanitizeTitle(await single(TITLE_GENERATION_PROMPT, titleUserPrompt(transcript))),
      summarizeApproval: async (command, reason, purpose) =>
        single(
          "Explain this command in one plain-English sentence for an approver.",
          [command, reason, purpose].filter(Boolean).join("\n"),
        ),
    },
  );
}
