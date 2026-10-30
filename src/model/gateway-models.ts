import type { EmbeddingModel } from "./model-overlay.ts";
import { isEmbeddingModel } from "./model-overlay.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { boundTenant, currentTenant } from "../tenants/context.ts";

export const GATEWAY_PROVIDER = "qm:gateway";
export const GATEWAY_MODEL_PREFIX = "gateway/";

export type GatewayModel = Model<Api> & { documentInput?: "pdf" | "files" };

interface GatewayRegistry {
  models: Map<string, GatewayModel | EmbeddingModel>;
  snapshot: string;
  aliasedIds: Set<string>;
}

const registries = new Map<string, GatewayRegistry>();
let version = 0;

function registry(): GatewayRegistry | undefined {
  const tenant = boundTenant();
  return tenant ? registries.get(tenant) : undefined;
}

function models(): Map<string, GatewayModel | EmbeddingModel> {
  return registry()?.models ?? new Map();
}

export function isGatewayModelId(id: string): boolean {
  return id.startsWith(GATEWAY_MODEL_PREFIX);
}

export function gatewayModelsVersion(): number {
  return version;
}

export function setGatewayModels(
  next: readonly (GatewayModel | EmbeddingModel)[],
  aliases: readonly string[] = [],
): void {
  const tenant = currentTenant();
  const serialized = JSON.stringify([next, aliases]);
  if (registries.get(tenant)?.snapshot === serialized) return;
  registries.set(tenant, {
    models: new Map(next.map((model) => [model.id, model])),
    aliasedIds: new Set(aliases),
    snapshot: serialized,
  });
  version += 1;
}

export function resolveGatewayModel(id: string): GatewayModel | undefined {
  const model = models().get(id);
  return model && !isEmbeddingModel(model) ? model : undefined;
}

export function gatewayModelCatalog(includeAliased = false): Array<{ id: string; name: string; provider: string }> {
  return [...models().values()]
    .filter((m): m is GatewayModel => !isEmbeddingModel(m))
    .filter(({ id }) => includeAliased || !registry()?.aliasedIds.has(id))
    .map(({ id, name, provider }) => ({ id, name, provider }));
}

export function gatewayModelsJson(): Record<string, unknown> {
  const chatModels = [...models().values()].filter((m): m is GatewayModel => !isEmbeddingModel(m));
  const first = chatModels[0];
  if (!first) return {};
  return {
    [GATEWAY_PROVIDER]: {
      name: "Model gateway",
      baseUrl: first.baseUrl,
      api: "openai-completions",
      models: chatModels.map(
        ({ id, name, contextWindow, maxTokens, cost, reasoning, input, compat, api, baseUrl }) => ({
          id,
          name,
          contextWindow,
          maxTokens,
          cost,
          reasoning,
          input,
          compat,
          api,
          baseUrl,
        }),
      ),
    },
  };
}

export function resolveGatewayEmbeddingModel(id: string): EmbeddingModel | undefined {
  const model = models().get(id);
  return model && isEmbeddingModel(model) ? model : undefined;
}

export function gatewayEmbeddingModelIds(): string[] {
  return [...models().values()].filter(isEmbeddingModel).map((model) => model.id);
}
