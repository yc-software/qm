import { gatewayModelsJson, gatewayModelsVersion } from "../model/gateway-models.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, type AgentSession } from "@earendil-works/pi-coding-agent";
import {
  clampThinkingLevel,
  InMemoryCredentialStore,
  retryAssistantCall,
  type Api,
  type Context,
  type Model,
  type ModelThinkingLevel,
  type ModelsApiStreamOptions,
  type ModelsSimpleStreamOptions,
  type ProviderHeaders,
} from "@earendil-works/pi-ai";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import { providerTurnError } from "./provider-error.ts";
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
import { perTenant } from "../tenant.ts";

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

export interface ProviderKeys {
  anthropic?: string;
  openai?: string;
  openrouter?: string;
  [provider: string]: string | undefined;
}

const customModelsFile = perTenant((): { version: number; path: string | null } => ({ version: -1, path: null }));
function customModelsPath(): string | null {
  const cached = customModelsFile();
  const version = customProvidersVersion() + gatewayModelsVersion();
  if (cached.version === version) return cached.path;
  const providers = { ...customModelsJson()?.providers, ...gatewayModelsJson() };
  const custom = Object.keys(providers).length ? { providers } : undefined;
  let path: string | null = null;
  if (custom) {
    path = join(mkdtempSync(join(tmpdir(), "pi-custom-models-")), "models.json");
    writeFileSync(path, JSON.stringify(custom));
  }
  cached.version = version;
  cached.path = path;
  return path;
}

export async function buildModelRuntime(
  keys: ProviderKeys,
  modelGateway?: ModelGatewayTransportConfig,
  cacheRetention?: "long",
): Promise<ModelRuntime> {
  await modelGateway?.refresh?.();
  const { [CODEX_SUBSCRIPTION_PROVIDER]: subscriptionToken, ...apiKeys } = keys;
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
      const candidate = withSubscriptionBetas(withRequestHeaders(model, true, false), apiKeys[String(model.provider)]);
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

const ONE_SHOT_RETRY = { enabled: true, maxRetries: 3, baseDelayMs: 2_000 };

export async function complete(
  model: Model<Api>,
  keys: ProviderKeys,
  systemPrompt: string,
  prompt: string,
  opts?: {
    signal?: AbortSignal;
    modelGateway?: ModelGatewayTransportConfig;
    thinkingLevel?: ModelThinkingLevel;
    maxTokens?: number;
    retry?: false;
  },
): Promise<string | undefined> {
  if (opts?.signal?.aborted) return undefined;
  const runtime = await buildModelRuntime(keys, opts?.modelGateway);
  const reasoning = clampThinkingLevel(model, opts?.thinkingLevel ?? "medium");
  const context: Context = { systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] };
  const message = await retryAssistantCall(
    () =>
      runtime.completeSimple(model, context, {
        ...(opts?.signal ? { signal: opts.signal } : {}),
        ...(reasoning !== "off" ? { reasoning } : {}),
        ...(opts?.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      }),
    opts?.retry === false ? undefined : ONE_SHOT_RETRY,
    opts?.signal,
  );
  if (message.stopReason === "error") {
    const contextWindow = (resolveModel(message.model) as { contextWindow?: number } | undefined)?.contextWindow;
    throw providerTurnError(message, { contextWindow, lastInputTokens: undefined });
  }
  if (message.stopReason === "aborted" && message.content.length === 0) return undefined;
  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  return text.trim() || undefined;
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

export function resolveConfiguredModelId(configured: string | undefined, defaultModelId?: string): string {
  for (const candidate of [configured, defaultModelId]) {
    if (!candidate) continue;
    if (resolveModel(candidate)) return candidate;
    swallow("pi: configured model id not in registry, falling back to default", new Error(candidate));
  }
  return DEFAULT_AGENT_MODEL_ID;
}

const CLAUDE_SUBSCRIPTION_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];

function withAnthropicBetas(model: Model<Api>, before: readonly string[], after: readonly string[] = []): Model<Api> {
  const prior = model.headers?.["anthropic-beta"]?.split(",").map((value) => value.trim()) ?? [];
  const beta = [...new Set([...before, ...prior, ...after])].join(",");
  return { ...model, headers: { ...model.headers, "anthropic-beta": beta } };
}

function withSubscriptionBetas(model: Model<Api>, apiKey: string | undefined): Model<Api> {
  if (!model.headers?.["anthropic-beta"] || !apiKey?.includes("sk-ant-oat")) return model;
  return withAnthropicBetas(model, CLAUDE_SUBSCRIPTION_BETAS);
}

export function withRequestHeaders(model: Model<Api>, direct: boolean, fast: boolean): Model<Api> {
  const api = String((model as { api?: unknown }).api ?? "").toLowerCase();
  if (api.startsWith("openai") || !direct) return model;
  const betas = [...(thinkingBindingApplies(model) ? [THINKING_BINDING_BETA] : []), ...(fast ? [FAST_MODE_BETA] : [])];
  return betas.length ? withAnthropicBetas(model, [], betas) : model;
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
