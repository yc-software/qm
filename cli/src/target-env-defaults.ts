import type { QmConfig } from "./config.ts";
import type { Target } from "./providers.ts";

/**
 * Per-target env defaults applied when a service env var is not set explicitly.
 * Keyed by hosting target so the compiler enumerates every gap when a target is added.
 */
export type TargetEnvDefaults = (config: QmConfig, service: string, name: string) => string | undefined;

export const TARGET_ENV_DEFAULTS: Record<Target, TargetEnvDefaults> = {
  docker: () => undefined,
  fly: () => undefined,
  render: () => undefined,
  aws: (config, service, name) =>
    service === "core" && name === "SANDBOX_BACKEND" ? config.sandbox?.backend : undefined,
};
