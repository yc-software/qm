import type { ModelMetadata } from "./pi-models.ts";

export interface RuntimeConfig {
  interactiveFastMode?: boolean;
  unavailableReason?: string;
  scopeId: string;
  approvedHarnesses: string[];
  modelsByHarness: Record<string, string[]>;
  modelCatalog: Record<string, ModelMetadata>;
  orgDefault: { harnessId: string; modelId: string; effortLevel?: string; fastMode?: boolean; revision: number };
  scopeOverride: {
    harnessId: string;
    modelId: string;
    effortLevel?: string;
    fastMode?: boolean;
    orgRevision: number;
  } | null;
  effective: { harnessId: string; modelId: string; effortLevel?: string; fastMode?: boolean };
  upgradeAvailable: boolean;
  fastModeModelIds?: string[];
}

export type RuntimeChange = {
  harnessId?: string;
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
