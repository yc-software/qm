import { existsSync, readdirSync } from "node:fs";
import { providerBaseUrlsFromEnv, type ProviderBaseUrls } from "./model/provider-endpoints.ts";
import { join, resolve } from "node:path";
import {
  parseMemoryCaptureMode,
  parseMemoryRecallMode,
  type MemoryCaptureMode,
  type MemoryRecallMode,
} from "./memory/policy.ts";
import { parseMemoryStrategyKind, type MemoryStrategyKind } from "./memory/strategy.ts";
import { validateCoreSecretEnv } from "./deployment/secret-schema.ts";
import { DEFAULT_CAPTURE_QUIET_MS } from "./memory/strategies/per-turn.ts";
import { parseSecurityPosture, type SecurityPosture } from "./security/security-posture.ts";
import { slackPluginConfigFromEnv, type SlackPluginConfig } from "./slack/config.ts";
import {
  MODEL_PROVIDERS,
  defaultModelForProvider,
  isModelProvider,
  onlyProvider,
  type ModelProvider,
  type ModelProviderAvailability,
} from "./model/pi-models.ts";

export interface Config {
  production: boolean;
  allowUnauthenticatedCore: boolean;
  port: number;
  dataDir: string;
  orgId: string;
  sessionStore: "memory" | "postgres";
  databaseUrl?: string;
  harness: "mock" | "pi" | "opencode" | "codex" | "claude";
  securityPosture: SecurityPosture;
  sandboxBackend: "aws" | "local" | "sprites";
  sandboxSecondaryBackend?: "aws" | "local" | "sprites";
  deployProvider: "docker" | "aws";
  egressServiceHosts?: string[];
  brandingDefault?: { accent?: string; mark?: string; selfLabel?: string };
  modelId?: string;
  opencodeModel?: string;
  codexModel?: string;
  codexBinPath?: string;
  codexProcessEnv: NodeJS.ProcessEnv;
  claudeModel?: string;
  claudeBinPath?: string;
  claudeProcessEnv: NodeJS.ProcessEnv;
  detectModelId?: string;
  titleModelId?: string;
  judgeModelId?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openrouterApiKey?: string;
  modelProvider?: ModelProvider;
  providerBaseUrls: ProviderBaseUrls;
  piCaptureRequests: boolean;
  piSystemCacheSplit: boolean;
  sessionTapeMode: "shadow" | "serve";
  adminGrants?: string;
  rateLimitPerWindow: number;
  rateLimitWindowMs: number;
  budgetUsdPerWindow?: number;
  orgBudgetUsdPerWindow?: number;
  budgetWindowMs: number;
  maxContextEntries?: number;
  maxContextTokens?: number;
  execTimeoutDefaultMs: number;
  execTimeoutMaxMs: number;
  turnWallClockMs: number;
  runMaxAgeMs: number;
  runWaitMs: number;
  backgroundJobTtlMs: number;
  backgroundJobTtlMaxMs: number;
  backgroundWorkEnabled: boolean;
  buildSha?: string;
  ecsTaskProtection: boolean;
  ecsAgentUri?: string;
  monitorPollMs: number;
  skillSyncPollMs: number;
  monitorHeartbeatMs: number;
  signingSecret?: string;
  capabilitySecret?: string;
  portalIdentitySecret?: string;
  requireSignedPortalIdentity?: boolean;
  connectorSecretKey?: string;
  secretsBackend: "env" | "aws";
  secretsPrefix: string;
  apiBaseUrl?: string;
  publicUrl?: string;
  publicWebUrl?: string;
  flyAppName?: string;
  slack?: SlackPluginConfig;
  runStore: "memory" | "postgres";
  skillSigningSecret?: string;
  seedSkills: boolean;
  skillsSeedDir: string;
  pluginSkillDirs: string[];
  deploymentLayerDir?: string;
  layerEnv?: Readonly<Record<string, string | undefined>>;
  snapshotStore: "local" | "s3";
  transferStore: "local" | "s3";
  s3Bucket?: string;
  s3Region?: string;
  s3Prefix?: string;
  deployIdleTtlMs?: number;
  deployGitDir: string;
  deployDialTimeoutMs: number;
  deployAppsSessionSecret?: string;
  deployAppsLoginUrl?: string;
  deepIdleMachineMs: number;
  devIdleMachineMs: number;
  cronFireConcurrency: number;
  memoryRecall: MemoryRecallMode;
  memoryCapture: MemoryCaptureMode;
  memoryStrategy: MemoryStrategyKind;
  memoryConsolidateAfter?: number;
  memoryCaptureQuietMs: number;
  memoryCaptureMaxTurns?: number;
  workers: number;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  reaperIntervalMs: number;
  shutdownDrainMs: number;
  maxAttempts: number;
  maxClaims: number;
  processReaperIntervalMs: number;
  approvalSummaryTimeoutMs: number;
  securityScreenTimeoutMs: number;
  securityScreenBackend: "model" | "proxy";
  securityScreenProxy?: {
    provider: string;
    endpoint: string;
    token: string;
    shadow: boolean;
  };
  insightsIntervalMs: number;
  reachDeniedNotifyChannel?: string;
  scratchExecEnabled: boolean;
  reachExecEnabled: boolean;
  sharedOwnerAuthIsolation: boolean;
  surfaceDebugFooter: boolean;
  eagerProvisionEnabled: boolean;
  awsSandbox: AwsSandboxEnv;
  localSandbox: LocalSandboxEnv;
  spritesSandbox: SpritesSandboxEnv;
  awsDeploy: AwsDeployEnv;
}

export function configuredModelForHarness(config: Config, harness: string): string | undefined {
  if (harness === "codex") return config.codexModel;
  if (harness === "claude") return config.claudeModel;
  if (harness === "opencode") return config.opencodeModel;
  return config.modelId;
}

export function providerKeysPresent(config: Config): ModelProviderAvailability {
  return {
    anthropic: Boolean(config.anthropicApiKey),
    openai: Boolean(config.openaiApiKey),
    openrouter: Boolean(config.openrouterApiKey),
  };
}

export function baseModelProviders(config: Config): ModelProviderAvailability | undefined {
  return config.modelProvider ? onlyProvider(config.modelProvider) : undefined;
}

