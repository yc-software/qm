import { buildModelRuntime, piUsageToCallUsage, type ProviderKeys } from "./model-runtime.ts";
import type { TurnLlmRequestRecord } from "../agent/agent.ts";
import { type ModelGatewayTransportConfig } from "./provider-endpoints.ts";
import { swallow } from "../util/errors.ts";
import { NonRetryableTurnError, ProviderTurnError } from "../core/turn-error.ts";
import { providerTurnError } from "./provider-error.ts";
import {
  DEFAULT_AGENT_MODEL_ID,
  defaultInteractiveThinkingLevel,
  modelSupportsAdaptiveThinking,
  modelSupportsProviderDefault,
  resolveModel,
} from "./pi-models.ts";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { type Api, type AssistantMessage, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";

type LegacyThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const TURN_EFFORT_LEVELS = new Set<string>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
  "auto",
  "default",
  "adaptive",
]);

export async function oneShot(
  prefix: string,
  model: Model<Api>,
  keys: ProviderKeys | string,
  systemPrompt: string,
  prompt: string,
  opts?: {
    signal?: AbortSignal;
    modelGateway?: ModelGatewayTransportConfig;
    thinkingLevel?: LegacyThinkingLevel;
    recordLlmRequest?: (rec: TurnLlmRequestRecord) => void | Promise<void>;
  },
): Promise<string | undefined> {
  const modelRuntime = await buildModelRuntime(keys, opts?.modelGateway);
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

export function resolveConfiguredModelId(configured: string | undefined, defaultModelId?: string): string {
  for (const candidate of [configured, defaultModelId]) {
    if (!candidate) continue;
    if (resolveModel(candidate)) return candidate;
    swallow("pi: configured model id not in registry, falling back to default", new Error(candidate));
  }
  return DEFAULT_AGENT_MODEL_ID;
}

export function applyTurnEffort(session: AgentSession, level?: string): void {
  if (!level || !TURN_EFFORT_LEVELS.has(level)) return;
  if (level === "adaptive" || level === "default") {
    session.setThinkingLevel("off");
    return;
  }
  const effectiveLevel =
    level === "auto" && session.state.model ? defaultInteractiveThinkingLevel(session.state.model) : level;
  const normalizedLevel = effectiveLevel === "auto" ? "medium" : effectiveLevel;
  const providerLevel = normalizedLevel === "ultracode" ? "max" : normalizedLevel;
  session.setThinkingLevel(providerLevel as ModelThinkingLevel);
}

export function applyReasoningMode<T>(payload: T, model: Model<Api>, level?: string): T {
  if (level !== "adaptive" && level !== "default") return payload;
  if (level === "adaptive" ? !modelSupportsAdaptiveThinking(model) : !modelSupportsProviderDefault(model))
    throw new NonRetryableTurnError(`${level} reasoning is not supported by ${model.id}`);
  if (!payload || typeof payload !== "object") return payload;
  const body = payload as Record<string, unknown>;
  delete body.thinking;
  delete body.reasoning;
  delete body.reasoning_effort;
  if (body.output_config && typeof body.output_config === "object") {
    const outputConfig = { ...body.output_config } as Record<string, unknown>;
    delete outputConfig.effort;
    if (Object.keys(outputConfig).length) body.output_config = outputConfig;
    else delete body.output_config;
  }
  if (model.reasoning && ["openai-responses", "openai-codex-responses"].includes(model.api))
    body.include = [...new Set([...(Array.isArray(body.include) ? body.include : []), "reasoning.encrypted_content"])];
  if (level === "adaptive") body.thinking = { type: "adaptive", display: "summarized" };
  return payload;
}

export async function createIsolatedResources(prefix: string, systemPrompt: string): Promise<IsolatedResources> {
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

export interface IsolatedResources {
  resourceLoader: DefaultResourceLoader;
  settingsManager: SettingsManager;
  cwd: string;
  agentDir: string;
  ephemeralCwd?: string;
}

export function piTurnError(session: AssistantTextSession, thrown: unknown, messagesBefore?: number): Error {
  const detailed = piAssistantFailure(messagesSince(session, messagesBefore));
  if (detailed) return detailed;
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

export function piLastAssistantTextOrThrow(session: AssistantTextSession): string | undefined {
  const err = piAssistantFailure(session);
  if (err) throw err;
  return session.getLastAssistantText();
}

export function piFailedAssistant(session: AssistantTextSession): AssistantMessage | undefined {
  const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant") as
    AssistantMessage | undefined;
  return lastAssistant?.stopReason === "error" ? lastAssistant : undefined;
}

function lastInputTokens(session: AssistantTextSession, failed: AssistantMessage): number | undefined {
  const ok = [...session.messages]
    .reverse()
    .find((m) => m !== failed && m.role === "assistant" && (m as AssistantMessage).stopReason !== "error") as
    AssistantMessage | undefined;
  const u = ok?.usage;
  return u ? u.input + u.cacheRead + u.cacheWrite : undefined;
}

export function piAssistantFailure(session: AssistantTextSession): ProviderTurnError | null {
  const failed = piFailedAssistant(session);
  if (!failed) return null;
  const contextWindow = (
    failed.model ? (resolveModel(failed.model) as { contextWindow?: number } | undefined) : undefined
  )?.contextWindow;
  return providerTurnError(failed, { contextWindow, lastInputTokens: lastInputTokens(session, failed) });
}

export function messagesSince(session: AssistantTextSession, messagesBefore?: number): AssistantTextSession {
  return messagesBefore === undefined
    ? session
    : ({ messages: session.messages.slice(messagesBefore) } as AssistantTextSession);
}

export function piRoundFailed(session: AssistantTextSession, messagesBefore: number): boolean {
  return !!piFailedAssistant(messagesSince(session, messagesBefore));
}

export type AssistantTextSession = Pick<AgentSession, "getLastAssistantText" | "messages">;

export function stableCwd(prefix: string): string {
  return join(tmpdir(), `${prefix}-cwd`);
}
