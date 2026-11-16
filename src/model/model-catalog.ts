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
import { swallow, withRequestId } from "../util/errors.ts";
import { LRUCache } from "lru-cache";

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

export function createCatalogCache<T>(label: string, load: () => Promise<T>) {
  let refreshing = false;
  const cache = new LRUCache<"catalog", { value?: T }>({
    max: 1,
    ttl: CACHE_TTL_MS,
    ttlResolution: 0,
    allowStale: true,
    perf: { now: () => Date.now() },
    fetchMethod: async (_key, stale, { options }) => {
      refreshing = true;
      try {
        return { value: await load() };
      } catch (error) {
        swallow(label, error);
        options.ttl = FAILURE_TTL_MS;
        return { ...stale };
      } finally {
        refreshing = false;
      }
    },
  });
  return {
    cached() {
      void cache.fetch("catalog");
      return { value: cache.peek("catalog")?.value, refreshing };
    },
    async get(): Promise<T | undefined> {
      return (await cache.fetch("catalog"))?.value;
    },
  };
}

const openRouterCatalogs = new WeakMap<typeof fetch, ReturnType<typeof createCatalogCache<ModelCatalogEntry[]>>>();

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

export function positiveInteger(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function perMillion(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && Number.isFinite(parsed * 1_000_000) ? parsed * 1_000_000 : undefined;
}

export async function fetchCatalogData(
  fetcher: typeof fetch,
  url: string,
  label: string,
  headers?: Record<string, string>,
): Promise<unknown[]> {
  const response = await fetcher(url, {
    ...(headers ? { headers } : {}),
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw Object.assign(
      new Error(withRequestId(`${label} returned HTTP ${response.status} ${detail}`.trim(), response.headers)),
      { status: response.status },
    );
  }
  const body = JSON.parse(
    await readBoundedText(response, MAX_CATALOG_BYTES, () => new Error(`${label} is too large`)),
  ) as {
    data?: unknown;
  } | null;
  if (!Array.isArray(body?.data)) throw new Error(`${label} is invalid`);
  return body.data;
}

function parseOpenRouterModel(candidate: unknown): ModelCatalogEntry | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const raw = candidate as Record<string, unknown>;
  const id = raw.id;
  const name = raw.name;
  const supportedParameters = raw.supported_parameters;
  const contextWindow = positiveInteger(raw.context_length);
  const topProvider = raw.top_provider;
  const maxTokens =
    topProvider && typeof topProvider === "object"
      ? positiveInteger((topProvider as Record<string, unknown>).max_completion_tokens)
      : undefined;
  const pricing = raw.pricing;
  const inputPrice =
    pricing && typeof pricing === "object" ? perMillion((pricing as Record<string, unknown>).prompt) : undefined;
  const outputPrice =
    pricing && typeof pricing === "object" ? perMillion((pricing as Record<string, unknown>).completion) : undefined;
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
  if (
    contextWindow === undefined ||
    maxTokens === undefined ||
    maxTokens > contextWindow ||
    inputPrice === undefined ||
    outputPrice === undefined ||
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
  const data = await fetchCatalogData(fetcher, OPENROUTER_MODELS_URL, "OpenRouter catalog");
  return data.flatMap((candidate) => {
    const model = parseOpenRouterModel(candidate);
    return model ? [model] : [];
  });
}

function withBuiltIns(dynamic: readonly ModelCatalogEntry[]): ModelCatalogEntry[] {
  const models = builtInModelCatalog();
  const known = new Set(models.map((model) => model.id));
  return [...models, ...dynamic.filter((model) => !known.has(model.id))];
}

function openRouterCatalog(fetcher: typeof fetch) {
  let catalog = openRouterCatalogs.get(fetcher);
  if (!catalog) {
    catalog = createCatalogCache("[model] OpenRouter catalog refresh", () => fetchOpenRouterModels(fetcher));
    openRouterCatalogs.set(fetcher, catalog);
  }
  return catalog;
}

export async function selectableModelCatalog(fetcher: typeof fetch = fetch): Promise<ModelCatalogEntry[]> {
  return withBuiltIns((await openRouterCatalog(fetcher).get()) ?? []);
}

export function selectableCatalog(catalog: readonly ModelCatalogEntry[]): ModelCatalogEntry[] {
  return catalog.filter((model) => modelSupported(model.id));
}

export function cachedModelCatalog(fetcher: typeof fetch = fetch): {
  models: ModelCatalogEntry[];
  refreshing: boolean;
} {
  const { value, refreshing } = openRouterCatalog(fetcher).cached();
  return { models: withBuiltIns(value ?? []), refreshing };
}