interface AwsSandboxEnv {
  region: string;
  profile?: string;
  imageIdentifier: string;
  imageVersion?: string;
  executionRoleArn?: string;
  ingressConnectorArns?: string[];
  egressConnectorArns?: string[];
  s3Bucket?: string;
  s3Prefix?: string;
  agentPort?: number;
  maxIdleDurationSeconds?: number;
  suspendedDurationSeconds?: number;
  maximumDurationInSeconds?: number;
  rotateAfterSeconds?: number;
  snapshotIntervalMs?: number;
  defaultTimeoutSec?: number;
  cpus?: number;
  memoryMb?: number;
  diskGb?: number;
}

function awsSandboxEnv(env: NodeJS.ProcessEnv): AwsSandboxEnv {
  const csv = (s: string | undefined): string[] | undefined =>
    s
      ? s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : undefined;
  const ingress = csv(env.AWS_SANDBOX_INGRESS_CONNECTORS);
  const egress = csv(env.AWS_SANDBOX_EGRESS_CONNECTORS);
  return {
    region: env.AWS_SANDBOX_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-west-2",
    ...(env.AWS_SANDBOX_PROFILE ? { profile: env.AWS_SANDBOX_PROFILE } : {}),
    imageIdentifier: env.AWS_SANDBOX_IMAGE ?? "qm-microvm-sandbox",
    ...(env.AWS_SANDBOX_IMAGE_VERSION ? { imageVersion: env.AWS_SANDBOX_IMAGE_VERSION } : {}),
    ...(env.AWS_SANDBOX_EXEC_ROLE_ARN ? { executionRoleArn: env.AWS_SANDBOX_EXEC_ROLE_ARN } : {}),
    ...(ingress ? { ingressConnectorArns: ingress } : {}),
    ...(egress ? { egressConnectorArns: egress } : {}),
    ...(env.AWS_SANDBOX_S3_BUCKET ? { s3Bucket: env.AWS_SANDBOX_S3_BUCKET } : {}),
    ...(env.AWS_SANDBOX_S3_PREFIX ? { s3Prefix: env.AWS_SANDBOX_S3_PREFIX } : {}),
    ...(numEnvStrict("AWS_SANDBOX_AGENT_PORT", env.AWS_SANDBOX_AGENT_PORT) !== undefined
      ? { agentPort: numEnvStrict("AWS_SANDBOX_AGENT_PORT", env.AWS_SANDBOX_AGENT_PORT) }
      : {}),
    ...(numEnvStrict("AWS_SANDBOX_MAX_IDLE_SEC", env.AWS_SANDBOX_MAX_IDLE_SEC) !== undefined
      ? { maxIdleDurationSeconds: numEnvStrict("AWS_SANDBOX_MAX_IDLE_SEC", env.AWS_SANDBOX_MAX_IDLE_SEC) }
      : {}),
    ...(numEnvStrict("AWS_SANDBOX_SUSPENDED_SEC", env.AWS_SANDBOX_SUSPENDED_SEC) !== undefined
      ? { suspendedDurationSeconds: numEnvStrict("AWS_SANDBOX_SUSPENDED_SEC", env.AWS_SANDBOX_SUSPENDED_SEC) }
      : {}),
    ...(numEnvStrict("AWS_SANDBOX_MAX_DURATION_SEC", env.AWS_SANDBOX_MAX_DURATION_SEC) !== undefined
      ? { maximumDurationInSeconds: numEnvStrict("AWS_SANDBOX_MAX_DURATION_SEC", env.AWS_SANDBOX_MAX_DURATION_SEC) }
      : {}),
    ...(numEnvStrict("AWS_SANDBOX_ROTATE_AFTER_SEC", env.AWS_SANDBOX_ROTATE_AFTER_SEC) !== undefined
      ? { rotateAfterSeconds: numEnvStrict("AWS_SANDBOX_ROTATE_AFTER_SEC", env.AWS_SANDBOX_ROTATE_AFTER_SEC) }
      : {}),
    ...(numEnvStrict("AWS_SANDBOX_SNAPSHOT_INTERVAL_MS", env.AWS_SANDBOX_SNAPSHOT_INTERVAL_MS) !== undefined
      ? { snapshotIntervalMs: numEnvStrict("AWS_SANDBOX_SNAPSHOT_INTERVAL_MS", env.AWS_SANDBOX_SNAPSHOT_INTERVAL_MS) }
      : {}),
    ...(numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC) !== undefined
      ? { defaultTimeoutSec: numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC) }
      : {}),
    ...(numEnvStrict("AWS_SANDBOX_CPUS", env.AWS_SANDBOX_CPUS) !== undefined
      ? { cpus: numEnvStrict("AWS_SANDBOX_CPUS", env.AWS_SANDBOX_CPUS) }
      : {}),
    ...(numEnvStrict("AWS_SANDBOX_MEMORY_MB", env.AWS_SANDBOX_MEMORY_MB) !== undefined
      ? { memoryMb: numEnvStrict("AWS_SANDBOX_MEMORY_MB", env.AWS_SANDBOX_MEMORY_MB) }
      : {}),
    ...(numEnvStrict("AWS_SANDBOX_DISK_GB", env.AWS_SANDBOX_DISK_GB) !== undefined
      ? { diskGb: numEnvStrict("AWS_SANDBOX_DISK_GB", env.AWS_SANDBOX_DISK_GB) }
      : {}),
  };
}

interface LocalSandboxEnv {
  image?: string;
  dockerBin?: string;
  cpus?: number;
  memoryMb?: number;
  defaultTimeoutSec?: number;
  peerNetwork?: string;
}

function localSandboxEnv(env: NodeJS.ProcessEnv): LocalSandboxEnv {
  return {
    ...(env.LOCAL_SANDBOX_IMAGE ? { image: env.LOCAL_SANDBOX_IMAGE } : {}),
    ...(env.LOCAL_SANDBOX_DOCKER_BIN ? { dockerBin: env.LOCAL_SANDBOX_DOCKER_BIN } : {}),
    ...(env.LOCAL_SANDBOX_PEER_NETWORK ? { peerNetwork: env.LOCAL_SANDBOX_PEER_NETWORK } : {}),
    ...(numEnvStrict("LOCAL_SANDBOX_CPUS", env.LOCAL_SANDBOX_CPUS) !== undefined
      ? { cpus: numEnvStrict("LOCAL_SANDBOX_CPUS", env.LOCAL_SANDBOX_CPUS) }
      : {}),
    ...(numEnvStrict("LOCAL_SANDBOX_MEMORY_MB", env.LOCAL_SANDBOX_MEMORY_MB) !== undefined
      ? { memoryMb: numEnvStrict("LOCAL_SANDBOX_MEMORY_MB", env.LOCAL_SANDBOX_MEMORY_MB) }
      : {}),
    ...(numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC) !== undefined
      ? { defaultTimeoutSec: numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC) }
      : {}),
  };
}

