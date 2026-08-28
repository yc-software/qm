import type { QmConfig } from "./config.ts";
import type { Target } from "./providers.ts";

/**
 * Per-target env defaults applied when a service env var is not set explicitly.
 * Keyed by hosting target so the compiler enumerates every gap when a target is added.
 */
export type TargetEnvDefaults = (config: QmConfig, service: string, name: string) => string | undefined;

export const FLY_TEMPLATE_ENV_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  core: { HARNESS: "pi" },
};

const AWS_RENDER_ENV_DEFAULTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  core: { SANDBOX_BACKEND: "aws" },
};

const declaredSandboxBackend: TargetEnvDefaults = (config, service, name) =>
  service === "core" && name === "SANDBOX_BACKEND" ? config.sandbox?.backend : undefined;

export const TARGET_ENV_DEFAULTS: Record<Target, TargetEnvDefaults> = {
  docker: declaredSandboxBackend,
  fly: (config, service, name) =>
    declaredSandboxBackend(config, service, name) ?? FLY_TEMPLATE_ENV_DEFAULTS[service]?.[name],
  aws: (config, service, name) =>
    declaredSandboxBackend(config, service, name) ?? AWS_RENDER_ENV_DEFAULTS[service]?.[name],
};
