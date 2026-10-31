import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  calculateCost,
  InMemoryCredentialStore,
  type Api,
  type Context,
  type Model,
  type ModelsApiStreamOptions,
  type ModelsSimpleStreamOptions,
  type ProviderHeaders,
  type Usage,
} from "@earendil-works/pi-ai";
import { getServiceTierCostMultiplier } from "@earendil-works/pi-ai/api/openai-responses";
import type { LlmCallUsage } from "../sessions/session-store.ts";
import { claudeSubscriptionBetas } from "./claude-subscription.ts";
import { gatewayModelsJson, gatewayModelsVersion } from "./gateway-models.ts";
import {
  customModelsJson,
  customProvidersVersion,
  hasCustomModelPrefix,
  resolveCustomModel,
} from "./custom-providers.ts";
import {
  GatewayModelUnavailableError,
  ModelUnavailableError,
  modelGatewayRequest,
  type ModelGatewayTransportConfig,
} from "./provider-endpoints.ts";
import {
  CODEX_SUBSCRIPTION_PROVIDER,
  codexProviderModelId,
  modelRequestOverrides,
  modelSupportsFastMode,
  resolveModel,
} from "./pi-models.ts";
import { providerTurnError } from "./provider-error.ts";

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

function servedTierCard(
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

export interface ProviderKeys {
  anthropic?: string;
  openai?: string;
  openrouter?: string;
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

export function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
