import {
  resolveGatewayEmbeddingModel,
  gatewayEmbeddingModelIds,
  gatewayModelCatalog,
  gatewayModelsVersion,
  isGatewayModelId,
  resolveGatewayModel,
} from "./gateway-models.ts";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  isEmbeddingModel,
  overlayModel,
  overlayModels,
  overlaysVersion,
  overlayUnavailableReason,
  type EmbeddingModel,
  type EmbeddingModelDefinition,
  type ModelOverlay,
} from "./model-overlay.ts";
import { MODEL_REGISTRY, type ModelEntry } from "./model-registry.ts";
import { providerBaseUrl } from "./provider-endpoints.ts";
import { type CustomRuntimeModel, isCustomModelId, resolveCustomModel } from "./custom-providers.ts";

const getModel = getBuiltinModel as unknown as (provider: string, id: string) => Model<Api> | undefined;

export const DEFAULT_AGENT_MODEL_ID = "claude-opus-5";
export const DEFAULT_CODEX_MODEL_ID = "gpt-6.1-sol";
const PROVIDER_DEFAULT_MODEL_IDS = [DEFAULT_AGENT_MODEL_ID, DEFAULT_CODEX_MODEL_ID, "openrouter/auto"];
export const CODEX_SUBSCRIPTION_PROVIDER = "openai-codex";
const CODEX_SUBSCRIPTION_PREFIX = "codex/";

export function codexSubscriptionModelId(id: string): string {
  return id.startsWith(CODEX_SUBSCRIPTION_PREFIX) ? id : CODEX_SUBSCRIPTION_PREFIX + id;
}
export function codexProviderModelId(id: string): string {
  return id.startsWith(CODEX_SUBSCRIPTION_PREFIX) ? id.slice(CODEX_SUBSCRIPTION_PREFIX.length) : id;
}
export const THINKING_LEVELS = [
  "auto",
  "default",
  "adaptive",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
] as const;

