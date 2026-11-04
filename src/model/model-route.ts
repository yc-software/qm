import type { Api, Model } from "@earendil-works/pi-ai";
import { modelGatewayRequest, type ModelGatewayTransportConfig } from "./provider-endpoints.ts";
import type { ProviderKeys } from "./model-runtime.ts";
import {
  auxiliaryModelFor,
  DEFAULT_AGENT_MODEL_ID,
  getRequiredModel,
  modelDisplayName,
  personalModelId,
  resolveModel,
} from "./pi-models.ts";
import type { RuntimeChoice } from "../agent/agent.ts";
import { tenantEnv } from "../tenants/settings.ts";
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
  org_key: "the organization's own provider key",
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

function tenantProviderKeys(keys: ProviderKeys): ProviderKeys {
  const anthropic = tenantEnv("ANTHROPIC_API_KEY") ?? keys.anthropic;
  const openrouter = tenantEnv("OPENROUTER_API_KEY") ?? keys.openrouter;
  return { ...keys, ...(anthropic ? { anthropic } : {}), ...(openrouter ? { openrouter } : {}) };
}

export interface ModelRouteOptions {
  /** The org's base model id (unvalidated); `defaultModelId` and then the built-in default back it. */
  baseModelId?: () => string | undefined;
  defaultModelId?: string;
  /** Static company keys; tenant env keys override them, `providerKeys()` overrides both. */
  staticKeys?: ProviderKeys;
  providerKeys?: () => Promise<ProviderKeys>;
  gateway?: ModelGatewayTransportConfig;
  companyModelId?: (id: string) => string;
  fallbackRuntime?: () => RuntimeChoice | undefined;
}

/**
 * The one place that turns a role into a model, keys, gateway and billed account.
 * `session` serves a session's own runtime and keys, `utility` the org's auxiliary
 * model on company keys, `fallback` the org's configured fallback runtime only.
 */
export interface ModelRoutes {
  readonly gateway?: ModelGatewayTransportConfig;
  baseModelId(): string;
  utilityModelId(override?: string): string;
  /** The id actually served for `id` on company keys or on the given personal keys. */
  servedId(id: string, personalKeys?: ProviderKeys): string;
  route(modelId: string, personalKeys?: ProviderKeys): Promise<ModelRoute>;
  /** The route if something can pay for it (gateway or a key for its provider). */
  servable(route: ModelRoute): ModelRoute | undefined;
  session(session: { runtime?: { modelId?: string }; providerKeys?: ProviderKeys }): Promise<ModelRoute>;
  utility(modelId?: string): Promise<ModelRoute | undefined>;
  fallback(
    fromModelIds: ReadonlySet<string>,
    providerKeys?: ProviderKeys,
  ): Promise<(ModelRoute & { runtime: RuntimeChoice }) | undefined>;
}

export function createModelRoutes(opts: ModelRouteOptions = {}): ModelRoutes {
  const baseModelId = () => resolveConfiguredModelId(opts.baseModelId?.(), opts.defaultModelId);
  const companyKeys = async (): Promise<ProviderKeys> => ({
    ...tenantProviderKeys(opts.staticKeys ?? {}),
    ...(await opts.providerKeys?.()),
  });
  const companyServedId = (id: string) => (opts.companyModelId ? opts.companyModelId(id) : id);
  const servedId = (id: string, personalKeys?: ProviderKeys) =>
    personalKeys ? personalModelId(id, personalKeys) : companyServedId(id);
  const route = async (requestedId: string, personalKeys?: ProviderKeys): Promise<ModelRoute> => {
    const modelId = personalKeys ? personalModelId(requestedId, personalKeys) : requestedId;
    const model = getRequiredModel(personalKeys ? modelId : companyServedId(modelId), !personalKeys);
    const keys = personalKeys ?? (await companyKeys());
    const gateway = personalKeys ? undefined : opts.gateway;
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
    ...(opts.gateway ? { gateway: opts.gateway } : {}),
    baseModelId,
    utilityModelId,
    servedId,
    route,
    servable,
    session: (session) => route(session.runtime?.modelId ?? baseModelId(), session.providerKeys),
    utility: async (modelId) => servable(await route(utilityModelId(modelId))),
    async fallback(fromModelIds, providerKeys) {
      const runtime = opts.fallbackRuntime?.();
      if (!runtime) return undefined;
      const served = servedId(runtime.modelId, providerKeys);
      if (fromModelIds.has(runtime.modelId) || fromModelIds.has(served) || !resolveModel(served, !providerKeys))
        return undefined;
      const r = servable(await route(runtime.modelId, providerKeys));
      return r && { ...r, runtime };
    },
  };
}
