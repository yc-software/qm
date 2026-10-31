import { boolEnv, boolEnvStrict, numEnvStrict, optNum } from "./util/env.ts";
import { sandboxSettings, type SandboxSettings } from "./sandbox/sandbox-settings.ts";
import { deploySettings, type DeploySettings } from "./deploy/deploy-settings.ts";
import type { ExternalSlackPolicies } from "./resolution/external-slack.ts";
import { isBearerSecret, isStrongSigningSecret } from "./auth/source-auth.ts";
import { parseSandboxCapabilityTtlMs } from "./auth/capability-token.ts";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  parseMemoryCaptureMode,
  parseMemoryRecallMode,
  type MemoryCaptureMode,
  type MemoryRecallMode,
} from "./memory/policy.ts";
import { parseMemoryStrategyKind, type MemoryStrategyKind } from "./memory/strategy.ts";
import { parseMemoryProviderConfig, type MemoryProviderConfig } from "./memory/provider-config.ts";
import { CORE_SECRET_SPECS, validateCoreSecretEnv } from "./deployment/secret-schema.ts";
import { DEFAULT_CAPTURE_QUIET_MS } from "./memory/strategies/per-turn.ts";
import { layerBrokerEnv, loadDeploymentLayer } from "./deployment/load-layer.ts";
import { slackPluginConfigFromEnv, slackAccountConfigsFromEnv, type SlackPluginConfig } from "./slack/config.ts";
import { resolveSwarmSettings, type SwarmSettings } from "./swarms/swarm-settings.ts";

