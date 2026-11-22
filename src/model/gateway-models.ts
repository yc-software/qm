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

export function gatewayPresentation(id: string): { label: string; provider: string } | null {
  if (!isGatewayModelId(id)) return null;
  const name = id.split("/").at(-1)!;
  const family = /^(claude|gpt|gemini)-(.+)$/.exec(name);
  if (!family) return null;
  const words = family[2]!.replace(/^((?:[a-z]+-)*)(\d+)-(\d+)(?=-|$)/, "$1$2.$3").split("-");
  const title = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  const brand = {
    claude: { prefix: "", provider: "anthropic" },
    gpt: { prefix: "GPT-", provider: "openai" },
    gemini: { prefix: "Gemini ", provider: "google" },
  }[family[1] as "claude" | "gpt" | "gemini"];
  return { label: brand.prefix + title, provider: brand.provider };
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
