import { isStrongSigningSecret } from "../auth/source-auth.ts";
import { boolEnvStrict, numEnvStrict } from "../util/env.ts";
import { assertFinnyFindingPolicy } from "./coordinator.ts";
import type { FinnyFindingPolicy } from "./types.ts";

export interface FinnyIntegrationConfig {
  signingSecret: string;
  findingPolicy: FinnyFindingPolicy;
  maxReworks: number;
  workerGrantTtlMs: number;
}

const REQUIRED = [
  "FINNY_SIGNING_SECRET",
  "FINNY_FINDING_POLICY_VERSION",
  "FINNY_MAX_FINDINGS",
  "FINNY_MAX_FINDING_CODE_LENGTH",
  "FINNY_MAX_FINDING_MESSAGE_LENGTH",
  "FINNY_MAX_REWORKS",
  "FINNY_WORKER_GRANT_TTL_MS",
] as const;

function required(env: NodeJS.ProcessEnv, name: (typeof REQUIRED)[number]): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when FINNY_ENABLED=true`);
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: (typeof REQUIRED)[number]): number {
  required(env, name);
  const value = numEnvStrict(name, env[name]);
  if (!Number.isSafeInteger(value) || value! < 1) throw new Error(`${name} must be a positive integer`);
  return value!;
}

export function finnyIntegrationConfigFromEnv(env: NodeJS.ProcessEnv): FinnyIntegrationConfig | undefined {
  if (!(boolEnvStrict("FINNY_ENABLED", env.FINNY_ENABLED) ?? false)) return undefined;
  for (const name of REQUIRED) required(env, name);
  const signingSecret = required(env, "FINNY_SIGNING_SECRET");
  const secretReused = Object.entries(env).some(
    ([name, value]) => name !== "FINNY_SIGNING_SECRET" && value === signingSecret,
  );
  if (!isStrongSigningSecret(signingSecret) || secretReused)
    throw new Error("FINNY_SIGNING_SECRET must be a strong dedicated signing secret");
  const findingPolicy = {
    id: required(env, "FINNY_FINDING_POLICY_VERSION"),
    maxFindings: positiveInteger(env, "FINNY_MAX_FINDINGS"),
    maxCodeLength: positiveInteger(env, "FINNY_MAX_FINDING_CODE_LENGTH"),
    maxMessageLength: positiveInteger(env, "FINNY_MAX_FINDING_MESSAGE_LENGTH"),
  };
  assertFinnyFindingPolicy(findingPolicy);
  return {
    signingSecret,
    findingPolicy,
    maxReworks: positiveInteger(env, "FINNY_MAX_REWORKS"),
    workerGrantTtlMs: positiveInteger(env, "FINNY_WORKER_GRANT_TTL_MS"),
  };
}
