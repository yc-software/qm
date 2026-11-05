import type { ModelMetadata } from "./pi-models.ts";

export interface RuntimeConfig {
  interactiveFastMode?: boolean;
  unavailableReason?: string;
  scopeId: string;
  models: string[];
  modelCatalog: Record<string, ModelMetadata>;
  orgDefault: { modelId: string; effortLevel?: string; fastMode?: boolean; revision: number };
  scopeOverride: {
    modelId: string;
    effortLevel?: string;
    fastMode?: boolean;
    orgRevision?: number;
  } | null;
  effective: { modelId: string; effortLevel?: string; fastMode?: boolean };
  upgradeAvailable: boolean;
  fastModeModelIds?: string[];
}

export type RuntimeChange = {
  modelId?: string;
  effortLevel?: string;
  fastMode?: boolean;
  inherit?: boolean;
  keep?: boolean;
};

const configs = new Map<string, RuntimeConfig>();
let bootScope: string | null = null;

export function getRuntimeConfig(scopeId: string | null = bootScope): RuntimeConfig | null {
  return scopeId === null ? null : (configs.get(scopeId) ?? null);
}

export function setRuntimeBootScope(scopeId: string): void {
  bootScope = scopeId;
}

export function cacheRuntimeConfig(scopeId: string, config: RuntimeConfig | null): void {
  if (config) configs.set(scopeId, config);
  else configs.delete(scopeId);
}

export function checkedRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  const missing = [
    Array.isArray(config.models) ? null : "models list",
    typeof config.effective === "object" && config.effective !== null ? null : "effective selection",
  ].filter(Boolean);
  if (!missing.length) return config;
  const shape = new Error(`runtime config lacks ${missing.join(" and ")}; keys: ${Object.keys(config).join(", ")}`);
  throw new Error("Model settings came back in a form this page can't read. Reload the page to continue.", {
    cause: shape,
  });
}
