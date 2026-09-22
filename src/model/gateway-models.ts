import type { Api, Model } from "@earendil-works/pi-ai";

export const GATEWAY_PROVIDER = "qm:gateway";
export const GATEWAY_MODEL_PREFIX = "gateway/";

export type GatewayModel = Model<Api> & { documentInput?: "pdf" | "files" };

let models = new Map<string, GatewayModel>();
let version = 0;
let snapshot = "[]";
let aliasedIds = new Set<string>();

export function isGatewayModelId(id: string): boolean {
  return id.startsWith(GATEWAY_MODEL_PREFIX);
}

export function gatewayModelsVersion(): number {
  return version;
}

export function setGatewayModels(next: readonly GatewayModel[], aliases: readonly string[] = []): void {
  const serialized = JSON.stringify([next, aliases]);
  if (serialized === snapshot) return;
  models = new Map(next.map((model) => [model.id, model]));
  aliasedIds = new Set(aliases);
  snapshot = serialized;
  version += 1;
}

export function resolveGatewayModel(id: string): GatewayModel | undefined {
  return models.get(id);
}

export function gatewayModelCatalog(includeAliased = false): Array<{ id: string; name: string; provider: string }> {
  return [...models.values()]
    .filter(({ id }) => includeAliased || !aliasedIds.has(id))
    .map(({ id, name, provider }) => ({ id, name, provider }));
}

export function gatewayModelsJson(): Record<string, unknown> {
  const first = models.values().next().value;
  if (!first) return {};
  return {
    [GATEWAY_PROVIDER]: {
      name: "Model gateway",
      baseUrl: first.baseUrl,
      api: "openai-completions",
      models: [...models.values()].map(
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
