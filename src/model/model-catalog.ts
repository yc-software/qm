import { gatewayModelCatalog } from "./gateway-models.ts";
import {
  modelSupported,
  registerOpenRouterCatalogModel,
  resolveModel,
  selectableBaseModels,
  overlayModelCatalog,
} from "./pi-models.ts";
import { customModelCatalog } from "./custom-providers.ts";
import { readBoundedText } from "../util/bytes.ts";

export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models?supported_parameters=tools&sort=most-popular";
const OPENROUTER_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:+-]*$/;

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;

interface CacheEntry {
  dynamic?: ModelCatalogEntry[];
  expiresAt: number;
  inFlight?: Promise<ModelCatalogEntry[]>;
}

const cache = new WeakMap<typeof fetch, CacheEntry>();

export function builtInModelCatalog(): ModelCatalogEntry[] {
  const builtIns = selectableBaseModels().flatMap((model) => {
    const provider = resolveModel(model.id)?.provider;
    return provider === "anthropic" || provider === "openai" || provider === "openrouter"
      ? [{ ...model, provider: provider as string }]
      : [];
  });
  const known = new Set(builtIns.map((model) => model.id));
  return [
    ...builtIns,
    ...[...overlayModelCatalog(), ...customModelCatalog(), ...gatewayModelCatalog()].filter(
      (model) => !known.has(model.id),
    ),
  ];
}

function finiteNumber(value: unknown): number | undefined {
  let parsed = Number.NaN;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "string") parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseOpenRouterModel(candidate: unknown): ModelCatalogEntry | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const raw = candidate as Record<string, unknown>;
  const id = raw.id;
  const name = raw.name;
  const supportedParameters = raw.supported_parameters;
  const contextWindow = finiteNumber(raw.context_length);
  const topProvider = raw.top_provider;
  const maxTokens =
    topProvider && typeof topProvider === "object"
      ? finiteNumber((topProvider as Record<string, unknown>).max_completion_tokens)
      : undefined;
  const pricing = raw.pricing;
  const promptPrice =
    pricing && typeof pricing === "object" ? finiteNumber((pricing as Record<string, unknown>).prompt) : undefined;
  const completionPrice =
    pricing && typeof pricing === "object" ? finiteNumber((pricing as Record<string, unknown>).completion) : undefined;
  const architecture = raw.architecture;
  const inputModalities =
    architecture && typeof architecture === "object"
      ? (architecture as Record<string, unknown>).input_modalities
      : undefined;
  if (
    typeof id !== "string" ||
    !OPENROUTER_MODEL_ID_RE.test(id) ||
    typeof name !== "string" ||
    name.length === 0 ||
    !Array.isArray(supportedParameters) ||
    !supportedParameters.includes("tools")
  )
    return undefined;
  const knownOpenRouter = resolveModel(id)?.provider === "openrouter";
  const inputPrice = promptPrice === undefined ? undefined : promptPrice * 1_000_000;
  const outputPrice = completionPrice === undefined ? undefined : completionPrice * 1_000_000;
  if (
    contextWindow === undefined ||
    !Number.isSafeInteger(contextWindow) ||
    contextWindow <= 0 ||
    maxTokens === undefined ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens <= 0 ||
    maxTokens > contextWindow ||
    inputPrice === undefined ||
    !Number.isFinite(inputPrice) ||
    outputPrice === undefined ||
    !Number.isFinite(outputPrice) ||
    !Array.isArray(inputModalities) ||
    !inputModalities.includes("text")
  )
    return knownOpenRouter ? { id, name, provider: "openrouter" } : undefined;
  const registered = registerOpenRouterCatalogModel({
    id,
    name,
    contextWindow,
    maxTokens,
    input: inputModalities.includes("image") ? ["text", "image"] : ["text"],
    reasoning:
      supportedParameters.includes("reasoning") ||
      supportedParameters.includes("include_reasoning") ||
      supportedParameters.includes("reasoning_effort"),
    cost: { input: inputPrice, output: outputPrice },
  });
  return registered ? { id, name, provider: "openrouter" } : undefined;
}

async function fetchOpenRouterModels(fetcher: typeof fetch): Promise<ModelCatalogEntry[]> {
  const response = await fetcher(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`OpenRouter catalog returned ${response.status}`);
  const body = JSON.parse(
    await readBoundedText(response, MAX_CATALOG_BYTES, () => new Error("OpenRouter catalog is too large")),
  ) as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error("OpenRouter catalog is invalid");
  return body.data.flatMap((candidate) => {
    const model = parseOpenRouterModel(candidate);
    return model ? [model] : [];
  });
}

function withBuiltIns(dynamic: readonly ModelCatalogEntry[]): ModelCatalogEntry[] {
  const models = builtInModelCatalog();
  const known = new Set(models.map((model) => model.id));
  return [...models, ...dynamic.filter((model) => !known.has(model.id))];
}

function openRouterModels(fetcher: typeof fetch): Promise<ModelCatalogEntry[]> {
  const entry = cache.get(fetcher) ?? { expiresAt: 0 };
  cache.set(fetcher, entry);
  if (entry.expiresAt > Date.now()) return Promise.resolve(entry.dynamic ?? []);
  entry.inFlight ??= fetchOpenRouterModels(fetcher)
    .then((dynamic) => {
      entry.dynamic = dynamic;
      entry.expiresAt = Date.now() + CACHE_TTL_MS;
      return dynamic;
    })
    .catch(() => {
      entry.expiresAt = Date.now() + FAILURE_TTL_MS;
      return entry.dynamic ?? [];
    })
    .finally(() => {
      delete entry.inFlight;
    });
  return entry.inFlight;
}

export async function selectableModelCatalog(fetcher: typeof fetch = fetch): Promise<ModelCatalogEntry[]> {
  return withBuiltIns(await openRouterModels(fetcher));
}

export function selectableCatalog(catalog: readonly ModelCatalogEntry[]): ModelCatalogEntry[] {
  return catalog.filter((model) => modelSupported(model.id));
}

export function cachedModelCatalog(fetcher: typeof fetch = fetch): {
  models: ModelCatalogEntry[];
  refreshing: boolean;
} {
  void openRouterModels(fetcher);
  const entry = cache.get(fetcher);
  return { models: withBuiltIns(entry?.dynamic ?? []), refreshing: !!entry?.inFlight };
}
