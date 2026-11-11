import type { Api, Model } from "@earendil-works/pi-ai";
import { modelGatewayRequest, type ModelGatewayTransportConfig } from "./provider-endpoints.ts";
import { isGatewayModelId } from "./gateway-models.ts";
import type { ProviderKeys } from "./model-runtime.ts";
import {
  auxiliaryModelFor,
  DEFAULT_AGENT_MODEL_ID,
  defaultModel,
  getRequiredModel,
  modelDisplayName,
  personalModelId,
  resolveModel,
} from "./pi-models.ts";
import type { RuntimeChoice } from "../agent/agent.ts";
import { baseModelProviders, configuredModel, type Config } from "../config.ts";
import { swallow } from "../util/errors.ts";

export type ModelBilling = "model_gateway" | "org_key" | "personal_account";

export interface ModelRoute {
  modelId: string;
  model: Model<Api>;
  keys: ProviderKeys;
  gateway?: ModelGatewayTransportConfig;
  billing: ModelBilling;
}

const BILLING_LABELS: Record<ModelBilling, string> = {
  model_gateway: "the shared model gateway",
  org_key: "the organization's own provider key or subscription",
  personal_account: "the person's own account",
};

export function modelBilling(viaGateway: boolean, personal: boolean): ModelBilling {
  if (personal) return "personal_account";
  return viaGateway ? "model_gateway" : "org_key";
}

export function routeLabel(route: Pick<ModelRoute, "modelId" | "billing">): string {
  return `${modelDisplayName(route.modelId)} (billed to ${BILLING_LABELS[route.billing]})`;
}

export function resolveConfiguredModelId(configured: string | undefined, defaultModelId?: string): string {
  for (const candidate of [configured, defaultModelId]) {
    if (!candidate) continue;
    if (resolveModel(candidate)) return candidate;
    swallow("pi: configured model id not in registry, falling back to default", new Error(candidate));
  }
  return DEFAULT_AGENT_MODEL_ID;
}

export interface ModelRouteOptions {
  modelId?: string;
  defaultModelId?: string;
  resolveBaseModelId?: () => string | undefined;
  resolveFallbackRuntime?: () => RuntimeChoice | undefined;
  companyModelId?: (id: string) => string;
  apiKey?: string;
  openaiApiKey?: string;
  openrouterApiKey?: string;
  modelGateway?: ModelGatewayTransportConfig;
  resolveProviderKeys?: () => Promise<ProviderKeys>;
  ownProviders?: () => Promise<ReadonlySet<string>>;
}

export function configRouteOptions(config: Config): ModelRouteOptions {
  const defaultModelId =
    configuredModel(config) ?? (config.modelProvider ? defaultModel(undefined, baseModelProviders(config)) : undefined);
  return {
    ...(defaultModelId ? { defaultModelId } : {}),
    ...(config.anthropicApiKey ? { apiKey: config.anthropicApiKey } : {}),
    ...(config.openaiApiKey ? { openaiApiKey: config.openaiApiKey } : {}),
    ...(config.openrouterApiKey ? { openrouterApiKey: config.openrouterApiKey } : {}),
    ...(config.modelGateway ? { modelGateway: config.modelGateway } : {}),
  };
}

export interface ModelRoutes {
  readonly gateway?: ModelGatewayTransportConfig;
  baseModelId(): string;
  utilityModelId(override?: string): string;
  servedId(id: string, personalKeys?: ProviderKeys): string;
  route(modelId: string, personalKeys?: ProviderKeys): Promise<ModelRoute>;
  companyGateway(model: { id: string; provider: unknown }): Promise<ModelGatewayTransportConfig | undefined>;
  onCompanyGateway(modelId: string): Promise<boolean>;
  servable(route: ModelRoute): ModelRoute | undefined;
  session(session: { runtime?: { modelId?: string }; providerKeys?: ProviderKeys }): Promise<ModelRoute>;
  utility(modelId?: string): Promise<ModelRoute | undefined>;
  fallback(
    fromModelIds: ReadonlySet<string>,
    providerKeys?: ProviderKeys,
  ): Promise<(ModelRoute & { runtime: RuntimeChoice }) | undefined>;
}

export function createModelRoutes(opts: ModelRouteOptions = {}): ModelRoutes {
  const baseModelId = () => resolveConfiguredModelId(opts.resolveBaseModelId?.() ?? opts.modelId, opts.defaultModelId);
  const staticKeys: ProviderKeys = opts.resolveProviderKeys
    ? {}
    : {
        ...(opts.apiKey ? { anthropic: opts.apiKey } : {}),
        ...(opts.openaiApiKey ? { openai: opts.openaiApiKey } : {}),
        ...(opts.openrouterApiKey ? { openrouter: opts.openrouterApiKey } : {}),
      };
  const companyKeys = async (): Promise<ProviderKeys> => ({
    ...staticKeys,
    ...(await opts.resolveProviderKeys?.()),
  });
  const companyServedId = (id: string) => (opts.companyModelId ? opts.companyModelId(id) : id);
  const servedId = (id: string, personalKeys?: ProviderKeys) =>
    personalKeys ? personalModelId(id, personalKeys) : companyServedId(id);
  const companyGateway = async (model: { id: string; provider: unknown }) => {
    const gateway = opts.modelGateway;
    if (!gateway?.models[model.id] || isGatewayModelId(model.id)) return gateway;
    return (await opts.ownProviders?.())?.has(String(model.provider)) ? undefined : gateway;
  };
  const route = async (requestedId: string, personalKeys?: ProviderKeys): Promise<ModelRoute> => {
    const modelId = personalKeys ? personalModelId(requestedId, personalKeys) : requestedId;
    const model = getRequiredModel(personalKeys ? modelId : companyServedId(modelId), !personalKeys);
    const [keys, gateway] = personalKeys
      ? [personalKeys, undefined]
      : await Promise.all([companyKeys(), companyGateway(model)]);
    return {
      modelId,
      model,
      keys,
      ...(gateway ? { gateway } : {}),
      billing: modelBilling(!!modelGatewayRequest(gateway, model), !!personalKeys),
    };
  };
  const servable = (r: ModelRoute): ModelRoute | undefined =>
    r.billing === "model_gateway" || r.keys[String(r.model.provider)] ? r : undefined;
  const utilityModelId = (override?: string) => override ?? auxiliaryModelFor(baseModelId());
  return {
    ...(opts.modelGateway ? { gateway: opts.modelGateway } : {}),
    baseModelId,
    utilityModelId,
    servedId,
    route,
    companyGateway,
    onCompanyGateway: async (id) => {
      const model = resolveModel(companyServedId(id));
      return !!model && !!modelGatewayRequest(await companyGateway(model), model);
    },
    servable,
    session: (session) => route(session.runtime?.modelId ?? baseModelId(), session.providerKeys),
    utility: async (modelId) => servable(await route(utilityModelId(modelId))),
    async fallback(fromModelIds, providerKeys) {
      const runtime = opts.resolveFallbackRuntime?.();
      if (!runtime) return undefined;
      const served = servedId(runtime.modelId, providerKeys);
      if (fromModelIds.has(runtime.modelId) || fromModelIds.has(served) || !resolveModel(served, !providerKeys))
        return undefined;
      const r = servable(await route(runtime.modelId, providerKeys));
      return r && { ...r, runtime };
    },
  };
}
