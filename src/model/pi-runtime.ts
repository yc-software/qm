import { claudeSubscriptionBetas } from "../model/claude-subscription.ts";
import { gatewayModelsJson, gatewayModelsVersion } from "../model/gateway-models.ts";
import { Type } from "typebox";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  calculateCost,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ModelThinkingLevel,
  type ModelsApiStreamOptions,
  type ModelsSimpleStreamOptions,
  type ProviderHeaders,
  type Usage,
} from "@earendil-works/pi-ai";
import { getServiceTierCostMultiplier } from "@earendil-works/pi-ai/api/openai-responses";

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
import type { LlmCallUsage } from "../sessions/session-store.ts";
import { NonRetryableTurnError, ProviderTurnError } from "../core/turn-error.ts";
import { providerTurnError } from "../agent/provider-error.ts";
import { swallow } from "../util/errors.ts";
import {
  DEFAULT_AGENT_MODEL_ID,
  defaultInteractiveThinkingLevel,
  modelSupportsAdaptiveThinking,
  modelSupportsProviderDefault,
  modelRequestOverrides,
  resolveModel,
  modelSupportsFastMode,
  CODEX_SUBSCRIPTION_PROVIDER,
  codexProviderModelId,
} from "../model/pi-models.ts";
import {
  customModelsJson,
  customProvidersVersion,
  hasCustomModelPrefix,
  resolveCustomModel,
} from "../model/custom-providers.ts";
import {
  GatewayModelUnavailableError,
  ModelUnavailableError,
  modelGatewayRequest,
  type ModelGatewayTransportConfig,
} from "../model/provider-endpoints.ts";
import { type TurnLlmRequestRecord } from "../agent/agent.ts";

export interface ProviderKeys {
  anthropic?: string;
  openai?: string;
  openrouter?: string;
  /** Admin-registered custom providers, keyed by provider slug. */
  [provider: string]: string | undefined;
}

let cachedCustomModels: { version: number; path: string | null } | null = null;
function customModelsPath(): string | null {
  const version = customProvidersVersion() + gatewayModelsVersion();
  if (cachedCustomModels?.version === version) return cachedCustomModels.path;
  const providers = { ...customModelsJson()?.providers, ...gatewayModelsJson() };
  const custom = Object.keys(providers).length ? { providers } : undefined;
  let path: string | null = null;
  if (custom) {
    path = join(mkdtempSync(join(tmpdir(), "pi-custom-models-")), "models.json");
    writeFileSync(path, JSON.stringify(custom));
  }
  cachedCustomModels = { version, path };
  return path;
}

