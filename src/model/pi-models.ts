import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai";

const getModel = getBuiltinModel as unknown as (provider: string, id: string) => Model<Api> | undefined;

export const DEFAULT_AGENT_MODEL_ID = "claude-opus-5";
export const DEFAULT_CODEX_MODEL_ID = "gpt-5.6-sol";
export const THINKING_LEVELS = ["auto", "low", "medium", "high", "xhigh", "max", "ultracode"] as const;
export const HARNESS_IDS = ["pi", "opencode", "codex", "claude", "mock"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const MODEL_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export function isModelProvider(value: unknown): value is ModelProvider {
  return typeof value === "string" && (MODEL_PROVIDERS as readonly string[]).includes(value);
}

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === "string" && (HARNESS_IDS as readonly string[]).includes(value);
}

type PiModel = Model<Api>;

interface ModelEntry {
  id: string;
  name: string;
  fastMode: boolean;
  webui: boolean;
  base: boolean;
  auxiliary?: boolean;
  clone?: {
    template: string;
    input: number;
    output: number;
    cacheWrite?: number;
    contextWindow: number;
    maxTokens: number;
  };
}

const GPT_56_CLONE = { template: "gpt-5.5", contextWindow: 1_050_000, maxTokens: 128_000 } as const;

export const MODEL_REGISTRY: readonly ModelEntry[] = [
  { id: "claude-fable-5", name: "Claude Fable 5", fastMode: false, webui: true, base: true },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    fastMode: true,
    webui: true,
    base: true,
    clone: {
      template: "claude-opus-4-8",
      input: 5,
      output: 25,
      cacheWrite: 6.25,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
  },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", fastMode: true, webui: true, base: true },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", fastMode: false, webui: true, base: true },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", fastMode: false, webui: true, base: true, auxiliary: true },
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    fastMode: false,
    webui: true,
    base: true,
    clone: { ...GPT_56_CLONE, input: 5, output: 30 },
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    fastMode: false,
    webui: true,
    base: true,
    clone: { ...GPT_56_CLONE, input: 2.5, output: 15 },
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    fastMode: false,
    webui: true,
    base: true,
    auxiliary: true,
    clone: { ...GPT_56_CLONE, input: 1, output: 6 },
  },
  { id: "openrouter/auto", name: "OpenRouter Auto", fastMode: false, webui: true, base: true },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", fastMode: true, webui: false, base: false },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", fastMode: true, webui: false, base: false },
];

const REGISTRY_BY_ID = new Map(MODEL_REGISTRY.map((m) => [m.id, m]));

export function modelDisplayName(id: string): string {
  return REGISTRY_BY_ID.get(id)?.name ?? id;
}

export const DEFAULT_WEBUI_MODEL_IDS: readonly string[] = MODEL_REGISTRY.filter((m) => m.webui).map((m) => m.id);

export const SELECTABLE_BASE_MODELS: ReadonlyArray<{ id: string; name: string }> = MODEL_REGISTRY.filter(
  (m) => m.base,
).map((m) => ({ id: m.id, name: m.name }));

function builtinModel(id: string): PiModel | undefined {
  for (const provider of MODEL_PROVIDERS) {
    const m = getModel(provider, id);
    if (m) return m;
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
    cost: { ...model.cost, ...overrides.cost },
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
    ...(model.compat ? { compat: { ...(model.compat as Record<string, unknown>) } as PiModel["compat"] } : {}),
  };
}

export function resolveModel(id: string): PiModel | undefined {
  const entry = REGISTRY_BY_ID.get(id);
  if (entry?.clone) {
    const template = builtinModel(entry.clone.template);
    return template
      ? cloneModel(template, id, entry.name, {
          contextWindow: entry.clone.contextWindow,
          maxTokens: entry.clone.maxTokens,
          cost: {
            input: entry.clone.input,
            output: entry.clone.output,
            cacheRead: entry.clone.input / 10,
            cacheWrite: entry.clone.cacheWrite ?? 0,
          },
        })
      : undefined;
  }
  return builtinModel(id);
}

export function auxiliaryModelForProvider(provider: string): string | undefined {
  return MODEL_REGISTRY.find((m) => m.auxiliary && resolveModel(m.id)?.provider === provider)?.id;
}

