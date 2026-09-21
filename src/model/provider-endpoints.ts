import { tenantState } from "../tenancy/context.ts";
import { isGatewayModelId } from "./gateway-models.ts";
/**
 * Provider endpoint overrides.
 *
 * One place decides which base URL each model provider is reached at.
 * Config parses and validates the `*_BASE_URL` environment variables,
 * wiring injects them here, and everything that issues a request — the
 * in-process pi harness, the child-process harness environments, and
 * admin API-key validation — resolves through this module. No harness
 * reads its own override.
 */

export const PROVIDER_IDS = ["anthropic", "openai", "openrouter"] as const;
type ProviderId = (typeof PROVIDER_IDS)[number];

const PROVIDER_BASE_URL_ENV: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
  openrouter: "OPENROUTER_BASE_URL",
};

export type ProviderBaseUrls = Partial<Record<ProviderId, string>>;

export interface ModelGatewayTransportConfig {
  url: string;
  apiKey: string;
  apiKeyHeader: string;
  models: Readonly<Record<string, string>>;
  reservedModelIds?: ReadonlySet<string>;
  refresh?: () => Promise<void>;
}

/**
 * Validate and normalize a provider base URL. Returns the normalized
 * origin+path with trailing slashes removed. Throws on anything that
 * would silently misroute requests: non-HTTP(S) schemes, embedded
 * credentials, query strings, and fragments.
 */
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

export function providerBaseUrlsFromEnv(env: NodeJS.ProcessEnv): ProviderBaseUrls {
  const urls: ProviderBaseUrls = {};
  for (const provider of PROVIDER_IDS) {
    const envName = PROVIDER_BASE_URL_ENV[provider];
    const raw = env[envName];
    if (raw?.trim()) urls[provider] = parseProviderBaseUrl(envName, raw);
  }
  return urls;
}

const PROVIDER_ENDPOINT_STATE = Symbol("provider-endpoints");
const providerEndpointState = () =>
  tenantState(PROVIDER_ENDPOINT_STATE, () => ({ configured: {} as ProviderBaseUrls }));

/** Called once by wiring with the config-parsed overrides. */
export function setProviderBaseUrls(urls: ProviderBaseUrls): void {
  providerEndpointState().configured = { ...urls };
}

/** The override for a provider, if one is configured. */
export function providerBaseUrl(provider: string): string | undefined {
  return (PROVIDER_IDS as readonly string[]).includes(provider)
    ? providerEndpointState().configured[provider as ProviderId]
    : undefined;
}

export function modelGatewayRequest<T extends { id: string; baseUrl: string; api?: string }>(
  config: ModelGatewayTransportConfig | undefined,
  model: T,
): { model: T; target: string; apiKey: string; headers: Record<string, string> } | undefined {
  const target = config?.models[model.id];
  if (!target || !config) {
    if (isGatewayModelId(model.id) || config?.reservedModelIds?.has(model.id))
      throw new Error(`Gateway model is unavailable: ${model.id}`);
    return undefined;
  }
  return {
    model: {
      ...model,
      baseUrl: isGatewayModelId(model.id)
        ? `${config.url.replace(/\/v1$/, "")}${model.api === "anthropic-messages" ? "" : "/v1"}`
        : config.url,
    },
    target,
    apiKey: config.apiKey,
    headers: { [config.apiKeyHeader]: config.apiKey },
  };
}