export function modelSupportsAdaptiveThinking(model: Pick<Model<Api>, "api" | "reasoning" | "compat">): boolean {
  return (
    model.api === "anthropic-messages" &&
    model.reasoning &&
    (model.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking === true
  );
}

export function modelSupportsProviderDefault(model: Pick<Model<Api>, "api" | "compat">): boolean {
  return (
    ["anthropic-messages", "openai-responses", "openai-codex-responses"].includes(model.api) ||
    (model.api === "openai-completions" &&
      (model.compat as { thinkingFormat?: string } | undefined)?.thinkingFormat === "openai")
  );
}

export function thinkingLevelsFor(modelId?: string): readonly string[] {
  const model = modelId ? resolveModel(modelId) : undefined;
  return THINKING_LEVELS.filter((level) => {
    if (level === "adaptive") return !modelId || (!!model && modelSupportsAdaptiveThinking(model));
    if (level === "default") return !modelId || (!!model && modelSupportsProviderDefault(model));
    return true;
  });
}
export const MODEL_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export function isModelProvider(value: unknown): value is ModelProvider {
  return typeof value === "string" && (MODEL_PROVIDERS as readonly string[]).includes(value);
}

type PiModel = Model<Api>;

export function modelOverlayVersion(): number {
  return overlaysVersion() + gatewayModelsVersion();
}

export function isOverlayModel(id: string): boolean {
  return overlayModel(id) !== undefined;
}

export function modelOfferedInWebui(id: string): boolean {
  const model = overlayModel(id);
  return model && isEmbeddingModel(model) ? false : (model?.webui ?? true);
}

export function modelUnavailableReason(id: string): string | undefined {
  if (isGatewayModelId(id) && !resolveGatewayModel(id) && !resolveGatewayEmbeddingModel(id))
    return "Gateway model is unavailable; select another model or retry after discovery recovers";
  return overlayUnavailableReason(id);
}

export function catalogModelIdTaken(id: string): boolean {
  return REGISTRY_BY_ID.has(id) || Boolean(builtinModel(id)) || OPENROUTER_CATALOG_MODELS.has(id);
}

export function modelIdReserved(id: string): boolean {
  return (
    isGatewayModelId(id) ||
    id.startsWith(CODEX_SUBSCRIPTION_PREFIX) ||
    catalogModelIdTaken(id) ||
    overlayModel(id) !== undefined ||
    overlayUnavailableReason(id) !== undefined
  );
}

function chatOverlays(): ModelOverlay[] {
  return overlayModels().filter((model): model is ModelOverlay => !isEmbeddingModel(model));
}

export function selectableBaseModels(includeAliased = false): ReadonlyArray<{ id: string; name: string }> {
  return [
    ...gatewayModelCatalog(includeAliased),
    ...SELECTABLE_BASE_MODELS.filter(({ id }) => resolveModel(id)),
    ...chatOverlays()
      .filter((m) => m.base)
      .map(({ id, name }) => ({ id, name })),
  ];
}

export function overlayModelCatalog(): Array<{ id: string; name: string; provider: string }> {
  return chatOverlays()
    .filter((m) => m.base || m.webui)
    .map(({ id, name, provider }) => ({ id, name, provider }));
}

export function defaultWebuiModelIds(): readonly string[] {
  return [
    ...DEFAULT_WEBUI_MODEL_IDS,
    ...gatewayModelCatalog(true).map((m) => m.id),
    ...chatOverlays()
      .filter((m) => m.webui)
      .map((m) => m.id),
  ];
}

export function fastModeModelIds(): readonly string[] {
  return [
    ...FAST_MODE_MODEL_IDS.filter(modelSupportsFastMode),
    ...chatOverlays()
      .filter((m) => modelSupportsFastMode(m.id))
      .map((m) => m.id),
  ];
}

const REGISTRY_BY_ID = new Map(MODEL_REGISTRY.map((m) => [m.id, m]));
const OPENROUTER_CATALOG_MODELS = new Map<string, PiModel>();

export function modelDisplayName(id: string): string {
  return overlayModel(id)?.name ?? REGISTRY_BY_ID.get(id)?.name ?? OPENROUTER_CATALOG_MODELS.get(id)?.name ?? id;
}

export const DEFAULT_WEBUI_MODEL_IDS: readonly string[] = MODEL_REGISTRY.filter((m) => m.webui).map((m) => m.id);

export const SELECTABLE_BASE_MODELS: ReadonlyArray<{ id: string; name: string }> = MODEL_REGISTRY.filter(
  (m) => m.base,
).map((m) => ({ id: m.id, name: m.name }));

function builtinModel(id: string): PiModel | undefined {
  for (const provider of MODEL_PROVIDERS) {
    const m = getModel(provider, id);
    if (!m) continue;
    return m;
  }
  return undefined;
}

function cloneModel(model: PiModel, id: string, name: string, overrides: Partial<PiModel> = {}): PiModel {
  return {
    ...model,
    ...overrides,
    id,
    name,
    input: [...model.input],
    cost: structuredClone(overrides.cost ?? model.cost),
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.thinkingLevelMap || overrides.thinkingLevelMap
      ? { thinkingLevelMap: { ...model.thinkingLevelMap, ...overrides.thinkingLevelMap } }
      : {}),
    ...(model.compat ? { compat: { ...(model.compat as Record<string, unknown>) } as PiModel["compat"] } : {}),
  };
}

interface OpenRouterCatalogModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: ("text" | "image")[];
  reasoning: boolean;
  cost: { input: number; output: number };
}

