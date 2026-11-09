import { createTtlRefresh } from "../util/async.ts";
import { swallow } from "../util/errors.ts";
import { readBoundedText } from "../util/bytes.ts";
import { validateCustomProviderSpec, type CustomProviderSpec } from "./custom-providers.ts";
import { MAX_CATALOG_BYTES } from "./model-catalog.ts";

const BASETEN_PROVIDER_ID = "baseten";
const BASETEN_BASE_URL = "https://inference.baseten.co/v1";
const CATALOG_TTL_MS = 5 * 60_000;

type BasetenModel = CustomProviderSpec["models"][number];

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function perMillion(value: unknown): number | undefined {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function basetenCatalogModels(body: unknown): BasetenModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("Baseten model list is invalid");
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
  const refresh = createTtlRefresh(CATALOG_TTL_MS, async () => {
    try {
      const response = await fetcher(`${BASETEN_BASE_URL}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Baseten model list returned ${response.status}`);
      const text = await readBoundedText(
        response,
        MAX_CATALOG_BYTES,
        () => new Error("Baseten model list is too large"),
      );
      const models = basetenCatalogModels(JSON.parse(text));
      const next: CustomProviderSpec | undefined = models.length
        ? { id: BASETEN_PROVIDER_ID, name: "Baseten", protocol: "openai", baseUrl: BASETEN_BASE_URL, models }
        : undefined;
      if (next) validateCustomProviderSpec(next);
      provider = next;
    } catch (error) {
      swallow("[model] Baseten catalog refresh", error);
    }
  });
  let first: Promise<void> | undefined;
  const adminOwnsId = (enabled: readonly CustomProviderSpec[]): boolean =>
    enabled.some((p) => p.id === BASETEN_PROVIDER_ID);
  return {
    async providers(enabled: readonly CustomProviderSpec[]): Promise<CustomProviderSpec[]> {
      if (adminOwnsId(enabled)) return [];
      if (!first) await (first = refresh());
      else void refresh();
      return provider ? [provider] : [];
    },
    keys(enabled: readonly CustomProviderSpec[]): Record<string, string> {
      return adminOwnsId(enabled) ? {} : { [BASETEN_PROVIDER_ID]: apiKey };
    },
  };
}