export interface Config extends SandboxSettings, DeploySettings {
  productAnalytics?: { apiKey: string; host?: string };
  suggestedActivitiesEnabled?: boolean;
  swarmsEnabled?: boolean;
  swarmDefaults?: SwarmSettings;
  production: boolean;
  port: number;
  dataDir: string;
  databaseUrl?: string;
  databaseCaCert?: string;
  databaseCaCertFile?: string;
  databasePoolUrl?: string;
  databaseOwnerUrl?: string;
  databasePoolCaCert?: string;
  databasePoolMax?: number;
  databaseDirectPoolMax?: number;
  captureLlmRequests: boolean;
  resendApiKey?: string;
  emailFrom?: string;
  rateLimitPerWindow: number;
  rateLimitWindowMs: number;
  budgetUsdPerWindow?: number;
  orgBudgetUsdPerWindow?: number;
  budgetWindowMs: number;
  maxContextTokens?: number;
  execTimeoutDefaultMs: number;
  execTimeoutMaxMs: number;
  turnWallClockMs: number;
  runMaxAgeMs: number;
  runWaitMs: number;
  backgroundJobTtlMs: number;
  sandboxCapabilityTtlMs: number;
  backgroundJobTtlMaxMs: number;
  backgroundWorkEnabled: boolean;
  backgroundDeploymentId?: string;
  deploymentControlSecret?: string;
  spendExportToken?: string;
  buildSha?: string;
  monitorPollMs: number;
  skillSyncPollMs: number;
  monitorHeartbeatMs: number;
  signingSecret?: string;
  capabilitySecret?: string;
  capabilityTokenCompression?: boolean;
  portalIdentitySecret?: string;
  connectorSecretKey?: string;
  slackEventsPort?: number;
  apiBaseUrl?: string;
  publicUrl?: string;
  gmailPubSub?: { topic: string; audience: string; serviceAccount: string };
  publicWebUrl?: string;
  flyAppName?: string;
  slack?: SlackPluginConfig;
  externalSlackPolicies?: ExternalSlackPolicies;
  skillSigningSecret?: string;
  seedSkills: boolean;
  skillsSeedDir: string;
  pluginSkillDirs: string[];
  deploymentLayerDir?: string;
  layerBrokerEnv?: Readonly<Record<string, string>>;
  snapshotStore: "local" | "s3";
  transferStore: "local" | "s3";
  workspaceStore: "local" | "postgres";
  s3Bucket?: string;
  s3Region?: string;
  s3Endpoint?: string;
  s3Prefix?: string;
  deployIdleTtlMs?: number;
  deployGitDir: string;
  deployDialTimeoutMs: number;
  deepIdleMachineMs: number;
  devIdleMachineMs: number;
  cronFireConcurrency: number;
  memoryRecall: MemoryRecallMode;
  memoryCapture: MemoryCaptureMode;
  memoryStrategy: MemoryStrategyKind;
  memoryProviderConfig?: MemoryProviderConfig;
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
  turnLeaseWaitMs: number;
  securityScreenTimeoutMs: number;
  reachExecEnabled: boolean;
  surfaceDebugFooter: boolean;
}

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
  turnLeaseWaitMs: 5_000,
  securityScreenTimeoutMs: 15_000,
  workers: 16,
  leaseTtlMs: 120_000,
  heartbeatIntervalMs: 10_000,
  reaperIntervalMs: 15_000,
  shutdownDrainMs: 30_000,
  maxAttempts: 3,
  maxClaims: 8,
  processReaperIntervalMs: 30_000,
} as const;

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const s3Endpoint = env.AWS_ENDPOINT_URL_S3?.trim();
  if (s3Endpoint) {
    let endpoint: URL;
    try {
      endpoint = new URL(s3Endpoint);
    } catch {
      throw new Error("AWS_ENDPOINT_URL_S3 must be an HTTP or HTTPS URL");
    }
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error(
        "AWS_ENDPOINT_URL_S3 must be an HTTP or HTTPS URL without credentials, query parameters, or a fragment",
      );
  }
  const token = env.SPEND_EXPORT_TOKEN;
  if (token) {
    const reused = Object.entries(env).some(([name, value]) => name !== "SPEND_EXPORT_TOKEN" && value === token);
    if (!isStrongSigningSecret(token) || !isBearerSecret(token) || reused)
      throw new Error(
        "SPEND_EXPORT_TOKEN must be at least 32 characters, have no surrounding whitespace and differ from every other environment value",
      );
  }
  if (env.BACKGROUND_DEPLOYMENT_ID !== undefined) {
    if (!env.BACKGROUND_DEPLOYMENT_ID.trim() || env.BACKGROUND_DEPLOYMENT_ID.length > 256)
      throw new Error("BACKGROUND_DEPLOYMENT_ID must be nonempty and at most 256 characters");
    if (!env.DATABASE_URL) throw new Error("Background ownership requires DATABASE_URL");
    if (
      !isStrongSigningSecret(env.CORE_SIGNING_SECRET) ||
      !isStrongSigningSecret(env.DEPLOYMENT_CONTROL_SECRET) ||
      env.DEPLOYMENT_CONTROL_SECRET === env.CORE_SIGNING_SECRET
    )
      throw new Error(
        "Background ownership requires a distinct DEPLOYMENT_CONTROL_SECRET of at least 32 characters and CORE_SIGNING_SECRET",
      );
  }
  const swarmDefaults = resolveSwarmSettings(
    env.SWARM_DEFAULTS === undefined ? undefined : JSON.parse(env.SWARM_DEFAULTS),
  );
  const publicApiUrl = env.PUBLIC_API_URL ?? env.AGENT_API_URL;
  const publicUrl = env.PUBLIC_WEB_URL || publicApiUrl;
  const deploy = deploySettings(env, publicUrl);
  const missingSecrets = validateCoreSecretEnv(env);
  if (missingSecrets.length) {
    const described = missingSecrets.map((name) => {
      const reason = CORE_SECRET_SPECS.find((spec) => spec.name === name)?.reason;
      return reason ? `${name} (${reason})` : name;
    });
    throw new Error(`missing or insecure required core secrets: ${described.join(", ")}`);
  }
  const sandbox = sandboxSettings(env);
  const dataDir = resolve(env.DATA_DIR ?? "./data");

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
  const turnWallClockMs =
    (numEnvStrict("TURN_WALL_CLOCK_SEC", env.TURN_WALL_CLOCK_SEC) ?? CONFIG_DEFAULTS.turnWallClockSec) * 1000;
  const runMaxAgeMs =
    numEnvStrict("RUN_MAX_AGE_MS", env.RUN_MAX_AGE_MS) ??
    (turnWallClockMs > 0 ? 2 * turnWallClockMs : CONFIG_DEFAULTS.runMaxAgeMs);
  const slack = slackPluginConfigFromEnv(env);
  const externalSlackPolicies = Object.fromEntries(
    [...(slack ? [slack] : []), ...slackAccountConfigsFromEnv(env)]
      .filter((account) => account.externalAccess)
      .map((account) => [account.accountId ?? "default", account.externalAccess!]),
  );
  const slackEventsPort =
    env.SLACK_EVENTS_MODE?.trim() === "http" ? numEnvStrict("SLACK_EVENTS_PORT", env.SLACK_EVENTS_PORT) : undefined;
  if (
    slackEventsPort !== undefined &&
    (!Number.isSafeInteger(slackEventsPort) || slackEventsPort <= 0 || slackEventsPort > 65_535)
  ) {
    throw new Error("SLACK_EVENTS_PORT must be an integer from 1 through 65535");
  }
  const memoryProviderConfig = parseMemoryProviderConfig(env.MEMORY_PROVIDER_CONFIG, env);
  return {
    suggestedActivitiesEnabled: boolEnvStrict("SUGGESTED_ACTIVITIES_ENABLED", env.SUGGESTED_ACTIVITIES_ENABLED) ?? true,
    production: env.NODE_ENV === "production",
    port: numEnvStrict("PORT", env.PORT) ?? CONFIG_DEFAULTS.port,
    dataDir,
    ...(env.POSTHOG_API_KEY?.trim()
      ? { productAnalytics: { apiKey: env.POSTHOG_API_KEY.trim(), host: env.POSTHOG_HOST?.trim() } }
      : {}),
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
    ...(env.DATABASE_POOL_URL ? { databasePoolUrl: env.DATABASE_POOL_URL } : {}),
    ...(env.DATABASE_OWNER_URL ? { databaseOwnerUrl: env.DATABASE_OWNER_URL } : {}),
    ...(env.DATABASE_POOL_CA_CERT ? { databasePoolCaCert: env.DATABASE_POOL_CA_CERT } : {}),
    ...(env.DATABASE_POOL_MAX ? { databasePoolMax: numEnvStrict("DATABASE_POOL_MAX", env.DATABASE_POOL_MAX) } : {}),
    ...(env.DATABASE_DIRECT_POOL_MAX
      ? { databaseDirectPoolMax: numEnvStrict("DATABASE_DIRECT_POOL_MAX", env.DATABASE_DIRECT_POOL_MAX) }
      : {}),
    ...(env.DATABASE_CA_CERT ? { databaseCaCert: env.DATABASE_CA_CERT } : {}),
    ...(env.DATABASE_CA_CERT_FILE ? { databaseCaCertFile: env.DATABASE_CA_CERT_FILE } : {}),
    ...(env.RESEND_API_KEY?.trim() ? { resendApiKey: env.RESEND_API_KEY.trim() } : {}),
    ...(env.AUTH_EMAIL_FROM?.trim() ? { emailFrom: env.AUTH_EMAIL_FROM.trim() } : {}),
    captureLlmRequests: boolEnvStrict("PI_CAPTURE_REQUESTS", env.PI_CAPTURE_REQUESTS) ?? true,
    rateLimitPerWindow:
      numEnvStrict("RATE_LIMIT_PER_WINDOW", env.RATE_LIMIT_PER_WINDOW) ?? CONFIG_DEFAULTS.rateLimitPerWindow,
    rateLimitWindowMs:
      numEnvStrict("RATE_LIMIT_WINDOW_MS", env.RATE_LIMIT_WINDOW_MS) ?? CONFIG_DEFAULTS.rateLimitWindowMs,
    ...optNum(env, "BUDGET_USD_PER_WINDOW", "budgetUsdPerWindow"),
    ...optNum(env, "ORG_BUDGET_USD_PER_WINDOW", "orgBudgetUsdPerWindow"),
    budgetWindowMs: numEnvStrict("BUDGET_WINDOW_MS", env.BUDGET_WINDOW_MS) ?? CONFIG_DEFAULTS.budgetWindowMs,
    ...optNum(env, "MAX_CONTEXT_TOKENS", "maxContextTokens"),
    execTimeoutDefaultMs:
      (numEnvStrict("EXEC_TIMEOUT_DEFAULT_SEC", env.EXEC_TIMEOUT_DEFAULT_SEC) ??
        CONFIG_DEFAULTS.execTimeoutDefaultSec) * 1000,
    execTimeoutMaxMs:
      (numEnvStrict("EXEC_TIMEOUT_MAX_SEC", env.EXEC_TIMEOUT_MAX_SEC) ?? CONFIG_DEFAULTS.execTimeoutMaxSec) * 1000,
    turnWallClockMs,
    swarmsEnabled: boolEnvStrict("SWARMS_ENABLED", env.SWARMS_ENABLED) ?? true,
    swarmDefaults,
    runMaxAgeMs,
    runWaitMs: (turnWallClockMs > 0 ? turnWallClockMs : runMaxAgeMs) + 60_000,
    sandboxCapabilityTtlMs: parseSandboxCapabilityTtlMs(env.SANDBOX_CAPABILITY_TTL_HOURS),
    backgroundJobTtlMs:
      (numEnvStrict("BACKGROUND_JOB_TTL_SEC", env.BACKGROUND_JOB_TTL_SEC) ?? CONFIG_DEFAULTS.backgroundJobTtlSec) *
      1000,
    backgroundJobTtlMaxMs:
      (numEnvStrict("BACKGROUND_JOB_TTL_MAX_SEC", env.BACKGROUND_JOB_TTL_MAX_SEC) ??
        CONFIG_DEFAULTS.backgroundJobTtlMaxSec) * 1000,
    backgroundWorkEnabled:
      boolEnvStrict("BACKGROUND_WORK_ENABLED", env.BACKGROUND_WORK_ENABLED) ?? CONFIG_DEFAULTS.backgroundWorkEnabled,
    ...(env.BACKGROUND_DEPLOYMENT_ID
      ? { backgroundDeploymentId: env.BACKGROUND_DEPLOYMENT_ID, deploymentControlSecret: env.DEPLOYMENT_CONTROL_SECRET }
      : {}),
    ...(env.SPEND_EXPORT_TOKEN ? { spendExportToken: env.SPEND_EXPORT_TOKEN } : {}),
    ...(env.GIT_SHA ? { buildSha: env.GIT_SHA } : {}),
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
    capabilityTokenCompression:
      boolEnvStrict("CAPABILITY_TOKEN_COMPRESSION", env.CAPABILITY_TOKEN_COMPRESSION) ?? false,
    ...(env.CONNECTOR_SECRET_KEY ? { connectorSecretKey: env.CONNECTOR_SECRET_KEY } : {}),
    ...(slackEventsPort !== undefined ? { slackEventsPort } : {}),
    ...(publicApiUrl ? { apiBaseUrl: publicApiUrl } : {}),
    ...(publicUrl ? { publicUrl } : {}),
    ...(env.GMAIL_PUBSUB_TOPIC && env.GMAIL_PUBSUB_AUDIENCE && env.GMAIL_PUBSUB_SERVICE_ACCOUNT
      ? {
          gmailPubSub: {
            topic: env.GMAIL_PUBSUB_TOPIC,
            audience: env.GMAIL_PUBSUB_AUDIENCE,
            serviceAccount: env.GMAIL_PUBSUB_SERVICE_ACCOUNT,
          },
        }
      : {}),
    ...(env.PUBLIC_WEB_URL ? { publicWebUrl: env.PUBLIC_WEB_URL } : {}),
    ...(env.FLY_APP_NAME ? { flyAppName: env.FLY_APP_NAME } : {}),
    ...(slack ? { slack } : {}),
    externalSlackPolicies,
    ...(env.SKILL_SIGNING_SECRET ? { skillSigningSecret: env.SKILL_SIGNING_SECRET } : {}),
    seedSkills: boolEnvStrict("SEED_SKILLS", env.SEED_SKILLS) ?? true,
    skillsSeedDir: resolve(env.SKILLS_SEED_DIR ?? "./skills-seed"),
    pluginSkillDirs: csvPaths(env.PLUGIN_SKILLS_DIRS) ?? defaultPluginSkillDirs(),
    ...(env.DEPLOYMENT_LAYER
      ? {
          deploymentLayerDir: resolve(env.DEPLOYMENT_LAYER),
          layerBrokerEnv: layerBrokerEnv(loadDeploymentLayer(resolve(env.DEPLOYMENT_LAYER)).brokeredTools, env),
        }
      : {}),
    memoryRecall: parseMemoryRecallMode(env.MEMORY_RECALL),
    memoryCapture: parseMemoryCaptureMode(env.MEMORY_CAPTURE),
    memoryStrategy: parseMemoryStrategyKind(env.MEMORY_STRATEGY),
    ...(memoryProviderConfig ? { memoryProviderConfig } : {}),
    memoryCaptureQuietMs:
      numEnvStrict("MEMORY_CAPTURE_QUIET_MS", env.MEMORY_CAPTURE_QUIET_MS) ?? DEFAULT_CAPTURE_QUIET_MS,
    ...optNum(env, "MEMORY_CAPTURE_MAX_TURNS", "memoryCaptureMaxTurns"),
    snapshotStore: env.SNAPSHOT_STORE === "s3" ? "s3" : "local",
    workspaceStore: env.WORKSPACE_STORE === "postgres" ? "postgres" : "local",
    transferStore: env.TRANSFER_STORE === "s3" ? "s3" : "local",
    ...(env.S3_BUCKET ? { s3Bucket: env.S3_BUCKET } : {}),
    ...(env.S3_REGION ? { s3Region: env.S3_REGION } : {}),
    ...(s3Endpoint ? { s3Endpoint } : {}),
    ...(env.S3_PREFIX ? { s3Prefix: env.S3_PREFIX } : {}),
    ...optNum(env, "DEPLOY_IDLE_TTL_MS", "deployIdleTtlMs"),
    deployGitDir: env.DEPLOY_GIT_DIR ? resolve(env.DEPLOY_GIT_DIR) : join(dataDir, "deploy-git"),
    deployDialTimeoutMs:
      numEnvStrict("DEPLOY_DIAL_TIMEOUT_MS", env.DEPLOY_DIAL_TIMEOUT_MS) ?? CONFIG_DEFAULTS.deployDialTimeoutMs,
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
    turnLeaseWaitMs: numEnvStrict("TURN_LEASE_WAIT_MS", env.TURN_LEASE_WAIT_MS) ?? CONFIG_DEFAULTS.turnLeaseWaitMs,
    securityScreenTimeoutMs,
    reachExecEnabled: boolEnvStrict("REACH_EXEC", env.REACH_EXEC) ?? false,
    surfaceDebugFooter: boolEnvStrict("SURFACE_DEBUG_FOOTER", env.SURFACE_DEBUG_FOOTER) ?? false,
    ...sandbox,
    ...deploy,
  };
}
