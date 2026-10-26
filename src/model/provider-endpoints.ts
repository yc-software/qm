import { isGatewayModelId } from "./gateway-models.ts";

export const PROVIDER_IDS = ["anthropic", "openai", "openrouter"] as const;

export interface ModelGatewayTransportConfig {
  url: string;
  apiKey: string;
  apiKeyHeader: string;
  models: Readonly<Record<string, string>>;
  reservedModelIds?: ReadonlySet<string>;
  refresh?: () => Promise<void>;
}

export function parseProviderBaseUrl(envName: string, value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${envName} is not a valid URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`${envName} must be an http(s) URL, got ${url.protocol}//`);
  if (url.username || url.password) throw new Error(`${envName} must not contain credentials`);
  if (url.search) throw new Error(`${envName} must not contain a query string`);
  if (url.hash) throw new Error(`${envName} must not contain a fragment`);
  return trimmed;
}

export class ModelUnavailableError extends Error {
  readonly status = 404;
  readonly type = "model_unavailable";
  constructor(modelId: string, label = "Model") {
    super(`${label} is unavailable: ${modelId}`);
    this.name = "ModelUnavailableError";
  }
}

export class GatewayModelUnavailableError extends ModelUnavailableError {
  constructor(modelId: string) {
    super(modelId, "Gateway model");
    this.name = "GatewayModelUnavailableError";
  }
}

export function modelGatewayRequest<T extends { id: string; baseUrl: string; api?: string; compat?: object }>(
  config: ModelGatewayTransportConfig | undefined,
  model: T,
): { model: T; target: string; apiKey: string; headers: Record<string, string> } | undefined {
  const target = config?.models[model.id];
  if (!target || !config) {
    if (isGatewayModelId(model.id) || config?.reservedModelIds?.has(model.id))
      throw new GatewayModelUnavailableError(model.id);
    return undefined;
  }
  return {
    model: {
      ...model,
      compat: { ...model.compat, sendSessionAffinityHeaders: true },
      baseUrl: isGatewayModelId(model.id)
        ? `${config.url.replace(/\/v1$/, "")}${model.api === "anthropic-messages" ? "" : "/v1"}`
        : config.url,
    },
    target,
    apiKey: config.apiKey,
    headers: { [config.apiKeyHeader]: config.apiKey },
  };
}
