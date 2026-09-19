import { tenantState } from "../tenancy/context.ts";
import type { Api, Model } from "@earendil-works/pi-ai";

export const GATEWAY_PROVIDER = "qm:gateway";
export const GATEWAY_MODEL_PREFIX = "gateway/";

export type GatewayModel = Model<Api> & { documentInput?: "pdf" | "files" };

const GATEWAY_MODEL_STATE = Symbol("gateway-models");
const gatewayModelState = () =>
  tenantState(GATEWAY_MODEL_STATE, () => ({
    models: new Map<string, GatewayModel>(),
    version: 0,
    snapshot: "[]",
    aliasedIds: new Set<string>(),
  }));

export function isGatewayModelId(id: string): boolean {
  return id.startsWith(GATEWAY_MODEL_PREFIX);
}

export function gatewayModelsVersion(): number {
  return gatewayModelState().version;
}

export function setGatewayModels(next: readonly GatewayModel[], aliases: readonly string[] = []): void {
  const serialized = JSON.stringify([next, aliases]);
  if (serialized === gatewayModelState().snapshot) return;
  gatewayModelState().models = new Map(next.map((model) => [model.id, model]));
  gatewayModelState().aliasedIds = new Set(aliases);
  gatewayModelState().snapshot = serialized;
  gatewayModelState().version += 1;
}

export function resolveGatewayModel(id: string): GatewayModel | undefined {
  return gatewayModelState().models.get(id);
}

export function gatewayModelCatalog(includeAliased = false): Array<{ id: string; name: string; provider: string }> {
  return [...gatewayModelState().models.values()]
    .filter(({ id }) => includeAliased || !gatewayModelState().aliasedIds.has(id))
    .map(({ id, name, provider }) => ({ id, name, provider }));
}

export function gatewayModelsJson(): Record<string, unknown> {
  const first = gatewayModelState().models.values().next().value;
  if (!first) return {};
  return {
    [GATEWAY_PROVIDER]: {
      name: "Model gateway",
      baseUrl: first.baseUrl,
      api: "openai-completions",
      models: [...gatewayModelState().models.values()].map(
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
