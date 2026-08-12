import { readFileSync } from "node:fs";
import type { ScopeId } from "../types.ts";

interface ScopeModels {
  models: string[];
  default?: string;
}

export interface EffectiveScopeModels {
  models: string[];
  defaultModel: string;
}

export interface ScopeModelPolicy {
  resolve(scope: ScopeId): EffectiveScopeModels;
  allows(scope: ScopeId, modelId: string): boolean;
}

function scopeModels(value: unknown, scope: string): ScopeModels {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${scope} must be an object`);
  const raw = value as { models?: unknown; default?: unknown };
  if (!Array.isArray(raw.models) || raw.models.some((model) => typeof model !== "string" || !model.trim()))
    throw new Error(`${scope}.models must be an array of non-empty model ids`);
  const models = [...new Set(raw.models.map((model) => String(model).trim()))];
  if (raw.default !== undefined && (typeof raw.default !== "string" || !raw.default.trim()))
    throw new Error(`${scope}.default must be a non-empty model id`);
  const defaultModel = typeof raw.default === "string" ? raw.default.trim() : undefined;
  if (defaultModel && !models.includes(defaultModel))
    throw new Error(`${scope}.default must appear in ${scope}.models`);
  return { models, ...(defaultModel ? { default: defaultModel } : {}) };
}

export function parseScopeModelPolicy(input: unknown, orgScope: ScopeId): ScopeModelPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("model scope policy must be an object");
  const raw = input as { version?: unknown; scopes?: unknown };
  if (raw.version !== 1) throw new Error("model scope policy version must be 1");
  if (!raw.scopes || typeof raw.scopes !== "object" || Array.isArray(raw.scopes))
    throw new Error("model scope policy scopes must be an object");
  const entries = new Map(
    Object.entries(raw.scopes as Record<string, unknown>).map(([scope, value]) => [scope, scopeModels(value, scope)]),
  );
  const org = entries.get(orgScope);
  const resolve = (scope: ScopeId): EffectiveScopeModels => {
    const local = scope === orgScope ? undefined : entries.get(scope);
    const models = [...new Set([...(org?.models ?? []), ...(local?.models ?? [])])];
    const defaultModel = local?.default ?? org?.default ?? models[0];
    if (!defaultModel) throw new Error(`no models are enabled for ${scope}`);
    return { models, defaultModel };
  };
  return { resolve, allows: (scope, modelId) => resolve(scope).models.includes(modelId) };
}

export function loadScopeModelPolicy(path: string, orgScope: ScopeId): ScopeModelPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot load MODEL_SCOPE_ALLOWLISTS ${path}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
  return parseScopeModelPolicy(parsed, orgScope);
}
