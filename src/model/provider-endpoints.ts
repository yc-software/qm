import { isGatewayModelId } from "./gateway-models.ts";
import { boundTenant } from "../tenants/context.ts";

export const PROVIDER_IDS = ["anthropic", "openai", "openrouter"] as const;
type ProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderBaseUrls = Partial<Record<ProviderId, string>>;

export function gatewayRoot(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

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

const configured = new Map<string, ProviderBaseUrls>();

export function setProviderBaseUrls(tenant: string, urls: ProviderBaseUrls): void {
  configured.set(tenant, { ...urls });
}

export function providerBaseUrl(provider: string): string | undefined {
  const tenant = boundTenant();
  if (!tenant || !(PROVIDER_IDS as readonly string[]).includes(provider)) return undefined;
  return configured.get(tenant)?.[provider as ProviderId];
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
        ? `${gatewayRoot(config.url)}${model.api === "anthropic-messages" ? "" : "/v1"}`
        : config.url,
    },
    target,
    apiKey: config.apiKey,
    headers: { [config.apiKeyHeader]: config.apiKey },
  };
}
