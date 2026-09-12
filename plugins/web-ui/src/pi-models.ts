import { getRuntimeConfig } from "./runtime-config-store.ts";
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

export function modelSupportsFastMode(scopeKey: string | null, modelId: string | undefined): boolean {
  return !!modelId && (getRuntimeConfig(scopeKey)?.fastModeModelIds?.includes(modelId) ?? false);
}
