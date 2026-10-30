import type { EmbeddingModel } from "./model-overlay.ts";
import { isEmbeddingModel } from "./model-overlay.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { perTenant } from "../tenants/context.ts";

export const GATEWAY_PROVIDER = "qm:gateway";
export const GATEWAY_MODEL_PREFIX = "gateway/";

export type GatewayModel = Model<Api> & { documentInput?: "pdf" | "files" };

const state = perTenant(() => ({
  models: new Map<string, GatewayModel | EmbeddingModel>(),
  version: 0,
  snapshot: "[]",
  aliasedIds: new Set<string>(),
}));

export function isGatewayModelId(id: string): boolean {
  return id.startsWith(GATEWAY_MODEL_PREFIX);
}

export function gatewayModelsVersion(): number {
  return state().version;
}

export function setGatewayModels(
  next: readonly (GatewayModel | EmbeddingModel)[],
  aliases: readonly string[] = [],
): void {
  const current = state();
  const serialized = JSON.stringify([next, aliases]);
  if (serialized === current.snapshot) return;
  current.models = new Map(next.map((model) => [model.id, model]));
  current.aliasedIds = new Set(aliases);
  current.snapshot = serialized;
  current.version += 1;
}

export function resolveGatewayModel(id: string): GatewayModel | undefined {
  const model = state().models.get(id);
  return model && !isEmbeddingModel(model) ? model : undefined;
}

export function gatewayModelCatalog(includeAliased = false): Array<{ id: string; name: string; provider: string }> {
  const { models, aliasedIds } = state();
  return [...models.values()]
    .filter((m): m is GatewayModel => !isEmbeddingModel(m))
    .filter(({ id }) => includeAliased || !aliasedIds.has(id))
    .map(({ id, name, provider }) => ({ id, name, provider }));
}

export function gatewayModelsJson(): Record<string, unknown> {
  const chatModels = [...state().models.values()].filter((m): m is GatewayModel => !isEmbeddingModel(m));
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
  const model = state().models.get(id);
  return model && isEmbeddingModel(model) ? model : undefined;
}

export function gatewayEmbeddingModelIds(): string[] {
  return [...state().models.values()].filter(isEmbeddingModel).map((model) => model.id);
}