interface SpritesSandboxEnv {
  token?: string;
  baseUrl?: string;
  namePrefix?: string;
  egressProxyUrl?: string;
  defaultTimeoutSec?: number;
}

function spritesSandboxEnv(env: NodeJS.ProcessEnv): SpritesSandboxEnv {
  return {
    ...(env.SPRITES_TOKEN ? { token: env.SPRITES_TOKEN } : {}),
    ...(env.SPRITES_BASE_URL ? { baseUrl: env.SPRITES_BASE_URL } : {}),
    ...(env.SPRITES_NAME_PREFIX ? { namePrefix: env.SPRITES_NAME_PREFIX } : {}),
    ...(env.SPRITES_EGRESS_PROXY_URL ? { egressProxyUrl: env.SPRITES_EGRESS_PROXY_URL } : {}),
    ...(numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC) !== undefined
      ? { defaultTimeoutSec: numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC) }
      : {}),
  };
}

interface AwsDeployEnv {
  region: string;
  profile?: string;
  imageIdentifier: string;
  imageVersion?: string;
  executionRoleArn?: string;
  ingressConnectorArns?: string[];
  egressConnectorArns?: string[];
  agentPort?: number;
  appPort?: number;
  maximumDurationInSeconds?: number;
  rotateAfterSeconds?: number;
  maxIdleDurationSeconds?: number;
  suspendedDurationSeconds?: number;
  appsDomain?: string;
  gateSecret?: string;
  tokenTtlMinutes?: number;
  dataBucket?: string;
  dataPrefix?: string;
  snapshotIntervalMs?: number;
  dataRoleArn?: string;
}

function deployAppsEnv(env: NodeJS.ProcessEnv): { deployAppsSessionSecret?: string; deployAppsLoginUrl?: string } {
  const secret = env.DEPLOY_APPS_SESSION_SECRET;
  const loginUrl = env.DEPLOY_APPS_LOGIN_URL;
  if (!!secret !== !!loginUrl) {
    throw new Error("DEPLOY_APPS_SESSION_SECRET and DEPLOY_APPS_LOGIN_URL must be set together");
  }
  if (!secret || !loginUrl) return {};
  return { deployAppsSessionSecret: secret, deployAppsLoginUrl: loginUrl.replace(/\/$/, "") };
}

function awsDeployEnv(env: NodeJS.ProcessEnv): AwsDeployEnv {
  const csv = (s: string | undefined): string[] | undefined =>
    s
      ? s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : undefined;
  const ingress = csv(env.AWS_DEPLOY_INGRESS_CONNECTORS);
  const egress = csv(env.AWS_DEPLOY_EGRESS_CONNECTORS);
  return {
    region: env.AWS_DEPLOY_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-west-2",
    ...(env.AWS_DEPLOY_PROFILE ? { profile: env.AWS_DEPLOY_PROFILE } : {}),
    imageIdentifier: env.AWS_DEPLOY_IMAGE ?? "qm-microvm-sandbox",
    ...(env.AWS_DEPLOY_IMAGE_VERSION ? { imageVersion: env.AWS_DEPLOY_IMAGE_VERSION } : {}),
    ...(env.AWS_DEPLOY_EXEC_ROLE_ARN ? { executionRoleArn: env.AWS_DEPLOY_EXEC_ROLE_ARN } : {}),
    ...(ingress ? { ingressConnectorArns: ingress } : {}),
    ...(egress ? { egressConnectorArns: egress } : {}),
    ...(numEnvStrict("AWS_DEPLOY_AGENT_PORT", env.AWS_DEPLOY_AGENT_PORT) !== undefined
      ? { agentPort: numEnvStrict("AWS_DEPLOY_AGENT_PORT", env.AWS_DEPLOY_AGENT_PORT) }
      : {}),
    ...(numEnvStrict("AWS_DEPLOY_APP_PORT", env.AWS_DEPLOY_APP_PORT) !== undefined
      ? { appPort: numEnvStrict("AWS_DEPLOY_APP_PORT", env.AWS_DEPLOY_APP_PORT) }
      : {}),
    ...(numEnvStrict("AWS_DEPLOY_MAX_DURATION_SEC", env.AWS_DEPLOY_MAX_DURATION_SEC) !== undefined
      ? { maximumDurationInSeconds: numEnvStrict("AWS_DEPLOY_MAX_DURATION_SEC", env.AWS_DEPLOY_MAX_DURATION_SEC) }
      : {}),
    ...(numEnvStrict("AWS_DEPLOY_ROTATE_AFTER_SEC", env.AWS_DEPLOY_ROTATE_AFTER_SEC) !== undefined
      ? { rotateAfterSeconds: numEnvStrict("AWS_DEPLOY_ROTATE_AFTER_SEC", env.AWS_DEPLOY_ROTATE_AFTER_SEC) }
      : {}),
    ...(numEnvStrict("AWS_DEPLOY_MAX_IDLE_SEC", env.AWS_DEPLOY_MAX_IDLE_SEC) !== undefined
      ? { maxIdleDurationSeconds: numEnvStrict("AWS_DEPLOY_MAX_IDLE_SEC", env.AWS_DEPLOY_MAX_IDLE_SEC) }
      : {}),
    ...(numEnvStrict("AWS_DEPLOY_SUSPENDED_SEC", env.AWS_DEPLOY_SUSPENDED_SEC) !== undefined
      ? { suspendedDurationSeconds: numEnvStrict("AWS_DEPLOY_SUSPENDED_SEC", env.AWS_DEPLOY_SUSPENDED_SEC) }
      : {}),
    ...(env.AWS_DEPLOY_APPS_DOMAIN ? { appsDomain: env.AWS_DEPLOY_APPS_DOMAIN } : {}),
    ...(env.AWS_DEPLOY_GATE_SECRET ? { gateSecret: env.AWS_DEPLOY_GATE_SECRET } : {}),
    ...(numEnvStrict("AWS_DEPLOY_TOKEN_TTL_MIN", env.AWS_DEPLOY_TOKEN_TTL_MIN) !== undefined
      ? { tokenTtlMinutes: numEnvStrict("AWS_DEPLOY_TOKEN_TTL_MIN", env.AWS_DEPLOY_TOKEN_TTL_MIN) }
      : {}),
    ...(env.AWS_DEPLOY_DATA_BUCKET ? { dataBucket: env.AWS_DEPLOY_DATA_BUCKET } : {}),
    ...(env.AWS_DEPLOY_DATA_PREFIX ? { dataPrefix: env.AWS_DEPLOY_DATA_PREFIX } : {}),
    ...(env.AWS_DEPLOY_DATA_ROLE_ARN ? { dataRoleArn: env.AWS_DEPLOY_DATA_ROLE_ARN } : {}),
    ...(numEnvStrict("AWS_DEPLOY_SNAPSHOT_INTERVAL_MS", env.AWS_DEPLOY_SNAPSHOT_INTERVAL_MS) !== undefined
      ? {
          snapshotIntervalMs: Math.max(
            60_000,
            numEnvStrict("AWS_DEPLOY_SNAPSHOT_INTERVAL_MS", env.AWS_DEPLOY_SNAPSHOT_INTERVAL_MS)!,
          ),
        }
      : {}),
  };
}

