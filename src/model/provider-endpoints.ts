import { createHmac } from "node:crypto";
import { isGatewayModelId } from "./gateway-models.ts";
import { currentModelRequestContext } from "./request-context.ts";
import { attestableActor } from "../directory/person.ts";
import { tenantSettings } from "../tenants/settings.ts";
import { trimTrailingSlashes } from "../util/text.ts";

export const MODEL_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export function isModelProvider(value: unknown): value is ModelProvider {
  return typeof value === "string" && (MODEL_PROVIDERS as readonly string[]).includes(value);
}

const PROVIDER_BASE_URL_ENV: Record<ModelProvider, string> = {
  anthropic: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
  openrouter: "OPENROUTER_BASE_URL",
};

export type ProviderBaseUrls = Partial<Record<ModelProvider, string>>;

export function gatewayRoot(url: string): string {
  return trimTrailingSlashes(url).replace(/\/v1$/, "");
}

export interface ModelGatewayTransportConfig {
  url: string;
  apiKey: string;
  apiKeyHeader: string;
  models: Readonly<Record<string, string>>;
  reservedModelIds?: ReadonlySet<string>;
  refresh?: () => Promise<void>;
  actorKey?: string;
}

export function parseProviderBaseUrl(envName: string, value: string): string {
  const trimmed = trimTrailingSlashes(value.trim());
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
  for (const provider of MODEL_PROVIDERS) {
    const envName = PROVIDER_BASE_URL_ENV[provider];
    const raw = env[envName];
    if (raw?.trim()) urls[provider] = parseProviderBaseUrl(envName, raw);
  }
  return urls;
}

let configured: ProviderBaseUrls = {};

export function setProviderBaseUrls(urls: ProviderBaseUrls): void {
  configured = { ...urls };
}

export function providerBaseUrl(provider: string): string | undefined {
  return isModelProvider(provider) ? configured[provider] : undefined;
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

export type ModelRequestPurpose =
  | "turn"
  | "detect"
  | "compaction"
  | "title"
  | "judge"
  | "ambient_judge"
  | "approval_summary"
  | "security_screen"
  | "ack_emoji"
  | "next_prompt"
  | "memory_capture"
  | "memory_classification"
  | "embedding"
  | "decision"
  | "browser"
  | "probe"
  | "sandbox";

export const MODEL_REQUEST_CONTEXT_HEADERS = {
  "x-qm-session-id": "sessionId",
  "x-qm-actor": "actorId",
  "x-qm-scope": "scopeId",
  "x-qm-purpose": "purpose",
  "x-qm-origin": "origin",
} as const;

export function gatewayActorId(actorId: string, key: string): string {
  return createHmac("sha256", key).update(actorId).digest("hex").slice(0, 32);
}

function gatewayScopeId(scopeId: string | undefined, key: string | undefined): string | undefined {
  if (!scopeId?.startsWith("personal:")) return scopeId;
  return key ? `personal:${gatewayActorId(scopeId.slice("personal:".length), key)}` : undefined;
}

export function gatewayKey(config: Pick<ModelGatewayTransportConfig, "apiKey">): string {
  return tenantSettings().modelGatewayKey ?? config.apiKey;
}

export function modelGatewayHeaders(
  config: Pick<ModelGatewayTransportConfig, "apiKey" | "apiKeyHeader" | "actorKey">,
  purpose?: ModelRequestPurpose,
): Record<string, string> {
  const { actorId, scopeId, ...rest } = currentModelRequestContext();
  const actor = attestableActor(actorId);
  const context = {
    ...rest,
    actorId: actor && config.actorKey ? gatewayActorId(actor, config.actorKey) : undefined,
    scopeId: gatewayScopeId(attestableActor(scopeId), config.actorKey),
    purpose,
  };
  const headers: Record<string, string> = { [config.apiKeyHeader]: gatewayKey(config) };
  for (const [name, field] of Object.entries(MODEL_REQUEST_CONTEXT_HEADERS)) {
    const value = context[field];
    const attested = attestableActor(value);
    if (attested) headers[name] = attested;
  }
  return headers;
}

export function modelGatewayRoute<T extends { id: string; baseUrl: string; api?: string; compat?: object }>(
  config: ModelGatewayTransportConfig | undefined,
  model: T,
): { model: T; target: string } | undefined {
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
  };
}

export function modelGatewayRequest<T extends { id: string; baseUrl: string; api?: string; compat?: object }>(
  config: ModelGatewayTransportConfig | undefined,
  model: T,
  purpose?: ModelRequestPurpose,
): { model: T; target: string; apiKey: string; headers: Record<string, string> } | undefined {
  const route = modelGatewayRoute(config, model);
  if (!route || !config) return undefined;
  return { ...route, apiKey: gatewayKey(config), headers: modelGatewayHeaders(config, purpose) };
}
