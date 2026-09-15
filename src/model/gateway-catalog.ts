import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelGatewayTransportConfig } from "./provider-endpoints.ts";
import { GATEWAY_MODEL_PREFIX, GATEWAY_PROVIDER, setGatewayModels } from "./gateway-models.ts";
import { modelOfferedInWebui, selectableBaseModels } from "./pi-models.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 1_000;
const TTL_MS = 5 * 60_000;
const RETRY_MS = 30_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function modelId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,191}$/.test(value);
}

function tokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function price(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isFinite(value * 1_000_000)
    ? value * 1_000_000
    : undefined;
}

function parseModel(value: unknown, allowed: Set<string>, baseUrl: string): Model<Api> | undefined {
  const info = record(value);
  if (!info || !modelId(info.model_group) || !allowed.has(info.model_group)) return undefined;
  if (info.mode !== "chat" || info.supports_function_calling !== true) return undefined;
  const contextWindow = tokens(info.max_input_tokens);
  const maxTokens = tokens(info.max_output_tokens);
  const input = price(info.input_cost_per_token);
  const output = price(info.output_cost_per_token);
  if (!contextWindow || !maxTokens || maxTokens >= contextWindow || input === undefined || output === undefined)
    return undefined;
  const providers = Array.isArray(info.providers) ? info.providers : [];
  const anthropic = providers.length > 0 && providers.every((provider) => provider === "anthropic");
  const openai = providers.length > 0 && providers.every((provider) => provider === "openai" || provider === "azure");
  return {
    id: GATEWAY_MODEL_PREFIX + info.model_group,
    name: info.model_group,
    provider: GATEWAY_PROVIDER,
    api: anthropic ? "anthropic-messages" : "openai-completions",
    baseUrl: anthropic ? baseUrl.replace(/\/v1$/, "") : baseUrl,
    reasoning: (anthropic || openai) && info.supports_reasoning === true,
    input: info.supports_vision === true ? ["text", "image"] : ["text"],
    contextWindow,
    maxTokens,
    cost: {
      input,
      output,
      cacheRead: price(info.cache_read_input_token_cost) ?? input,
      cacheWrite: price(info.cache_creation_input_token_cost) ?? input,
    },
    compat: {
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsStrictMode: false,
      supportsStrictTools: false,
      forceAdaptiveThinking: anthropic && info.supports_adaptive_thinking === true,
      supportsLongCacheRetention: false,
      supportsReasoningEffort:
        Array.isArray(info.supported_openai_params) && info.supported_openai_params.includes("reasoning_effort"),
      supportsUsageInStreaming: true,
      maxTokensField:
        Array.isArray(info.supported_openai_params) && info.supported_openai_params.includes("max_completion_tokens")
          ? "max_completion_tokens"
          : "max_tokens",
    },
  };
}

async function readCatalog(
  url: string,
  config: ModelGatewayTransportConfig,
  fetcher: typeof fetch,
): Promise<unknown[]> {
  const response = await fetcher(url, {
    headers: { [config.apiKeyHeader]: config.apiKey },
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Gateway catalog returned HTTP ${response.status}`);
  if (!response.body || Number(response.headers.get("content-length")) > MAX_BYTES)
    throw new Error("Gateway catalog exceeds size limit");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("Gateway catalog exceeds size limit");
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const data = record(JSON.parse(body))?.data;
  if (!Array.isArray(data) || data.length > MAX_MODELS) throw new Error("Invalid gateway catalog");
  return data;
}

export function createGatewayCatalog(
  config: ModelGatewayTransportConfig,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  const root = config.url.replace(/\/v1$/, "");
  const baseUrl = `${root}/v1`;
  let routes: Readonly<Record<string, string>> = { ...config.models };
  let discovered = false;
  let expiresAt = 0;
  let retryAt = 0;
  let inFlight: Promise<void> | undefined;
  const transport: ModelGatewayTransportConfig = {
    ...config,
    reservedModelIds: new Set(Object.keys(config.models)),
    refresh,
    get models() {
      return routes;
    },
  };
  async function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    if (now() < retryAt) return;
    inFlight = (async () => {
      try {
        const [listing, metadata] = await Promise.all([
          readCatalog(`${baseUrl}/models`, config, fetcher),
          readCatalog(`${root}/model_group/info`, config, fetcher),
        ]);
        const allowed = new Set(
          listing.flatMap((entry) => {
            const id = record(entry)?.id;
            if (!modelId(id)) throw new Error("Invalid gateway model id");
            return [id];
          }),
        );
        const models = metadata.flatMap((entry) => {
          const model = parseModel(entry, allowed, baseUrl);
          return model ? [model] : [];
        });
        const next: Record<string, string> = Object.fromEntries(
          models.map((model) => [model.id, model.id.slice(GATEWAY_MODEL_PREFIX.length)]),
        );
        for (const [id, target] of Object.entries(config.models)) {
          if (allowed.has(target)) next[id] = target;
        }
        routes = next;
        discovered = true;
        expiresAt = now() + TTL_MS;
        retryAt = expiresAt;
        const offeredAliases = new Set(
          selectableBaseModels()
            .filter(({ id }) => modelOfferedInWebui(id))
            .map(({ id }) => id),
        );
        setGatewayModels(
          models,
          Object.entries(config.models).flatMap(([id, target]) =>
            !id.startsWith(GATEWAY_MODEL_PREFIX) && offeredAliases.has(id) && next[id]
              ? [GATEWAY_MODEL_PREFIX + target]
              : [],
          ),
        );
      } catch {
        retryAt = now() + RETRY_MS;
        if (discovered || Object.keys(config.models).length === 0) {
          routes = {};
          expiresAt = 0;
          setGatewayModels([]);
          console.warn("[model] Gateway model discovery unavailable; retrying in 30 seconds");
        }
      }
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }
  return { transport, refresh };
}