export async function buildModelRuntime(
  keys: ProviderKeys | string,
  modelGateway?: ModelGatewayTransportConfig,
  cacheRetention?: "long",
): Promise<ModelRuntime> {
  await modelGateway?.refresh?.();
  const { [CODEX_SUBSCRIPTION_PROVIDER]: subscriptionToken, ...apiKeys }: ProviderKeys =
    typeof keys === "string" ? { anthropic: keys } : keys;
  const credentials = new InMemoryCredentialStore();
  if (subscriptionToken)
    await credentials.modify(CODEX_SUBSCRIPTION_PROVIDER, async () => ({
      type: "oauth",
      access: subscriptionToken,
      refresh: "",
      expires: Number.MAX_SAFE_INTEGER,
    }));
  const modelsPath = customModelsPath();
  const runtime = await ModelRuntime.create({ credentials, modelsPath });
  for (const [provider, apiKey] of Object.entries(apiKeys)) {
    if (apiKey) await runtime.setRuntimeApiKey(provider, apiKey, { allowNetwork: false });
  }
  if (modelGateway) {
    const providers = new Set(
      Object.keys(modelGateway.models).flatMap((id) => {
        const model = resolveModel(id);
        return model ? [model.provider] : [];
      }),
    );
    const hasConfiguredAuth = runtime.hasConfiguredAuth.bind(runtime);
    runtime.hasConfiguredAuth = (provider) => providers.has(provider) || hasConfiguredAuth(provider);
    const getAuth = runtime.getAuth.bind(runtime);
    runtime.getAuth = (async (model, overrides) => {
      if (typeof model === "string") return getAuth(model, overrides);
      const request = modelGatewayRequest(modelGateway, model);
      if (request)
        return {
          auth: { apiKey: request.apiKey, headers: { ...model.headers, ...request.headers } },
          source: "model gateway",
        };
      return getAuth(model, overrides);
    }) as typeof runtime.getAuth;
  }
  const retained = <T extends object | undefined>(options: T): T =>
    cacheRetention ? ({ ...options, cacheRetention } as T) : options;
  const wireModelId = <T extends Pick<ModelsSimpleStreamOptions, "onPayload"> | undefined>(
    options: T,
    model: Model<Api>,
    target: () => Promise<string>,
  ): T =>
    ({
      ...options,
      onPayload: async (payload: unknown) => {
        const transformed = options?.onPayload ? await options.onPayload(payload, model) : undefined;
        const body = transformed === undefined ? payload : transformed;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new Error("model request payload must be an object");
        }
        return { ...body, ...modelRequestOverrides(model.id), model: await target() };
      },
    }) as T;
  const route = <T extends ModelsSimpleStreamOptions | undefined>(
    model: Model<Api>,
    options: T,
  ): { model: Model<Api>; options: T } => {
    const request = modelGatewayRequest(modelGateway, model);
    if (!request) {
      const custom = resolveCustomModel(model.id);
      const providerModelId =
        model.provider === CODEX_SUBSCRIPTION_PROVIDER
          ? codexProviderModelId(model.id)
          : (modelRequestOverrides(model.id)?.model ?? custom?.upstreamId ?? model.id);
      const unregistered = !custom && hasCustomModelPrefix(model.id);
      const candidate = withRequestHeaders(model, true, false, apiKeys[String(model.provider)]);
      const passthrough = {
        ...retained(options),
        onPayload: async (payload: unknown) => {
          const transformed = options?.onPayload ? await options.onPayload(payload, model) : undefined;
          return applyThinkingBinding(transformed === undefined ? payload : transformed, candidate);
        },
      } as T;
      return {
        model: candidate,
        options:
          providerModelId === model.id && !unregistered
            ? passthrough
            : wireModelId(passthrough, model, async () => {
                if (unregistered) throw new ModelUnavailableError(model.id);
                return providerModelId;
              }),
      };
    }
    const routed = {
      ...retained(options),
      apiKey: request.apiKey,
      transformHeaders: async (headers: ProviderHeaders) => ({
        ...(options?.transformHeaders ? await options.transformHeaders(headers) : headers),
        ...request.headers,
      }),
    } as T;
    return {
      model: request.model,
      options: wireModelId(routed, model, async () => {
        await modelGateway?.refresh?.();
        const current = modelGatewayRequest(modelGateway, model);
        if (!current) throw new GatewayModelUnavailableError(model.id);
        return current.target;
      }),
    };
  };
  const stream = runtime.stream.bind(runtime);
  runtime.stream = (<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ) => {
    const routed = route(model, options as ModelsSimpleStreamOptions | undefined);
    return stream(routed.model as Model<TApi>, context, routed.options as unknown as ModelsApiStreamOptions<TApi>);
  }) as typeof runtime.stream;
  const streamSimple = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = ((model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions) => {
    const routed = route(model, options);
    return streamSimple(routed.model, context, routed.options);
  }) as typeof runtime.streamSimple;
  return runtime;
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

export async function probeModel(
  model: Model<Api>,
  keys: ProviderKeys,
  signal: AbortSignal,
  fastMode = false,
  modelGateway?: ModelGatewayTransportConfig,
): Promise<void> {
  const runtime = await buildModelRuntime(keys, modelGateway);
  signal.throwIfAborted();
  const candidate = withRequestHeaders(model, !modelGateway?.models[model.id], fastMode);
  const response = await runtime
    .streamSimple(
      candidate,
      {
        systemPrompt: "This is a connection check. Reply OK. Do not call tools.",
        messages: [{ role: "user", content: "Reply OK.", timestamp: Date.now() }],
        tools: [
          {
            name: "connection_check",
            description: "A synthetic tool for verifying request compatibility. Do not call it.",
            parameters: Type.Object({}),
          },
        ],
      },
      {
        maxTokens: Math.min(128, model.maxTokens),
        signal,
        maxRetryDelayMs: 1,
        onPayload: (payload) => applyFastSpeed(payload, fastMode, model.api),
      },
    )
    .result();
  signal.throwIfAborted();
  if (response.stopReason === "aborted") throw new DOMException("Model verification was aborted", "AbortError");
  if (response.stopReason === "error") throw providerTurnError(response);
  if (response.stopReason !== "stop" || !response.content.some((part) => part.type === "text" && part.text.trim()))
    throw new Error("Model verification did not produce a completed text response");
}

const FAST_MODE_BETA = "fast-mode-2026-02-01";
const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";
const THINKING_BINDING = { prefix_mismatch_behavior: "drop_block" } as const;

export const FAST_COST_MULTIPLIER = 2;

