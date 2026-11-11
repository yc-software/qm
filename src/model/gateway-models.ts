import type { EmbeddingModel } from "./model-overlay.ts";
import { isEmbeddingModel } from "./model-overlay.ts";
import type { Api, Model } from "@earendil-works/pi-ai";

export const GATEWAY_PROVIDER = "qm:gateway";
export const GATEWAY_MODEL_PREFIX = "gateway/";

export type GatewayModel = Model<Api> & { documentInput?: "pdf" | "files"; fastMode?: boolean };

const gateway: {
  models: Map<string, GatewayModel | EmbeddingModel>;
  version: number;
  snapshot: string;
  aliasedIds: Set<string>;
} = { models: new Map(), version: 0, snapshot: "[]", aliasedIds: new Set() };

export function isGatewayModelId(id: string): boolean {
  return id.startsWith(GATEWAY_MODEL_PREFIX);
}

export function gatewayUpstreamModelId(id: string): string | undefined {
  const [, ...model] = isGatewayModelId(id) ? id.slice(GATEWAY_MODEL_PREFIX.length).split("/") : [];
  return model.length ? model.join("/") : undefined;
}

export function gatewayModelsVersion(): number {
  return gateway.version;
}

export function setGatewayModels(
  next: readonly (GatewayModel | EmbeddingModel)[],
  aliases: readonly string[] = [],
): void {
  const state = gateway;
  const serialized = JSON.stringify([next, aliases]);
  if (serialized === state.snapshot) return;
  state.models = new Map(next.map((model) => [model.id, model]));
  state.aliasedIds = new Set(aliases);
  state.snapshot = serialized;
  state.version += 1;
}

export function resolveGatewayModel(id: string): GatewayModel | undefined {
  const model = gateway.models.get(id);
  return model && !isEmbeddingModel(model) ? model : undefined;
}

export function gatewayModelCatalog(includeAliased = false): Array<{ id: string; name: string; provider: string }> {
  return [...gateway.models.values()]
    .filter((m): m is GatewayModel => !isEmbeddingModel(m))
    .filter(({ id }) => includeAliased || !gateway.aliasedIds.has(id))
    .map(({ id, name, provider }) => ({ id, name, provider }));
}

export function gatewayModelsJson(): Record<string, unknown> {
  const chatModels = [...gateway.models.values()].filter((m): m is GatewayModel => !isEmbeddingModel(m));
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
  const model = gateway.models.get(id);
  return model && isEmbeddingModel(model) ? model : undefined;
}

export function gatewayEmbeddingModelIds(): string[] {
  return [...gateway.models.values()].filter(isEmbeddingModel).map((model) => model.id);
}