export function registerOpenRouterCatalogModel(definition: OpenRouterCatalogModel): PiModel | undefined {
  if (modelIdReserved(definition.id) && resolveModel(definition.id)?.provider !== "openrouter") return undefined;
  if (isCustomModelId(definition.id)) return undefined;
  const template = builtinModel("openrouter/auto");
  if (!template) return undefined;
  const model = cloneModel(template, definition.id, definition.name, {
    contextWindow: definition.contextWindow,
    maxTokens: definition.maxTokens,
    reasoning: definition.reasoning,
    cost: {
      input: definition.cost.input,
      output: definition.cost.output,
      cacheRead: 0,
      cacheWrite: 0,
    },
  });
  model.input = [...definition.input];
  OPENROUTER_CATALOG_MODELS.set(model.id, model);
  return model;
}

export function modelRequestOverrides(id: string): ModelEntry["request"] {
  const request = REGISTRY_BY_ID.get(id)?.request;
  return request ? { ...request } : undefined;
}

export function resolveBuiltinModel(id: string): PiModel | undefined {
  if (id.startsWith(CODEX_SUBSCRIPTION_PREFIX)) {
    const providerId = codexProviderModelId(id);
    if (modelRequestOverrides(providerId)) return undefined;
    const m = getModel(CODEX_SUBSCRIPTION_PROVIDER, providerId);
    if (m) return { ...m, id };
    const entry = REGISTRY_BY_ID.get(providerId);
    const template = entry?.clone ? getModel(CODEX_SUBSCRIPTION_PROVIDER, entry.clone.template) : undefined;
    const native = entry?.clone ? resolveBuiltinModel(providerId) : undefined;
    if (!template || !native || native.provider !== "openai") return undefined;
    return cloneModel(template, id, native.name, {
      contextWindow: native.contextWindow,
      maxTokens: native.maxTokens,
      cost: native.cost,
      ...(native.thinkingLevelMap ? { thinkingLevelMap: native.thinkingLevelMap } : {}),
    });
  }
  const entry = REGISTRY_BY_ID.get(id);
  if (entry?.clone) {
    const template = builtinModel(entry.clone.template);
    return template
      ? cloneModel(template, id, entry.name, {
          contextWindow: entry.clone.contextWindow,
          maxTokens: entry.clone.maxTokens,
          ...(entry.clone.thinkingLevelMap ? { thinkingLevelMap: entry.clone.thinkingLevelMap } : {}),
          cost: {
            input: entry.clone.input,
            output: entry.clone.output,
            cacheRead: entry.clone.cacheRead ?? entry.clone.input / 10,
            cacheWrite: entry.clone.cacheWrite ?? 0,

            tiers: entry.clone.tiers ? entry.clone.tiers.map((t) => ({ ...t })) : undefined,
          },
        })
      : undefined;
  }
  return builtinModel(id);
}

function resolveBaseModel(id: string): PiModel | undefined {
  if (isGatewayModelId(id)) return resolveGatewayModel(id);
  if (overlayUnavailableReason(id) !== undefined) return undefined;
  const builtin = resolveBuiltinModel(id);
  if (builtin) return builtin;
  const overlay = overlayModel(id);
  if (overlay && !isEmbeddingModel(overlay)) {
    return modelFromOverlay(overlay, false);
  }
  const custom = resolveCustomModel(id);
  return custom ? customPiModel(custom) : OPENROUTER_CATALOG_MODELS.get(id);
}

function customPiModel(custom: CustomRuntimeModel): PiModel {
  const model = custom as unknown as PiModel;
  if (model.api !== "anthropic-messages") return model;
  const known = resolveBuiltinModel(custom.upstreamId);
  if (known?.api !== "anthropic-messages" || !modelSupportsAdaptiveThinking(known)) return model;
  return {
    ...model,
    compat: { forceAdaptiveThinking: true },
    ...(known.thinkingLevelMap ? { thinkingLevelMap: known.thinkingLevelMap } : {}),
  };
}

