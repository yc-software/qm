import { isStrongSigningSecret } from "../auth/source-auth.ts";
import { boolEnvStrict, numEnvStrict } from "../util/env.ts";
import { assertFinnyFindingPolicy } from "./coordinator.ts";
import type { FinnyEvaluatorRef, FinnyFindingPolicy } from "./types.ts";

export interface FinnySpreadsheetEngineConfig {
  url: string;
  name: string;
  version: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxArtifactBytes: number;
  evaluator: FinnyEvaluatorRef;
}

export interface FinnyIntegrationConfig {
  signingSecret: string;
  findingPolicy: FinnyFindingPolicy;
  maxReworks: number;
  workerGrantTtlMs: number;
  spreadsheetEngine: FinnySpreadsheetEngineConfig;
  maxEvidenceBytes: number;
}

const REQUIRED = [
  "FINNY_SIGNING_SECRET",
  "FINNY_FINDING_POLICY_VERSION",
  "FINNY_MAX_FINDINGS",
  "FINNY_MAX_FINDING_CODE_LENGTH",
  "FINNY_MAX_FINDING_MESSAGE_LENGTH",
  "FINNY_MAX_REWORKS",
  "FINNY_WORKER_GRANT_TTL_MS",
  "FINNY_SPREADSHEET_ENGINE_URL",
  "FINNY_SPREADSHEET_ENGINE_NAME",
  "FINNY_SPREADSHEET_ENGINE_VERSION",
  "FINNY_SPREADSHEET_ENGINE_TIMEOUT_MS",
  "FINNY_SPREADSHEET_ENGINE_MAX_RESPONSE_BYTES",
  "FINNY_SPREADSHEET_ENGINE_MAX_ARTIFACT_BYTES",
  "FINNY_SPREADSHEET_EVALUATOR_ID",
  "FINNY_SPREADSHEET_EVALUATOR_REVISION",
  "FINNY_SPREADSHEET_EVALUATOR_BUILD_DIGEST",
  "FINNY_SPREADSHEET_EVALUATOR_CONTRACT_VERSION",
  "FINNY_SPREADSHEET_EVALUATOR_CONFIGURATION_DIGEST",
  "FINNY_MAX_EVIDENCE_BYTES",
] as const;

function required(env: NodeJS.ProcessEnv, name: (typeof REQUIRED)[number]): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when FINNY_ENABLED=true`);
  return value;
}

function sha256Digest(env: NodeJS.ProcessEnv, name: (typeof REQUIRED)[number]): string {
  const value = required(env, name);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
  return value;
}

function evaluatorContractVersion(env: NodeJS.ProcessEnv): string {
  const value = required(env, "FINNY_SPREADSHEET_EVALUATOR_CONTRACT_VERSION");
  if (value !== "finny.spreadsheet-worker.v2") {
    throw new Error("FINNY_SPREADSHEET_EVALUATOR_CONTRACT_VERSION must be finny.spreadsheet-worker.v2");
  }
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
  const spreadsheetEngineUrl = required(env, "FINNY_SPREADSHEET_ENGINE_URL");
  try {
    const url = new URL(spreadsheetEngineUrl);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash ||
      url.hostname.endsWith(".")
    ) {
      throw new Error("url");
    }
  } catch {
    throw new Error(
      "FINNY_SPREADSHEET_ENGINE_URL must be an HTTPS URL without credentials, a fragment, or a trailing hostname dot",
    );
  }
  return {
    signingSecret,
    findingPolicy,
    maxReworks: positiveInteger(env, "FINNY_MAX_REWORKS"),
    workerGrantTtlMs: positiveInteger(env, "FINNY_WORKER_GRANT_TTL_MS"),
    spreadsheetEngine: {
      url: spreadsheetEngineUrl,
      name: required(env, "FINNY_SPREADSHEET_ENGINE_NAME"),
      version: required(env, "FINNY_SPREADSHEET_ENGINE_VERSION"),
      timeoutMs: positiveInteger(env, "FINNY_SPREADSHEET_ENGINE_TIMEOUT_MS"),
      maxResponseBytes: positiveInteger(env, "FINNY_SPREADSHEET_ENGINE_MAX_RESPONSE_BYTES"),
      maxArtifactBytes: positiveInteger(env, "FINNY_SPREADSHEET_ENGINE_MAX_ARTIFACT_BYTES"),
      evaluator: {
        id: required(env, "FINNY_SPREADSHEET_EVALUATOR_ID"),
        revision: required(env, "FINNY_SPREADSHEET_EVALUATOR_REVISION"),
        buildDigest: sha256Digest(env, "FINNY_SPREADSHEET_EVALUATOR_BUILD_DIGEST"),
        contractVersion: evaluatorContractVersion(env),
        configurationDigest: sha256Digest(env, "FINNY_SPREADSHEET_EVALUATOR_CONFIGURATION_DIGEST"),
      },
    },
    maxEvidenceBytes: positiveInteger(env, "FINNY_MAX_EVIDENCE_BYTES"),
  };
}
