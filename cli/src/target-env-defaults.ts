import type { QmConfig } from "./config.ts";
import type { Target } from "./providers.ts";

/**
 * Per-target env defaults applied when a service env var is not set explicitly.
 * Keyed by hosting target so the compiler enumerates every gap when a target is added.
 */
export type TargetEnvDefaults = (config: QmConfig, service: string, name: string) => string | undefined;

export const FLY_TEMPLATE_ENV_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  core: { HARNESS: "pi", SANDBOX_BACKEND: "sprites" },
};

const AWS_RENDER_ENV_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  core: { SANDBOX_BACKEND: "aws" },
};

const renderedEnvDefaults =
  (defaults: Readonly<Record<string, Readonly<Record<string, string>>>>): TargetEnvDefaults =>
  (config, service, name) => {
    const rendered = defaults[service]?.[name];
    if (rendered === undefined) return undefined;
    if (name === "SANDBOX_BACKEND") return config.sandbox?.backend ?? rendered;
    return rendered;
  };

export const TARGET_ENV_DEFAULTS: Record<Target, TargetEnvDefaults> = {
  docker: () => undefined,
  fly: renderedEnvDefaults(FLY_TEMPLATE_ENV_DEFAULTS),
  aws: renderedEnvDefaults(AWS_RENDER_ENV_DEFAULTS),
};