const DEFAULT_ORG_ID = "default-org";

export function orgId(): string {
  return process.env.ORG_ID ?? DEFAULT_ORG_ID;
}

export function orgScope(): string {
  return `org:${orgId()}`;
}

export const OPENCODE_RUNTIME_VERSION = "1.17.18";

export const CONFIG_DEFAULTS = {
  port: 8080,
  rateLimitPerWindow: 60,
  rateLimitWindowMs: 60_000,
  budgetWindowMs: 86_400_000,
  execTimeoutDefaultSec: 120,
  execTimeoutMaxSec: 300,
  turnWallClockSec: 0,
  runMaxAgeMs: 24 * 60 * 60_000,
  backgroundJobTtlSec: 1800,
  backgroundJobTtlMaxSec: 3600,
  backgroundWorkEnabled: true,
  monitorPollMs: 10_000,
  skillSyncPollMs: 0,
  deployDialTimeoutMs: 20_000,
  deepIdleMachineMs: 3 * 24 * 60 * 60_000,
  devIdleMachineMs: 2 * 60 * 60_000,
  cronFireConcurrency: 4,
  monitorHeartbeatSec: 180,
  approvalSummaryTimeoutMs: 6_000,
  securityScreenTimeoutMs: 15_000,
  insightsIntervalMs: 5 * 60_000,
  workers: 16,
  leaseTtlMs: 120_000,
  heartbeatIntervalMs: 10_000,
  reaperIntervalMs: 15_000,
  shutdownDrainMs: 10_000,
  maxAttempts: 3,
  maxClaims: 8,
  processReaperIntervalMs: 30_000,
} as const;

export function boolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off", "none"].includes(v)) return false;
  return undefined;
}

export function numEnv(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function boolEnvStrict(name: string, value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = boolEnv(value);
  if (parsed === undefined) {
    throw new Error(
      `${name}=${JSON.stringify(value)} is not a recognized boolean — use 1/true/yes/on or 0/false/no/off/none (case-insensitive), or unset it.`,
    );
  }
  return parsed;
}

function numEnvStrict(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = numEnv(value);
  if (parsed === undefined) {
    throw new Error(`${name}=${JSON.stringify(value)} is not a number — set a finite numeric value, or unset it.`);
  }
  return parsed;
}

function orgBrandingFromEnv(env: NodeJS.ProcessEnv): Config["brandingDefault"] {
  const clean = (v: string | undefined): string =>
    (v ?? "").replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029<>]/g, "").trim();
  const accentRaw = clean(env.ORG_BRAND_ACCENT);
  const accent = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(accentRaw) ? accentRaw : undefined;
  const mark =
    clean(env.ORG_BRAND_MARK)
      .replace(/["\\{}]/g, "")
      .slice(0, 2) || undefined;
  const selfLabel = clean(env.ORG_BRAND_SELF_LABEL).slice(0, 40) || undefined;
  const branding = { ...(accent ? { accent } : {}), ...(mark ? { mark } : {}), ...(selfLabel ? { selfLabel } : {}) };
  return Object.keys(branding).length ? branding : undefined;
}

function harnessEnvStrict(value: string | undefined): Config["harness"] {
  if (value === undefined || value.trim() === "") return "mock";
  const harness = value.trim();
  if (harness === "mock" || harness === "pi" || harness === "opencode" || harness === "codex" || harness === "claude")
    return harness;
  throw new Error(
    `HARNESS=${JSON.stringify(value)} is not recognized — use mock, pi, opencode, codex, or claude, or unset it.`,
  );
}

function sandboxBackendEnvStrict(value: string | undefined, name = "SANDBOX_BACKEND"): Config["sandboxBackend"] {
  if (value === undefined || value.trim() === "") return "local";
  const backend = value.trim();
  if (backend === "aws" || backend === "local" || backend === "sprites") return backend;
  throw new Error(`${name}=${JSON.stringify(value)} is not recognized — use aws, local, or sprites, or unset it.`);
}

function secretsBackendEnvStrict(value: string | undefined, prefix: string): Config["secretsBackend"] {
  if (value === undefined || value.trim() === "") return "env";
  const backend = value.trim();
  if (backend === "env") return backend;
  if (backend === "aws") {
    if (!prefix)
      throw new Error(
        "SECRETS_BACKEND=aws requires a non-empty SECRETS_PREFIX (e.g. qm-prod-) so lookups can't collide across stacks sharing an account.",
      );
    return backend;
  }
  throw new Error(`SECRETS_BACKEND=${JSON.stringify(value)} is not recognized — use env or aws, or unset it.`);
}

function securityPostureEnvStrict(value: string | undefined): SecurityPosture {
  if (value === undefined || value.trim() === "") return "auto";
  const posture = parseSecurityPosture(value);
  if (posture) return posture;
  throw new Error(
    `HARNESS_SECURITY_POSTURE=${JSON.stringify(value)} is not recognized — use dangerous, auto, or strict, or unset it.`,
  );
}

function securityScreenBackendEnvStrict(value: string | undefined): Config["securityScreenBackend"] {
  if (value === undefined || value.trim() === "") return "model";
  const backend = value.trim().toLowerCase();
  if (backend === "model" || backend === "proxy") return backend;
  throw new Error(
    `SECURITY_SCREEN_BACKEND=${JSON.stringify(value)} is not recognized — use model or proxy, or unset it.`,
  );
}

function csvPaths(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  if (boolEnv(value) === false) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => resolve(p));
}

