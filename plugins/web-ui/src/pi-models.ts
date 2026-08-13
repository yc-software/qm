import { getModel } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";

const KNOWN_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;

const CLONE_TEMPLATES: Readonly<Record<string, { template: string; name: string }>> = {
  "claude-fable-5": { template: "claude-opus-4-8", name: "Claude Fable 5" },
  "claude-opus-5": { template: "claude-opus-4-8", name: "Claude Opus 5" },
  "claude-sonnet-5": { template: "claude-sonnet-4-6", name: "Claude Sonnet 5" },
  "gpt-5.6-sol": { template: "gpt-5.5", name: "GPT-5.6 Sol" },
  "gpt-5.6-terra": { template: "gpt-5.5", name: "GPT-5.6 Terra" },
  "gpt-5.6-luna": { template: "gpt-5.5", name: "GPT-5.6 Luna" },
};

type PiModel = Model<Api>;

function builtinModel(id: string): PiModel | undefined {
  for (const provider of KNOWN_PROVIDERS) {
    const model = getModel(provider, id as Parameters<typeof getModel>[1]) as PiModel | undefined;
    if (model) return model;
  }
  return undefined;
}

export interface CatalogEntry {
  name: string;
  provider: string;
  api?: "openai-completions" | "anthropic-messages";
  baseUrl?: string;
}

const PROTOCOL_TEMPLATES: Readonly<Record<NonNullable<CatalogEntry["api"]>, { provider: string; id: string }>> = {
  "openai-completions": { provider: "openrouter", id: "openrouter/auto" },
  "anthropic-messages": { provider: "anthropic", id: "claude-opus-4-8" },
};

export function getBaseModel(id: string, fallback?: CatalogEntry): PiModel {
  const builtin = builtinModel(id);
  if (builtin) return builtin;
  const clone = CLONE_TEMPLATES[id];
  if (clone) {
    const template = builtinModel(clone.template);
    if (template) return cloneModel(template, id, clone.name);
  }
  if (fallback) {
    const protocol = PROTOCOL_TEMPLATES[fallback.api ?? "openai-completions"];
    const template = getModel(
      protocol.provider as Parameters<typeof getModel>[0],
      protocol.id as Parameters<typeof getModel>[1],
    ) as PiModel | undefined;
    if (template) return cloneModel(template, id, fallback.name, fallback);
  }
  throw new Error(`Unsupported model: ${id}`);
}

function cloneModel(model: PiModel, id: string, name: string, identity?: CatalogEntry): PiModel {
  const clone = { ...structuredClone(model), id, name };
  if (!identity) return clone;
  return {
    ...clone,
    provider: identity.provider,
    ...(identity.api ? { api: identity.api } : {}),
    ...(identity.baseUrl ? { baseUrl: identity.baseUrl } : {}),
  } as PiModel;
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
