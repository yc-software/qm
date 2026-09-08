import type { Api, Model } from "@earendil-works/pi-ai";

export type ModelMetadata = Pick<
  Model<Api>,
  "id" | "name" | "provider" | "api" | "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens"
> & {
  label: string;
  buttonLabel: string;
  fastMode: boolean;
};

export function getBaseModel(id: string, metadata?: ModelMetadata): Model<Api> {
  if (!metadata || metadata.id !== id) throw new Error(`Model metadata unavailable: ${id}`);
  return { ...structuredClone(metadata), baseUrl: "" };
}

const fastModeByScope = new Map<string, Set<string>>();
let lastFastModeIds = new Set<string>();

export function setFastModeModelIds(scopeKey: string | null, ids: readonly string[] | undefined): void {
  lastFastModeIds = new Set(ids ?? []);
  if (scopeKey !== null) fastModeByScope.set(scopeKey, lastFastModeIds);
}

export function modelSupportsFastMode(scopeKey: string | null, modelId: string | undefined): boolean {
  const ids = (scopeKey !== null ? fastModeByScope.get(scopeKey) : undefined) ?? lastFastModeIds;
  return !!modelId && ids.has(modelId);
}
