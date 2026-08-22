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

export function getBaseModel(id: string, fallback?: { name: string; provider: string }): PiModel {
  const builtin = builtinModel(id);
  if (builtin) return builtin;
  const clone = CLONE_TEMPLATES[id];
  if (clone) {
    const template = builtinModel(clone.template);
    if (template) return cloneModel(template, id, clone.name);
  }
  if (fallback) {
    const template = getModel("openrouter", "openrouter/auto" as Parameters<typeof getModel>[1]) as PiModel | undefined;
    if (template) return { ...cloneModel(template, id, fallback.name), provider: fallback.provider };
  }
  throw new Error(`Unsupported model: ${id}`);
}

/**
 * Effort levels a model can actually run, per its pi-ai capabilities:
 * `reasoning: false` leaves only the provider default ("auto"), and a `null`
 * entry in `thinkingLevelMap` marks that level as unsupported. "ultracode"
 * aliases to "max" at turn time, so it tracks "max" support.
 */
export function supportedEffortLevels(model: PiModel): string[] {
  if (!model.reasoning) return ["auto"];
  const map = (model.thinkingLevelMap ?? {}) as Partial<Record<string, string | null>>;
  const levels: string[] = ["auto"];
  for (const level of ["low", "medium", "high", "xhigh", "max"]) {
    if (map[level] !== null) levels.push(level);
  }
  if (map.max !== null) levels.push("ultracode");
  return levels;
}

function cloneModel(model: PiModel, id: string, name: string): PiModel {
  return { ...structuredClone(model), id, name };
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
