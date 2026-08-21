import {
  modelSupportedByHarness,
  registerOpenRouterCatalogModel,
  resolveModel,
  SELECTABLE_BASE_MODELS,
} from "./pi-models.ts";
import { customModelCatalog, customProvidersVersion } from "./custom-providers.ts";

export interface ModelCatalogEntry {
  id: string;
  name: string;
  /** A built-in provider or the slug of an admin-registered custom provider. */
  provider: string;
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models?supported_parameters=tools&sort=most-popular";
const OPENROUTER_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:+-]*$/;

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_MODELS = 1_000;
const CACHE_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;

interface CacheEntry {
  customVersion?: number;
  expiresAt: number;
  models: ModelCatalogEntry[];
  inFlight?: Promise<ModelCatalogEntry[]>;
}

const cache = new WeakMap<typeof fetch, CacheEntry>();

export function builtInModelCatalog(): ModelCatalogEntry[] {
  const builtIns = SELECTABLE_BASE_MODELS.flatMap((model) => {
    const provider = resolveModel(model.id)?.provider;
    return provider === "anthropic" || provider === "openai" || provider === "openrouter"
      ? [{ ...model, provider: provider as string }]
      : [];
  });
  const known = new Set(builtIns.map((model) => model.id));
  return [...builtIns, ...customModelCatalog().filter((model) => !known.has(model.id))];
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CATALOG_BYTES)
    throw new Error("OpenRouter catalog is too large");
  if (!response.body) throw new Error("OpenRouter catalog has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_CATALOG_BYTES) {
      await reader.cancel();
      throw new Error("OpenRouter catalog is too large");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as unknown;
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
    id.length > 200 ||
    !OPENROUTER_MODEL_ID_RE.test(id) ||
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 200 ||
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
  const body = (await boundedJson(response)) as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error("OpenRouter catalog is invalid");
  return body.data.slice(0, MAX_CATALOG_MODELS).flatMap((candidate) => {
    const model = parseOpenRouterModel(candidate);
    return model ? [model] : [];
  });
}

export async function selectableModelCatalog(fetcher: typeof fetch = fetch): Promise<ModelCatalogEntry[]> {
  const now = Date.now();
  const existing = cache.get(fetcher);
  // A registry change (admin registered/removed a custom provider) must be
  // visible in the next picker load, not after the TTL runs out.
  if (existing && existing.expiresAt > now && existing.customVersion === customProvidersVersion())
    return existing.models;
  if (existing?.inFlight) return existing.inFlight;
  const entry = existing ?? { expiresAt: 0, models: [] };
  entry.inFlight = fetchOpenRouterModels(fetcher)
    .then((dynamic) => {
      const models = builtInModelCatalog();
      const known = new Set(models.map((model) => model.id));
      entry.models = [...models, ...dynamic.filter((model) => !known.has(model.id))];
      entry.expiresAt = Date.now() + CACHE_TTL_MS;
      entry.customVersion = customProvidersVersion();
      return entry.models;
    })
    .catch(() => {
      entry.models = entry.models.length ? entry.models : builtInModelCatalog();
      entry.expiresAt = Date.now() + FAILURE_TTL_MS;
      entry.customVersion = customProvidersVersion();
      return entry.models;
    })
    .finally(() => {
      delete entry.inFlight;
    });
  cache.set(fetcher, entry);
  return entry.inFlight;
}

export function selectableCatalogForHarness(
  catalog: readonly ModelCatalogEntry[],
  harness: string,
): ModelCatalogEntry[] {
  return catalog.filter(
    (model) =>
      (model.provider !== "openrouter" || harness === "pi" || harness === "mock") &&
      modelSupportedByHarness(model.id, harness),
  );
}