export function scaleCost<T>(cost: T, factor: number): T {
  if (!cost || typeof cost !== "object") return cost;
  const out: Record<string, unknown> = { ...(cost as Record<string, unknown>) };
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (typeof out[key] === "number") out[key] = (out[key] as number) * factor;
  }
  if (Array.isArray(out.tiers)) out.tiers = out.tiers.map((t) => scaleCost(t, factor));
  return out as T;
}

export { modelSupportsFastMode } from "../model/pi-models.ts";

export function wantsFastMode(fastMode: boolean | undefined, modelId: string | undefined): boolean {
  return fastMode === true && modelSupportsFastMode(modelId);
}

function thinkingBindingApplies(model: Pick<Model<Api>, "api" | "compat"> | undefined): boolean {
  return (
    model?.api === "anthropic-messages" &&
    (model.compat as { forceAdaptiveThinking?: unknown } | undefined)?.forceAdaptiveThinking === true
  );
}

export function applyThinkingBinding<T>(
  payload: T,
  model: (Pick<Model<Api>, "headers"> & Partial<Pick<Model<Api>, "thinkingLevelMap">>) | undefined,
): T {
  if (!payload || typeof payload !== "object") return payload;
  if (!model?.headers?.["anthropic-beta"]?.split(",").includes(THINKING_BINDING_BETA)) return payload;
  const thinking =
    (payload as { thinking?: { type?: unknown } }).thinking ??
    (model.thinkingLevelMap?.off === null ? { type: "adaptive", display: "summarized" } : undefined);
  if (thinking?.type === "adaptive" || thinking?.type === "enabled") {
    (payload as Record<string, unknown>).thinking = { ...thinking, block_binding: THINKING_BINDING };
  }
  return payload;
}

export function applyFastSpeed<T>(payload: T, fast: boolean | undefined, api?: string): T {
  if (fast && payload && typeof payload === "object") {
    if (api && api.toLowerCase().startsWith("openai")) {
      (payload as Record<string, unknown>).service_tier = "priority";
    } else {
      (payload as Record<string, unknown>).speed = "fast";
    }
  }
  return payload;
}

export const OUTPUT_BUDGET_FLOOR_TOKENS = 1_024;
export const OUTPUT_GUARD_SAFETY_TOKENS = 4_096;
const OUTPUT_GUARD_CHARS_PER_TOKEN = 4;
const IMAGE_STAND_IN = "i".repeat(4_800);

export type OutputBudgetGuardResult =
  { kind: "ok" } | { kind: "raised"; from: number; to: number; estimatedPromptTokens: number };

function estimatePayloadTokens(payload: Record<string, unknown>): number | undefined {
  try {
    const json = JSON.stringify(payload, function (this: unknown, key, value) {
      if (typeof value !== "string" || value.length <= IMAGE_STAND_IN.length) return value;
      const mediaType = (this as { media_type?: unknown } | null)?.media_type;
      const anthropicImage = key === "data" && typeof mediaType === "string" && mediaType.startsWith("image/");
      const openaiImage = (key === "url" || key === "image_url") && value.startsWith("data:image/");
      const container = this as { media_type?: unknown; mimeType?: unknown; type?: unknown } | null;
      const nativeDocument =
        (key === "file_data" && value.startsWith("data:")) ||
        (key === "data" &&
          ((container?.type === "base64" && container.media_type === "application/pdf") ||
            container?.mimeType === "application/pdf"));
      return anthropicImage || openaiImage || nativeDocument ? IMAGE_STAND_IN : value;
    });
    if (typeof json !== "string") return undefined;
    return Math.ceil(json.length / OUTPUT_GUARD_CHARS_PER_TOKEN);
  } catch {
    return undefined;
  }
}

export function guardOutputBudget(payload: unknown, model: unknown): OutputBudgetGuardResult {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return { kind: "ok" };
  let capKey: "max_tokens" | "max_output_tokens" | "max_completion_tokens" | undefined;
  if (typeof p.max_tokens === "number") capKey = "max_tokens";
  else if (typeof p.max_output_tokens === "number") capKey = "max_output_tokens";
  else if (typeof p.max_completion_tokens === "number") capKey = "max_completion_tokens";
  if (capKey === undefined) return { kind: "ok" };
  const cap = p[capKey] as number;
  if (cap >= OUTPUT_BUDGET_FLOOR_TOKENS) return { kind: "ok" };
  const m = model as { contextWindow?: number; maxTokens?: number } | null;
  const contextWindow = m?.contextWindow;
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return { kind: "ok" };
  const estimatedPromptTokens = estimatePayloadTokens(p);
  if (estimatedPromptTokens === undefined) return { kind: "ok" };
  const available = contextWindow - estimatedPromptTokens - OUTPUT_GUARD_SAFETY_TOKENS;
  if (available < OUTPUT_BUDGET_FLOOR_TOKENS) {
    throw new Error(
      `prompt is too long: estimated ${estimatedPromptTokens} tokens leave no output room in a ${contextWindow}-token window (output-budget guard)`,
    );
  }
  const modelMax = typeof m?.maxTokens === "number" && m.maxTokens > 0 ? m.maxTokens : available;
  const to = Math.min(modelMax, available);
  if (to <= cap) return { kind: "ok" };
  p[capKey] = to;
  return { kind: "raised", from: cap, to, estimatedPromptTokens };
}

