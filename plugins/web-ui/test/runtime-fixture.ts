import { loadRuntimeConfig, seedRuntimeConfig } from "../src/runtime-config-store.ts";
import type { RuntimeConfig } from "../src/core-bridge.ts";
import { metadata } from "./model-metadata.ts";

export function runtimeConfig(scopeId: string, changes: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    scopeId,
    approvedHarnesses: ["pi"],
    modelsByHarness: { pi: ["model"] },
    modelCatalog: { model: metadata("model") },
    orgDefault: { harnessId: "pi", modelId: "model", revision: 2 },
    scopeOverride: { harnessId: "pi", modelId: "model", orgRevision: 1 },
    effective: { harnessId: "pi", modelId: "model" },
    upgradeAvailable: true,
    ...changes,
  };
}

export async function applyRuntimeOptions(
  scopeId: string | null,
  approvedHarnesses: RuntimeConfig["approvedHarnesses"],
  modelsByHarness: RuntimeConfig["modelsByHarness"],
  effective: RuntimeConfig["effective"],
  modelCatalog: RuntimeConfig["modelCatalog"],
): Promise<void> {
  const config = runtimeConfig(scopeId ?? "personal:test", {
    approvedHarnesses,
    modelsByHarness,
    effective,
    modelCatalog,
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json(config);
  try {
    seedRuntimeConfig(config.scopeId, config);
    await loadRuntimeConfig(config.scopeId, true);
  } finally {
    globalThis.fetch = original;
  }
}