export function auxiliaryModelFor(baseModelId: string): string {
  const provider = resolveModel(baseModelId)?.provider;
  if (!provider) return baseModelId;
  return auxiliaryModelForProvider(provider) ?? baseModelId;
}

const CONTEXT_BUDGET_FRACTION = 0.5;

export function contextTokenBudgetForModel(id: string): number | undefined {
  const model = resolveModel(id);
  const window = model?.contextWindow;
  const output = model?.maxTokens;
  if (typeof window !== "number" || window <= 0 || typeof output !== "number" || output <= 0 || output >= window)
    return undefined;
  return Math.floor((window - output) * CONTEXT_BUDGET_FRACTION);
}

export function modelSupportedByHarness(id: string | undefined, harness: string): boolean {
  if (!id) return false;
  if (harness === "pi" || harness === "opencode" || harness === "mock") return Boolean(resolveModel(id));
  const provider = resolveModel(id)?.provider;
  if (harness === "claude") return provider === "anthropic" || /^claude-/i.test(id);
  if (harness === "codex") return provider === "openai" || /^(?:gpt-|o\d|codex|openai\/)/i.test(id);
  return false;
}

export function defaultModelForHarness(
  harness: string,
  configured?: string,
  providers?: ModelProviderAvailability,
): string {
  if (configured && modelSupportedByHarness(configured, harness)) return configured;
  const preferred = harness === "codex" ? DEFAULT_CODEX_MODEL_ID : DEFAULT_AGENT_MODEL_ID;
  if (!providers || modelServiceable(preferred, providers)) return preferred;
  const servable = SELECTABLE_BASE_MODELS.find(
    (model) => modelSupportedByHarness(model.id, harness) && modelServiceable(model.id, providers),
  );
  return servable?.id ?? preferred;
}

export interface ModelProviderAvailability {
  anthropic: boolean;
  openai: boolean;
  openrouter: boolean;
}

export function modelServiceable(id: string, providers: ModelProviderAvailability): boolean {
  const provider = resolveModel(id)?.provider;
  if (!provider) return false;
  if (provider === "openai") return providers.openai;
  if (provider === "anthropic") return providers.anthropic;
  if (provider === "openrouter") return providers.openrouter;
  return true;
}

export function serviceableModelIds(ids: readonly string[], providers: ModelProviderAvailability): string[] {
  return ids.filter((id) => modelServiceable(id, providers));
}

export const ALL_PROVIDERS_AVAILABLE: ModelProviderAvailability = { anthropic: true, openai: true, openrouter: true };

export function modelProviderAvailabilityFor(
  harness: string,
  configKeys: ModelProviderAvailability,
  managedKeys: ModelProviderAvailability = configKeys,
): ModelProviderAvailability {
  if (harness === "pi") return managedKeys;
  if (harness === "opencode") return { ...configKeys, openrouter: false };
  if (harness === "codex") return configKeys;
  return ALL_PROVIDERS_AVAILABLE;
}

export function onlyProvider(provider: ModelProvider): ModelProviderAvailability {
  return { anthropic: false, openai: false, openrouter: false, [provider]: true };
}

export function defaultModelForProvider(harness: string, provider: ModelProvider): string | undefined {
  const only = onlyProvider(provider);
  if (!modelProviderAvailabilityFor(harness, only)[provider]) return undefined;
  const model = defaultModelForHarness(harness, undefined, only);
  return modelSupportedByHarness(model, harness) && modelServiceable(model, only) ? model : undefined;
}

export function getRequiredModel(id: string): PiModel {
  const model = resolveModel(id);
  if (!model) throw new Error(`Unsupported model: ${id}`);
  return model;
}

export function modelSupportsFastMode(modelId: string | undefined): boolean {
  return !!modelId && (REGISTRY_BY_ID.get(modelId)?.fastMode ?? false);
}

export const FAST_MODE_MODEL_IDS: readonly string[] = MODEL_REGISTRY.filter((m) => m.fastMode).map((m) => m.id);

export function defaultInteractiveThinkingLevel(model: Pick<PiModel, "api" | "provider">): string {
  const provider = String(model.provider ?? model.api ?? "").toLowerCase();
  return provider.includes("anthropic") ? "low" : "auto";
}

export const DEFAULT_AGENT_INPUT_USD_PER_MTOK = 5;