export function modelFromOverlay(spec: ModelOverlay, useOrgEndpoints = true): PiModel | undefined {
  const template = resolveBuiltinModel(spec.template);
  if (!template || template.provider !== spec.provider) return undefined;
  const model = cloneModel(template, spec.id, spec.name, {
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
    cost: structuredClone(spec.cost),
  });
  const override = useOrgEndpoints ? providerBaseUrl(spec.provider) : undefined;
  return override ? { ...model, baseUrl: override } : model;
}

export function resolveModel(id: string, useOrgEndpoints = true): PiModel | undefined {
  const model = resolveBaseModel(id);
  if (!model || !useOrgEndpoints) return model;
  const override = providerBaseUrl(String(model.provider));
  return override ? { ...model, baseUrl: override } : model;
}

export function auxiliaryModelForProvider(provider: string): string | undefined {
  return [...MODEL_REGISTRY, ...overlayModels()].find(
    (m) => !isEmbeddingModel(m) && m.auxiliary && resolveModel(m.id)?.provider === provider,
  )?.id;
}

export function auxiliaryModelFor(baseModelId: string): string {
  const provider = resolveModel(baseModelId)?.provider;
  if (!provider) return baseModelId;
  return auxiliaryModelForProvider(provider) ?? baseModelId;
}

const CONTEXT_BUDGET_FRACTION = 0.5;
const CONTEXT_BUDGET_CAP_TOKENS = 150_000;

export function contextTokenBudgetForModel(id: string): number | undefined {
  const model = resolveModel(id);
  const window = model?.contextWindow;
  const output = model?.maxTokens;
  if (typeof window !== "number" || window <= 0 || typeof output !== "number" || output <= 0 || output >= window)
    return undefined;
  return Math.min(CONTEXT_BUDGET_CAP_TOKENS, Math.floor((window - output) * CONTEXT_BUDGET_FRACTION));
}

export function modelHasPrices(model: Pick<Model<Api>, "cost">): boolean {
  return model.cost.input > 0 || model.cost.output > 0;
}

export function modelSupported(id: string | undefined): boolean {
  if (id && modelRequestOverrides(id)) return true;
  if (id && isGatewayModelId(id)) return Boolean(resolveGatewayModel(id));
  if (!id || overlayUnavailableReason(id) !== undefined) return false;
  const overlay = overlayModel(id);
  if (overlay) return !isEmbeddingModel(overlay);
  if (isCustomModelId(id) && !REGISTRY_BY_ID.has(id)) return true;
  return Boolean(resolveModel(id));
}

export function defaultModel(configured?: string, providers?: ModelProviderAvailability): string {
  if (configured && (modelUnavailableReason(configured) || modelSupported(configured))) return configured;
  if (!providers) return DEFAULT_AGENT_MODEL_ID;
  const billable = (id: string) => modelSupported(id) && modelServiceable(id, providers);
  return (
    PROVIDER_DEFAULT_MODEL_IDS.find(billable) ??
    selectableBaseModels(true)
      .map((model) => model.id)
      .find(billable) ??
    DEFAULT_AGENT_MODEL_ID
  );
}

export interface ModelProviderAvailability {
  anthropic: boolean;
  openai: boolean;
  openrouter: boolean;
  modelIds?: ReadonlySet<string>;
  codexOAuth?: boolean;
}

export function modelServiceable(id: string, providers: ModelProviderAvailability): boolean {
  if (isGatewayModelId(id)) return Boolean(resolveGatewayModel(id) && providers.modelIds?.has(id));
  const provider = resolveModel(id)?.provider;
  if (!provider) return false;
  if (isCustomModelId(id) && !REGISTRY_BY_ID.has(id)) return true;
  if (providers.modelIds?.has(id)) return true;
  if (provider === "openai")
    return (
      providers.openai ||
      (providers.codexOAuth === true &&
        resolveModel(codexSubscriptionModelId(id))?.provider === CODEX_SUBSCRIPTION_PROVIDER)
    );
  if (provider === CODEX_SUBSCRIPTION_PROVIDER) return providers.codexOAuth === true;
  if (provider === "anthropic") return providers.anthropic;
  if (provider === "openrouter") return providers.openrouter;
  return true;
}