function defaultPluginSkillDirs(): string[] {
  const root = resolve("./plugins");
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, "skills"))
      .filter((dir) => existsSync(dir));
  } catch {
    return [];
  }
}

function modelProviderEnvStrict(env: NodeJS.ProcessEnv): ModelProvider | undefined {
  const declared = env.MODEL_PROVIDER?.trim();
  if (!declared) return undefined;
  if (!isModelProvider(declared)) {
    throw new Error(
      `MODEL_PROVIDER=${JSON.stringify(declared)} is not recognized — use ${MODEL_PROVIDERS.join(", ")}.`,
    );
  }
  const harness = harnessEnvStrict(env.HARNESS);
  const base = defaultModelForProvider(harness, declared);
  if (!base) {
    throw new Error(
      `MODEL_PROVIDER=${declared} cannot serve a base model on HARNESS=${harness} — that harness runs no ${declared} model, so every turn would be refused.`,
    );
  }
  return declared;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missingSecrets = validateCoreSecretEnv(env);
  if (missingSecrets.length) {
    throw new Error(`missing or insecure required core secrets: ${missingSecrets.join(", ")}`);
  }
  const modelProvider = modelProviderEnvStrict(env);
  for (const key of ["SESSION_STORE", "RUN_STORE", "ARTIFACT_STORE"] as const) {
    if (env[key] === "sqlite") {
      throw new Error(
        `${key}=sqlite is no longer supported — SQLite was removed. ` +
          `Set ${key === "ARTIFACT_STORE" ? "DATABASE_URL (Postgres)" : `${key}=postgres (with DATABASE_URL)`} for durability, ` +
          `or use the in-memory default (${key === "ARTIFACT_STORE" ? "unset ARTIFACT_STORE" : `${key}=memory`}) for an ephemeral store.`,
      );
    }
  }
  if (env.NODE_ENV === "production" && harnessEnvStrict(env.HARNESS) === "mock") {
    console.warn(
      `[config] HARNESS is ${env.HARNESS?.trim() ? '"mock"' : "unset, which means mock"} in production — this deployment answers every message with canned text and calls no model provider. Set HARNESS=pi to run real agent turns.`,
    );
  }
  if (env.SANDBOX_BACKEND === "sprites" && !env.SPRITES_EGRESS_PROXY_URL) {
    console.warn(
      "[config] SANDBOX_BACKEND=sprites without SPRITES_EGRESS_PROXY_URL — sandboxes run with NO egress enforcement (fail-open); set SPRITES_EGRESS_PROXY_URL to the public egress proxy to force sandbox traffic through it.",
    );
  }
  const dataDir = resolve(env.DATA_DIR ?? "./data");
  if (env.NODE_ENV === "production" && !env.SANDBOX_BACKEND?.trim()) {
    throw new Error("SANDBOX_BACKEND must be set explicitly in production — use sprites, aws, or local.");
  }
  const sandboxBackend = sandboxBackendEnvStrict(env.SANDBOX_BACKEND);
  const secondaryRaw = env.SANDBOX_SECONDARY_BACKEND?.trim();
  let sandboxSecondaryBackend: Config["sandboxSecondaryBackend"];
  if (secondaryRaw) {
    const secondary = sandboxBackendEnvStrict(secondaryRaw, "SANDBOX_SECONDARY_BACKEND");
    if (secondary === sandboxBackend) throw new Error("SANDBOX_SECONDARY_BACKEND must differ from SANDBOX_BACKEND.");
    sandboxSecondaryBackend = secondary;
  }
  const securityScreenBackend = securityScreenBackendEnvStrict(env.SECURITY_SCREEN_BACKEND);
  const proxyProvider = env.SECURITY_SCREEN_PROXY_PROVIDER?.trim();
  const proxyEndpoint = env.SECURITY_SCREEN_PROXY_ENDPOINT?.trim();
  const proxyToken = env.SECURITY_SCREEN_PROXY_TOKEN?.trim();
  const proxyRollout = env.SECURITY_SCREEN_PROXY_ROLLOUT?.trim().toLowerCase();
  const hasProxyConfig = [proxyProvider, proxyEndpoint, proxyToken, proxyRollout].some(Boolean);
  if (securityScreenBackend === "proxy" && (!proxyProvider || !proxyEndpoint || !proxyToken || !proxyRollout)) {
    throw new Error(
      "SECURITY_SCREEN_BACKEND=proxy requires SECURITY_SCREEN_PROXY_PROVIDER, SECURITY_SCREEN_PROXY_ENDPOINT, SECURITY_SCREEN_PROXY_TOKEN, and SECURITY_SCREEN_PROXY_ROLLOUT",
    );
  }
  if (securityScreenBackend === "model" && hasProxyConfig) {
    throw new Error("SECURITY_SCREEN_PROXY_* requires SECURITY_SCREEN_BACKEND=proxy");
  }
  if (proxyProvider && (proxyProvider.length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(proxyProvider))) {
    throw new Error("SECURITY_SCREEN_PROXY_PROVIDER must be a lowercase DNS label");
  }
  if (proxyProvider === "surface" || proxyProvider === "origin") {
    throw new Error("SECURITY_SCREEN_PROXY_PROVIDER must not collide with a security screen metadata field");
  }
  if (proxyEndpoint) {
    try {
      const url = new URL(proxyEndpoint);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.hostname.endsWith("."))
        throw new Error("endpoint");
    } catch {
      throw new Error(
        "SECURITY_SCREEN_PROXY_ENDPOINT must be an HTTPS URL without credentials, a fragment, or a trailing hostname dot",
      );
    }
  }
  if (proxyRollout && proxyRollout !== "shadow" && proxyRollout !== "enforce") {
    throw new Error("SECURITY_SCREEN_PROXY_ROLLOUT must be shadow or enforce");
  }
  const securityScreenTimeoutMs =
    numEnvStrict("SECURITY_SCREEN_TIMEOUT_MS", env.SECURITY_SCREEN_TIMEOUT_MS) ??
    CONFIG_DEFAULTS.securityScreenTimeoutMs;
  if (
    !Number.isSafeInteger(securityScreenTimeoutMs) ||
    securityScreenTimeoutMs <= 0 ||
    securityScreenTimeoutMs > 2_147_483_647
  ) {
    throw new Error("SECURITY_SCREEN_TIMEOUT_MS must be a positive integer no greater than 2147483647");
  }
  const publicApiUrl = env.PUBLIC_API_URL ?? env.AGENT_API_URL;
  const publicUrl = env.PUBLIC_WEB_URL ?? publicApiUrl;
  const deployProvider: "aws" | "docker" = env.DEPLOY_PROVIDER === "aws" ? "aws" : "docker";
  let runStore: "memory" | "postgres" = env.SESSION_STORE === "postgres" ? "postgres" : "memory";
  if (env.RUN_STORE === "memory" || env.RUN_STORE === "postgres") runStore = env.RUN_STORE;
  const providerBaseUrls = providerBaseUrlsFromEnv(env);
  const codexProcessEnv = Object.fromEntries(
    [
      "PATH",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "NODE_EXTRA_CA_CERTS",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "ALL_PROXY",
      "OPENAI_API_KEY",
      "CODEX_ACCESS_TOKEN",
      "HOME",
      "CODEX_HOME",
    ].flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])),
  ) as NodeJS.ProcessEnv;
  const claudeProcessEnv = Object.fromEntries(
    [
      "PATH",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "NODE_EXTRA_CA_CERTS",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "ALL_PROXY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ].flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])),
  ) as NodeJS.ProcessEnv;
  if (providerBaseUrls.openai) codexProcessEnv.OPENAI_BASE_URL = providerBaseUrls.openai;
  if (providerBaseUrls.anthropic) claudeProcessEnv.ANTHROPIC_BASE_URL = providerBaseUrls.anthropic;
  const turnWallClockMs =
    (numEnvStrict("TURN_WALL_CLOCK_SEC", env.TURN_WALL_CLOCK_SEC) ?? CONFIG_DEFAULTS.turnWallClockSec) * 1000;
  const runMaxAgeMs =
    numEnvStrict("RUN_MAX_AGE_MS", env.RUN_MAX_AGE_MS) ??
    (turnWallClockMs > 0 ? 2 * turnWallClockMs : CONFIG_DEFAULTS.runMaxAgeMs);
  const slack = slackPluginConfigFromEnv(env);
  return {
    production: env.NODE_ENV === "production",
    allowUnauthenticatedCore: boolEnvStrict("ALLOW_UNAUTHENTICATED_CORE", env.ALLOW_UNAUTHENTICATED_CORE) ?? false,
    port: numEnvStrict("PORT", env.PORT) ?? CONFIG_DEFAULTS.port,
    dataDir,
    orgId: env.ORG_ID ?? DEFAULT_ORG_ID,
    sessionStore: env.SESSION_STORE === "postgres" ? "postgres" : "memory",
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
    harness: harnessEnvStrict(env.HARNESS),
    securityPosture: securityPostureEnvStrict(env.HARNESS_SECURITY_POSTURE),
    securityScreenBackend,
    ...(securityScreenBackend === "proxy"
      ? {
          securityScreenProxy: {
            provider: proxyProvider!,
            endpoint: proxyEndpoint!,
            token: proxyToken!,
            shadow: proxyRollout === "shadow",
          },
        }
      : {}),
    sandboxBackend,
    ...(sandboxSecondaryBackend ? { sandboxSecondaryBackend } : {}),
    deployProvider,
    ...(env.EGRESS_SERVICE_HOSTS
      ? {
          egressServiceHosts: env.EGRESS_SERVICE_HOSTS.split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : {}),
    ...(orgBrandingFromEnv(env) ? { brandingDefault: orgBrandingFromEnv(env) } : {}),
    ...(env.PI_MODEL ? { modelId: env.PI_MODEL } : {}),
    ...(env.OPENCODE_MODEL || env.PI_MODEL ? { opencodeModel: env.OPENCODE_MODEL || env.PI_MODEL } : {}),
    ...(env.CODEX_MODEL ? { codexModel: env.CODEX_MODEL } : {}),
    ...(env.CODEX_BIN ? { codexBinPath: env.CODEX_BIN } : {}),
    codexProcessEnv,
    ...(env.CLAUDE_MODEL ? { claudeModel: env.CLAUDE_MODEL } : {}),
    ...(env.CLAUDE_BIN ? { claudeBinPath: env.CLAUDE_BIN } : {}),
    claudeProcessEnv,
    ...(env.PI_DETECT_MODEL ? { detectModelId: env.PI_DETECT_MODEL } : {}),
    ...(env.PI_TITLE_MODEL ? { titleModelId: env.PI_TITLE_MODEL } : {}),
    ...(env.PI_JUDGE_MODEL ? { judgeModelId: env.PI_JUDGE_MODEL } : {}),
    ...(env.ANTHROPIC_API_KEY ? { anthropicApiKey: env.ANTHROPIC_API_KEY } : {}),
    ...(env.OPENAI_API_KEY ? { openaiApiKey: env.OPENAI_API_KEY } : {}),
    ...(env.OPENROUTER_API_KEY ? { openrouterApiKey: env.OPENROUTER_API_KEY } : {}),
    ...(modelProvider ? { modelProvider } : {}),
    providerBaseUrls,
    ...(env.ADMIN_GRANTS ? { adminGrants: env.ADMIN_GRANTS } : {}),
    piCaptureRequests: boolEnvStrict("PI_CAPTURE_REQUESTS", env.PI_CAPTURE_REQUESTS) ?? true,
    piSystemCacheSplit: boolEnvStrict("PI_SYSTEM_CACHE_SPLIT", env.PI_SYSTEM_CACHE_SPLIT) ?? false,
    sessionTapeMode: env.SESSION_TAPE_MODE === "shadow" ? "shadow" : "serve",
    rateLimitPerWindow:
      numEnvStrict("RATE_LIMIT_PER_WINDOW", env.RATE_LIMIT_PER_WINDOW) ?? CONFIG_DEFAULTS.rateLimitPerWindow,
    rateLimitWindowMs:
      numEnvStrict("RATE_LIMIT_WINDOW_MS", env.RATE_LIMIT_WINDOW_MS) ?? CONFIG_DEFAULTS.rateLimitWindowMs,
    ...(numEnvStrict("BUDGET_USD_PER_WINDOW", env.BUDGET_USD_PER_WINDOW) !== undefined
      ? { budgetUsdPerWindow: numEnvStrict("BUDGET_USD_PER_WINDOW", env.BUDGET_USD_PER_WINDOW) }
      : {}),
    ...(numEnvStrict("ORG_BUDGET_USD_PER_WINDOW", env.ORG_BUDGET_USD_PER_WINDOW) !== undefined
      ? { orgBudgetUsdPerWindow: numEnvStrict("ORG_BUDGET_USD_PER_WINDOW", env.ORG_BUDGET_USD_PER_WINDOW) }
      : {}),
    budgetWindowMs: numEnvStrict("BUDGET_WINDOW_MS", env.BUDGET_WINDOW_MS) ?? CONFIG_DEFAULTS.budgetWindowMs,
    ...(numEnvStrict("MAX_CONTEXT_ENTRIES", env.MAX_CONTEXT_ENTRIES) !== undefined
      ? { maxContextEntries: numEnvStrict("MAX_CONTEXT_ENTRIES", env.MAX_CONTEXT_ENTRIES) }
      : {}),
    ...(numEnvStrict("MAX_CONTEXT_TOKENS", env.MAX_CONTEXT_TOKENS) !== undefined
      ? { maxContextTokens: numEnvStrict("MAX_CONTEXT_TOKENS", env.MAX_CONTEXT_TOKENS) }
      : {}),
    execTimeoutDefaultMs:
      (numEnvStrict("EXEC_TIMEOUT_DEFAULT_SEC", env.EXEC_TIMEOUT_DEFAULT_SEC) ??
        CONFIG_DEFAULTS.execTimeoutDefaultSec) * 1000,
    execTimeoutMaxMs:
      (numEnvStrict("EXEC_TIMEOUT_MAX_SEC", env.EXEC_TIMEOUT_MAX_SEC) ?? CONFIG_DEFAULTS.execTimeoutMaxSec) * 1000,
    turnWallClockMs,
    runMaxAgeMs,
    runWaitMs: (turnWallClockMs > 0 ? turnWallClockMs : runMaxAgeMs) + 60_000,
    backgroundJobTtlMs:
      (numEnvStrict("BACKGROUND_JOB_TTL_SEC", env.BACKGROUND_JOB_TTL_SEC) ?? CONFIG_DEFAULTS.backgroundJobTtlSec) *
      1000,
    backgroundJobTtlMaxMs:
      (numEnvStrict("BACKGROUND_JOB_TTL_MAX_SEC", env.BACKGROUND_JOB_TTL_MAX_SEC) ??
        CONFIG_DEFAULTS.backgroundJobTtlMaxSec) * 1000,
    backgroundWorkEnabled:
      boolEnvStrict("BACKGROUND_WORK_ENABLED", env.BACKGROUND_WORK_ENABLED) ?? CONFIG_DEFAULTS.backgroundWorkEnabled,
    ...(env.GIT_SHA ? { buildSha: env.GIT_SHA } : {}),
    ecsTaskProtection: boolEnvStrict("ECS_TASK_PROTECTION", env.ECS_TASK_PROTECTION) ?? true,
    ...(env.ECS_AGENT_URI ? { ecsAgentUri: env.ECS_AGENT_URI } : {}),
    monitorPollMs: numEnvStrict("MONITOR_POLL_MS", env.MONITOR_POLL_MS) ?? CONFIG_DEFAULTS.monitorPollMs,
    skillSyncPollMs: numEnvStrict("SKILL_SYNC_POLL_MS", env.SKILL_SYNC_POLL_MS) ?? CONFIG_DEFAULTS.skillSyncPollMs,
    monitorHeartbeatMs:
      (numEnvStrict("MONITOR_HEARTBEAT_SEC", env.MONITOR_HEARTBEAT_SEC) ?? CONFIG_DEFAULTS.monitorHeartbeatSec) * 1000,
    ...(env.CORE_SIGNING_SECRET ? { signingSecret: env.CORE_SIGNING_SECRET } : {}),
    ...((env.CAPABILITY_SECRET ?? env.CORE_SIGNING_SECRET)
      ? { capabilitySecret: env.CAPABILITY_SECRET ?? env.CORE_SIGNING_SECRET }
      : {}),
    ...((env.PORTAL_IDENTITY_SECRET ?? env.CORE_SIGNING_SECRET)
      ? { portalIdentitySecret: env.PORTAL_IDENTITY_SECRET ?? env.CORE_SIGNING_SECRET }
      : {}),
    requireSignedPortalIdentity: env.REQUIRE_SIGNED_PORTAL_IDENTITY === "1",
    ...(env.CONNECTOR_SECRET_KEY ? { connectorSecretKey: env.CONNECTOR_SECRET_KEY } : {}),
    secretsBackend: secretsBackendEnvStrict(env.SECRETS_BACKEND, env.SECRETS_PREFIX ?? ""),
    secretsPrefix: env.SECRETS_PREFIX ?? "",
    ...(publicApiUrl ? { apiBaseUrl: publicApiUrl } : {}),
    ...(publicUrl ? { publicUrl } : {}),
    ...(env.PUBLIC_WEB_URL ? { publicWebUrl: env.PUBLIC_WEB_URL } : {}),
    ...(env.FLY_APP_NAME ? { flyAppName: env.FLY_APP_NAME } : {}),
    ...(slack ? { slack } : {}),
    runStore,
    ...(env.SKILL_SIGNING_SECRET ? { skillSigningSecret: env.SKILL_SIGNING_SECRET } : {}),
    seedSkills: boolEnvStrict("SEED_SKILLS", env.SEED_SKILLS) ?? true,
    skillsSeedDir: resolve(env.SKILLS_SEED_DIR ?? "./skills-seed"),
    pluginSkillDirs: csvPaths(env.PLUGIN_SKILLS_DIRS) ?? defaultPluginSkillDirs(),
    ...(env.DEPLOYMENT_LAYER ? { deploymentLayerDir: resolve(env.DEPLOYMENT_LAYER) } : {}),
    layerEnv: { ...env },
    memoryRecall: parseMemoryRecallMode(env.MEMORY_RECALL),
    memoryCapture: parseMemoryCaptureMode(env.MEMORY_CAPTURE),
    memoryStrategy: parseMemoryStrategyKind(env.MEMORY_STRATEGY),
    ...(numEnvStrict("MEMORY_CONSOLIDATE_AFTER", env.MEMORY_CONSOLIDATE_AFTER) !== undefined
      ? { memoryConsolidateAfter: numEnvStrict("MEMORY_CONSOLIDATE_AFTER", env.MEMORY_CONSOLIDATE_AFTER) }
      : {}),
    memoryCaptureQuietMs:
      numEnvStrict("MEMORY_CAPTURE_QUIET_MS", env.MEMORY_CAPTURE_QUIET_MS) ?? DEFAULT_CAPTURE_QUIET_MS,
    ...(numEnvStrict("MEMORY_CAPTURE_MAX_TURNS", env.MEMORY_CAPTURE_MAX_TURNS) !== undefined
      ? { memoryCaptureMaxTurns: numEnvStrict("MEMORY_CAPTURE_MAX_TURNS", env.MEMORY_CAPTURE_MAX_TURNS) }
      : {}),
    snapshotStore: env.SNAPSHOT_STORE === "s3" ? "s3" : "local",
    transferStore: env.TRANSFER_STORE === "s3" ? "s3" : "local",
    ...(env.S3_BUCKET ? { s3Bucket: env.S3_BUCKET } : {}),
    ...(env.S3_REGION ? { s3Region: env.S3_REGION } : {}),
    ...(env.S3_PREFIX ? { s3Prefix: env.S3_PREFIX } : {}),
    ...(numEnvStrict("DEPLOY_IDLE_TTL_MS", env.DEPLOY_IDLE_TTL_MS) !== undefined
      ? { deployIdleTtlMs: numEnvStrict("DEPLOY_IDLE_TTL_MS", env.DEPLOY_IDLE_TTL_MS) }
      : {}),
    deployGitDir: env.DEPLOY_GIT_DIR ? resolve(env.DEPLOY_GIT_DIR) : join(dataDir, "deploy-git"),
    deployDialTimeoutMs:
      numEnvStrict("DEPLOY_DIAL_TIMEOUT_MS", env.DEPLOY_DIAL_TIMEOUT_MS) ?? CONFIG_DEFAULTS.deployDialTimeoutMs,
    ...deployAppsEnv(env),
    deepIdleMachineMs:
      numEnvStrict("DEEP_IDLE_MACHINE_MS", env.DEEP_IDLE_MACHINE_MS) ?? CONFIG_DEFAULTS.deepIdleMachineMs,
    devIdleMachineMs: numEnvStrict("DEV_IDLE_MACHINE_MS", env.DEV_IDLE_MACHINE_MS) ?? CONFIG_DEFAULTS.devIdleMachineMs,
    cronFireConcurrency:
      numEnvStrict("CRON_FIRE_CONCURRENCY", env.CRON_FIRE_CONCURRENCY) ?? CONFIG_DEFAULTS.cronFireConcurrency,
    workers: numEnvStrict("WORKERS", env.WORKERS) ?? CONFIG_DEFAULTS.workers,
    leaseTtlMs: numEnvStrict("LEASE_TTL_MS", env.LEASE_TTL_MS) ?? CONFIG_DEFAULTS.leaseTtlMs,
    heartbeatIntervalMs:
      numEnvStrict("HEARTBEAT_INTERVAL_MS", env.HEARTBEAT_INTERVAL_MS) ??
      Math.max(1_000, Math.floor((numEnvStrict("LEASE_TTL_MS", env.LEASE_TTL_MS) ?? CONFIG_DEFAULTS.leaseTtlMs) / 3)),
    reaperIntervalMs: numEnvStrict("REAPER_INTERVAL_MS", env.REAPER_INTERVAL_MS) ?? CONFIG_DEFAULTS.reaperIntervalMs,
    shutdownDrainMs: numEnvStrict("SHUTDOWN_DRAIN_MS", env.SHUTDOWN_DRAIN_MS) ?? CONFIG_DEFAULTS.shutdownDrainMs,
    maxAttempts: numEnvStrict("MAX_ATTEMPTS", env.MAX_ATTEMPTS) ?? CONFIG_DEFAULTS.maxAttempts,
    maxClaims: numEnvStrict("MAX_CLAIMS", env.MAX_CLAIMS) ?? CONFIG_DEFAULTS.maxClaims,
    processReaperIntervalMs:
      numEnvStrict("PROCESS_REAPER_INTERVAL_MS", env.PROCESS_REAPER_INTERVAL_MS) ??
      CONFIG_DEFAULTS.processReaperIntervalMs,
    approvalSummaryTimeoutMs:
      numEnvStrict("APPROVAL_SUMMARY_TIMEOUT_MS", env.APPROVAL_SUMMARY_TIMEOUT_MS) ??
      CONFIG_DEFAULTS.approvalSummaryTimeoutMs,
    securityScreenTimeoutMs,
    insightsIntervalMs:
      numEnvStrict("INSIGHTS_INTERVAL_MS", env.INSIGHTS_INTERVAL_MS) ?? CONFIG_DEFAULTS.insightsIntervalMs,
    ...(env.REACH_DENIED_NOTIFY_CHANNEL ? { reachDeniedNotifyChannel: env.REACH_DENIED_NOTIFY_CHANNEL.trim() } : {}),
    scratchExecEnabled: boolEnvStrict("EXECUTE_SCRATCH", env.EXECUTE_SCRATCH) ?? false,
    reachExecEnabled: boolEnvStrict("REACH_EXEC", env.REACH_EXEC) ?? false,
    sharedOwnerAuthIsolation: boolEnvStrict("SHARED_OWNER_AUTH_ISOLATION", env.SHARED_OWNER_AUTH_ISOLATION) ?? false,
    surfaceDebugFooter: boolEnvStrict("SURFACE_DEBUG_FOOTER", env.SURFACE_DEBUG_FOOTER) ?? false,
    eagerProvisionEnabled: boolEnvStrict("EAGER_PROVISION", env.EAGER_PROVISION) ?? false,
    awsSandbox: awsSandboxEnv(env),
    localSandbox: localSandboxEnv(env),
    spritesSandbox: spritesSandboxEnv(env),
    awsDeploy: awsDeployEnv(env),
  };
}
