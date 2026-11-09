import { swallow } from "../util/errors.ts";
import { validateCustomProviderSpec, type CustomProviderSpec } from "./custom-providers.ts";
import { CACHE_TTL_MS, FAILURE_TTL_MS, fetchCatalogData, perMillion, positiveInteger } from "./model-catalog.ts";

const BASETEN_PROVIDER_ID = "baseten";
const BASETEN_BASE_URL = "https://inference.baseten.co/v1";

type BasetenModel = CustomProviderSpec["models"][number];

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function basetenCatalogModels(data: readonly unknown[]): BasetenModel[] {
  return data.flatMap((candidate): BasetenModel[] => {
    if (!candidate || typeof candidate !== "object") return [];
    const raw = candidate as Record<string, unknown>;
    const features = strings(raw.supported_features);
    const contextWindow = positiveInteger(raw.context_length);
    const pricing = (raw.pricing ?? {}) as Record<string, unknown>;
    const input = perMillion(pricing.prompt);
    const output = perMillion(pricing.completion);
    if (
      typeof raw.id !== "string" ||
      !raw.id ||
      !features.includes("tools") ||
      !contextWindow ||
      input === undefined ||
      output === undefined
    )
      return [];
    const maxTokens = positiveInteger(raw.max_completion_tokens);
    const cacheRead = perMillion(pricing.input_cache_read);
    return [
      {
        id: raw.id,
        ...(typeof raw.name === "string" && raw.name ? { name: raw.name } : {}),
        reasoning: features.includes("reasoning"),
        ...(strings(raw.input_modalities).includes("image") ? { image: true } : {}),
        contextWindow,
        ...(maxTokens ? { maxTokens: Math.min(maxTokens, contextWindow) } : {}),
        input,
        output,
        ...(cacheRead !== undefined ? { cacheRead } : {}),
      },
    ];
  });
}

export function createBasetenCatalog(apiKey: string, fetcher: typeof fetch = fetch) {
  let provider: CustomProviderSpec | undefined;
  let expiresAt = 0;
  let loading: Promise<void> | undefined;
  let first: Promise<void> | undefined;
  const load = async () => {
    try {
      const models = basetenCatalogModels(
        await fetchCatalogData(fetcher, `${BASETEN_BASE_URL}/models`, "Baseten model list", {
          authorization: `Bearer ${apiKey}`,
        }),
      );
      const spec = (kept: BasetenModel[]): CustomProviderSpec => ({
        id: BASETEN_PROVIDER_ID,
        name: "Baseten",
        protocol: "openai",
        baseUrl: BASETEN_BASE_URL,
        models: kept,
      });
      const valid = models.filter((model) => {
        try {
          validateCustomProviderSpec(spec([model]));
          return true;
        } catch (error) {
          swallow(`[model] Baseten model ${model.id} skipped`, error);
          return false;
        }
      });
      provider = valid.length ? spec(valid) : undefined;
      expiresAt = Date.now() + CACHE_TTL_MS;
    } catch (error) {
      swallow("[model] Baseten catalog refresh", error);
      expiresAt = Date.now() + FAILURE_TTL_MS;
    }
  };
  const refresh = () =>
    (loading ??= load().finally(() => {
      loading = undefined;
    }));
  const adminOwnsId = (enabled: readonly CustomProviderSpec[]): boolean =>
    enabled.some((p) => p.id === BASETEN_PROVIDER_ID);
  return {
    async providers(enabled: readonly CustomProviderSpec[]): Promise<CustomProviderSpec[]> {
      if (adminOwnsId(enabled)) return [];
      await (first ??= refresh());
      if (Date.now() >= expiresAt) void refresh();
      return provider ? [provider] : [];
    },
    keys(enabled: readonly CustomProviderSpec[]): Record<string, string> {
      return adminOwnsId(enabled) ? {} : { [BASETEN_PROVIDER_ID]: apiKey };
    },
  };
}
