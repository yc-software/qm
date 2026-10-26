import type { QmConfig } from "./config.ts";
import type { Target } from "./providers.ts";

/**
 * Per-target env defaults applied when a service env var is not set explicitly.
 * Keyed by hosting target so the compiler enumerates every gap when a target is added.
 */
export type TargetEnvDefaults = (config: QmConfig, service: string, name: string) => string | undefined;

const ENV_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  core: { HARNESS: "pi" },
};

const AWS_RENDER_ENV_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  core: { SANDBOX_BACKEND: "aws" },
};

export const TARGET_ENV_DEFAULTS: Record<Target, TargetEnvDefaults> = {
  docker: (_config, service, name) => ENV_DEFAULTS[service]?.[name],
  aws: (config, service, name) => {
    const rendered = AWS_RENDER_ENV_DEFAULTS[service]?.[name];
    if (rendered === undefined) return ENV_DEFAULTS[service]?.[name];
    if (name === "SANDBOX_BACKEND") return config.sandbox?.backend ?? rendered;
    return rendered;
  },
};
