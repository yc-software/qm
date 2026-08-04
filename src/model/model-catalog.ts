import { modelSupportedByHarness, resolveModel, SELECTABLE_BASE_MODELS } from "./pi-models.ts";

export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: "anthropic" | "openai" | "openrouter" | "nexforce";
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models?supported_parameters=tools&sort=most-popular";

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_MODELS = 1_000;
const CACHE_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;

interface CacheEntry {
  expiresAt: number;
  models: ModelCatalogEntry[];
  inFlight?: Promise<ModelCatalogEntry[]>;
}

const cache = new WeakMap<typeof fetch, CacheEntry>();

export function builtInModelCatalog(): ModelCatalogEntry[] {
  return SELECTABLE_BASE_MODELS.flatMap((model) => {
    const provider = resolveModel(model.id)?.provider;
    return provider === "anthropic" || provider === "openai" || provider === "openrouter" || provider === "nexforce"
      ? [{ ...model, provider }]
      : [];
  });
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

async function fetchOpenRouterModels(fetcher: typeof fetch): Promise<ModelCatalogEntry[]> {
  const response = await fetcher(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`OpenRouter catalog returned ${response.status}`);
  const body = (await boundedJson(response)) as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error("OpenRouter catalog is invalid");
  return body.data.slice(0, MAX_CATALOG_MODELS).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const { id, name, supported_parameters: supportedParameters } = candidate as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      id.length > 200 ||
      typeof name !== "string" ||
      name.length > 200 ||
      !Array.isArray(supportedParameters) ||
      !supportedParameters.includes("tools")
    )
      return [];
    return resolveModel(id)?.provider === "openrouter" ? [{ id, name, provider: "openrouter" as const }] : [];
  });
}

export async function selectableModelCatalog(fetcher: typeof fetch = fetch): Promise<ModelCatalogEntry[]> {
  const now = Date.now();
  const existing = cache.get(fetcher);
  if (existing && existing.expiresAt > now) return existing.models;
  if (existing?.inFlight) return existing.inFlight;
  const entry = existing ?? { expiresAt: 0, models: [] };
  entry.inFlight = fetchOpenRouterModels(fetcher)
    .then((dynamic) => {
      const models = builtInModelCatalog();
      const known = new Set(models.map((model) => model.id));
      entry.models = [...models, ...dynamic.filter((model) => !known.has(model.id))];
      entry.expiresAt = Date.now() + CACHE_TTL_MS;
      return entry.models;
    })
    .catch(() => {
      entry.models = entry.models.length ? entry.models : builtInModelCatalog();
      entry.expiresAt = Date.now() + FAILURE_TTL_MS;
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