export function serviceableModelIds(ids: readonly string[], providers: ModelProviderAvailability): string[] {
  return ids.filter((id) => modelServiceable(id, providers));
}

export const ALL_PROVIDERS_AVAILABLE: ModelProviderAvailability = {
  anthropic: true,
  openai: true,
  openrouter: true,
  codexOAuth: true,
};

export function onlyProvider(provider: ModelProvider): ModelProviderAvailability {
  return { anthropic: false, openai: false, openrouter: false, [provider]: true };
}

export function defaultModelForProvider(provider: ModelProvider): string | undefined {
  const only = onlyProvider(provider);
  const model = defaultModel(undefined, only);
  return modelSupported(model) && modelServiceable(model, only) ? model : undefined;
}

export function getRequiredModel(id: string, useOrgEndpoints = true): PiModel {
  const model = resolveModel(id, useOrgEndpoints);
  if (!model) throw new Error(`Unsupported model: ${id}`);
  return model;
}

export function modelSupportsFastMode(modelId: string | undefined): boolean {
  if (!modelId) return false;
  if (overlayUnavailableReason(modelId) !== undefined) return false;
  const overlay = overlayModel(modelId);
  return (
    (overlay && !isEmbeddingModel(overlay) ? overlay.fastMode : undefined) ??
    REGISTRY_BY_ID.get(modelId)?.fastMode ??
    false
  );
}

export const FAST_MODE_MODEL_IDS: readonly string[] = MODEL_REGISTRY.filter((m) => m.fastMode).map((m) => m.id);

export function defaultInteractiveThinkingLevel(model: Pick<PiModel, "api" | "provider">): string {
  const provider = String(model.provider ?? model.api ?? "").toLowerCase();
  return provider.includes("anthropic") ? "low" : "auto";
}

export const DEFAULT_AGENT_INPUT_USD_PER_MTOK = 5;

export function safeModelMetadata(id: string) {
  const model = resolveModel(id);
  if (!model) return undefined;
  const entry = REGISTRY_BY_ID.get(id);
  const name = modelDisplayName(id) === id ? model.name : modelDisplayName(id);
  const label = entry ? name.replace(/^Claude /, "") : name;
  const buttonLabel = entry?.buttonLabel ?? label;
  return {
    id,
    name,
    label,
    buttonLabel,
    provider: String(model.provider),
    api: model.api,
    reasoning: model.reasoning,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: structuredClone(model.cost),
    fastMode: modelSupportsFastMode(id),
    effortLevels: thinkingLevelsFor(id),
  };
}

export function modelCatalogFor(ids: Iterable<string>) {
  return Object.fromEntries(
    [...new Set(ids)].flatMap((id) => {
      const metadata = safeModelMetadata(id);
      return metadata ? [[id, metadata]] : [];
    }),
  );
}

export function embeddingModelFromDefinition(model: EmbeddingModelDefinition): EmbeddingModel {
  return { ...model, baseUrl: providerBaseUrl(model.provider) ?? "https://api.openai.com/v1" };
}

export function resolveEmbeddingModel(id: string): EmbeddingModel | undefined {
  if (overlayUnavailableReason(id) !== undefined) return undefined;
  const gateway = resolveGatewayEmbeddingModel(id);
  if (gateway) return gateway;
  const model = overlayModel(id);
  return model && isEmbeddingModel(model) ? embeddingModelFromDefinition(model) : undefined;
}

export function embeddingModelCatalog(): Array<Omit<EmbeddingModel, "baseUrl">> {
  return [...overlayModels().map((model) => model.id), ...gatewayEmbeddingModelIds()].flatMap((id) => {
    const model = resolveEmbeddingModel(id);
    return model ? [{ kind: model.kind, id: model.id, name: model.name, provider: model.provider }] : [];
  });
}