export function resolveConfiguredModelId(configured: string | undefined, defaultModelId?: string): string {
  for (const candidate of [configured, defaultModelId]) {
    if (!candidate) continue;
    if (resolveModel(candidate)) return candidate;
    swallow("pi: configured model id not in registry, falling back to default", new Error(candidate));
  }
  return DEFAULT_AGENT_MODEL_ID;
}

export function withRequestHeaders(model: Model<Api>, direct: boolean, fast: boolean, apiKey?: string): Model<Api> {
  const api = String((model as { api?: unknown }).api ?? "").toLowerCase();
  if (api.startsWith("openai") || !direct) return model;
  const betas = [...(thinkingBindingApplies(model) ? [THINKING_BINDING_BETA] : []), ...(fast ? [FAST_MODE_BETA] : [])];
  if (!betas.length) return model;
  const prior = model.headers?.["anthropic-beta"];
  const beta = [
    ...new Set([
      ...claudeSubscriptionBetas(apiKey),
      ...(prior ? prior.split(",").map((value) => value.trim()) : []),
      ...betas,
    ]),
  ].join(",");
  return { ...model, headers: { ...model.headers, "anthropic-beta": beta } };
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
  // Normalize UI aliases before Pi clamps to the model's declared capabilities.
  // Mutating thinkingLevelMap would enable efforts the provider explicitly excludes.
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

export function lastInputTokens(session: AssistantTextSession, failed: AssistantMessage): number | undefined {
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

/** Codes that retry the turn on the configured fallback model. */

export function messagesSince(session: AssistantTextSession, messagesBefore?: number): AssistantTextSession {
  return messagesBefore === undefined
    ? session
    : ({ messages: session.messages.slice(messagesBefore) } as AssistantTextSession);
}

export function piRoundFailed(session: AssistantTextSession, messagesBefore: number): boolean {
  return !!piFailedAssistant(messagesSince(session, messagesBefore));
}

export type AssistantTextSession = Pick<AgentSession, "getLastAssistantText" | "messages">;

export function piUsageToCallUsage(
  u: Partial<Usage> | undefined,
  model: Model<Api> | undefined,
  fast: boolean | undefined,
  servedTier: string | undefined,
): LlmCallUsage | null {
  if (!u) return null;
  const row: LlmCallUsage = {
    input: u.input ?? 0,
    output: u.output ?? 0,
    cacheRead: u.cacheRead ?? 0,
    cacheWrite: u.cacheWrite ?? 0,
    totalTokens: u.totalTokens ?? 0,
    costUsd: u.cost?.total ?? 0,
  };
  const card = model?.cost ? servedTierCard(model, fast, servedTier) : undefined;
  if (!card) return row;
  const priced: Usage = {
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    ...(typeof u.cacheWrite1h === "number" ? { cacheWrite1h: Math.min(u.cacheWrite1h, row.cacheWrite) } : {}),
    totalTokens: row.totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  row.costUsd = calculateCost(card, priced).total;
  return row;
}

export function servedTierCard(
  model: Model<Api>,
  fast: boolean | undefined,
  servedTier: string | undefined,
): Model<Api> | undefined {
  const request = modelRequestOverrides(model.id);
  if (request && servedTier && servedTier !== request.service_tier) {
    const base = resolveModel(request.model);
    return base?.cost
      ? ({ ...base, cost: scaleCost(base.cost, getServiceTierCostMultiplier(base, servedTier)) } as Model<Api>)
      : undefined;
  }
  return fast && !servedTier
    ? ({ ...model, cost: scaleCost(model.cost, FAST_COST_MULTIPLIER) } as Model<Api>)
    : undefined;
}

export function stableCwd(prefix: string): string {
  return join(tmpdir(), `${prefix}-cwd`);
}
