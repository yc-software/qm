import { isEmbeddingModel, type EmbeddingModel } from "./model-overlay.ts";
import { gatewayRoot, type ModelGatewayTransportConfig } from "./provider-endpoints.ts";
import { GATEWAY_MODEL_PREFIX, GATEWAY_PROVIDER, setGatewayModels, type GatewayModel } from "./gateway-models.ts";
import { modelOfferedInWebui, selectableBaseModels } from "./pi-models.ts";
import { readBoundedText } from "../util/bytes.ts";
import { swallow } from "../util/errors.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const TTL_MS = 5 * 60_000;
const RETRY_MS = 30_000;
const STALE_MS = 15 * 60_000;
const UNRELIABLE_OUTPUT_LIMIT_FALLBACK = 65_536;

function transientFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status === 429 || status >= 500;
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError" || error instanceof TypeError;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function modelId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/.test(value);
}

function tokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function price(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isFinite(value * 1_000_000)
    ? value * 1_000_000
    : undefined;
}

function parseModel(value: unknown, allowed: Set<string>, baseUrl: string): GatewayModel | EmbeddingModel | undefined {
  const info = record(value);
  if (!info || !modelId(info.model_group) || !allowed.has(info.model_group)) return undefined;
  if (info.mode === "embedding") {
    return {
      kind: "embedding",
      id: GATEWAY_MODEL_PREFIX + info.model_group,
      name: info.model_group,
      provider: GATEWAY_PROVIDER,
      baseUrl,
    };
  }
  if (info.mode !== "chat" || info.supports_function_calling !== true) return undefined;
  const contextWindow = tokens(info.max_input_tokens);
  const reportedMaxTokens = tokens(info.max_output_tokens);
  const input = price(info.input_cost_per_token);
  const output = price(info.output_cost_per_token);
  if (!contextWindow || !reportedMaxTokens || input === undefined || output === undefined) return undefined;
  const maxTokens =
    reportedMaxTokens < contextWindow
      ? reportedMaxTokens
      : Math.min(UNRELIABLE_OUTPUT_LIMIT_FALLBACK, Math.floor(contextWindow / 2));
  if (maxTokens < 1) return undefined;
  const providers = Array.isArray(info.providers) ? info.providers : [];
  const anthropic = providers.length > 0 && providers.every((provider) => provider === "anthropic");
  const openai = providers.length > 0 && providers.every((provider) => provider === "openai" || provider === "azure");
  const pdf =
    providers.length > 0 &&
    providers.every((provider) => ["anthropic", "openai", "azure", "gemini", "vertex_ai"].includes(String(provider)));
  let api: GatewayModel["api"] = "openai-completions";
  if (anthropic) api = "anthropic-messages";
  else if (openai) api = "openai-responses";
  let documentInput: GatewayModel["documentInput"];
  if (openai) documentInput = "files";
  else if (pdf) documentInput = "pdf";
  return {
    documentInput,
    ...(anthropic && info.supports_fast_mode === true ? { fastMode: true } : {}),
    id: GATEWAY_MODEL_PREFIX + info.model_group,
    name: info.model_group,
    provider: GATEWAY_PROVIDER,
    api,
    baseUrl: anthropic ? gatewayRoot(baseUrl) : baseUrl,
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
      sendSessionAffinityHeaders: true,
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
  if (!response.ok)
    throw Object.assign(new Error(`Gateway catalog returned HTTP ${response.status}`), { status: response.status });
  const body = await readBoundedText(response, MAX_BYTES, () => new Error("Gateway catalog exceeds size limit"));
  const data = record(JSON.parse(body))?.data;
  if (!Array.isArray(data)) throw new Error("Invalid gateway catalog");
  return data;
}

export function createGatewayCatalog(
  config: ModelGatewayTransportConfig,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
) {
  const root = gatewayRoot(config.url);
  const baseUrl = `${root}/v1`;
  const state: {
    routes: Readonly<Record<string, string>>;
    discovered: boolean;
    retryAt: number;
    lastSuccessAt: number;
    inFlight?: Promise<void>;
  } = { routes: { ...config.models }, discovered: false, retryAt: 0, lastSuccessAt: 0 };
  const transport: ModelGatewayTransportConfig = {
    ...config,
    reservedModelIds: new Set(Object.keys(config.models)),
    refresh,
    get models() {
      return state.routes;
    },
  };
  async function refresh(): Promise<void> {
    if (state.inFlight) return state.inFlight;
    if (now() < state.retryAt) return;
    state.inFlight = (async () => {
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
          if (allowed.has(target) && !models.some((m) => m.id === GATEWAY_MODEL_PREFIX + target && isEmbeddingModel(m)))
            next[id] = target;
        }
        state.routes = next;
        state.discovered = true;
        state.retryAt = now() + TTL_MS;
        state.lastSuccessAt = now();
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
      } catch (error) {
        state.retryAt = now() + RETRY_MS;
        if (state.discovered && transientFailure(error) && now() - state.lastSuccessAt < STALE_MS) {
          swallow("model: gateway discovery failed; keeping last known models and retrying in 30 seconds", error);
          return;
        }
        if (state.discovered || Object.keys(config.models).length === 0) {
          state.routes = {};
          setGatewayModels([]);
          swallow("model: gateway discovery unavailable; retrying in 30 seconds", error);
          return;
        }
        swallow("model: gateway discovery failed; routing configured aliases only and retrying in 30 seconds", error);
      }
    })().finally(() => {
      state.inFlight = undefined;
    });
    return state.inFlight;
  }
  return { transport, refresh };
}
