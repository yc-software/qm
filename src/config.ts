import { githubRepoUrl, isGitBranchName } from "../cli/src/render-source.ts";
import { parseSandboxBackend } from "./tenants/settings-parse.ts";
import { commitShaSchema } from "./util/ids.ts";
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

export interface Config {
  productAnalytics?: { apiKey: string; host?: string };
  suggestedActivitiesEnabled?: boolean;
  swarmsEnabled?: boolean;
  swarmDefaults?: SwarmSettings;
  production: boolean;
  port: number;
  dataDir: string;
  sessionStore: "memory" | "postgres";
  databaseUrl?: string;
  databaseOwnerUrl?: string;
  databaseReaderUrl?: string;
  databaseCaCert?: string;
  databaseCaCertFile?: string;
  databasePoolUrl?: string;
  databasePoolCaCert?: string;
  databasePoolMax?: number;
  databaseDirectPoolMax?: number;
  harness: "pi" | "claude";
  deployProvider: "docker" | "aws" | "fly" | "porter" | "e2b" | "render";
  claudeBinPath?: string;
  claudeProcessEnv: NodeJS.ProcessEnv;
  piCaptureRequests: boolean;
  adminGrants?: string;
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
  runStore: "memory" | "postgres";
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
  deployAppsSessionSecret?: string;
  deployAppsLoginUrl?: string;
  deployAppsLoginPath?: "/auth/login" | "/auth/trusted/login";
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
  localSandbox: LocalSandboxEnv;
  spritesSandbox: SpritesSandboxEnv;
  smolmachinesSandbox: SmolmachinesSandboxEnv;
  e2bSandbox: E2bSandboxEnv;
  managedAgentsSandbox: ManagedAgentsSandboxEnv;
  modalSandbox: ModalSandboxEnv;
  renderSandbox: RenderSandboxEnv;
  renderDeploy: RenderDeployEnv;
  porterDeploy: PorterDeployEnv;
  awsDeploy: AwsDeployEnv;
  deployAppsDomain?: string;
  flyDeploy: FlyDeployEnv;
}

interface LocalSandboxEnv {
  image?: string;
  dockerBin?: string;
  cpus?: number;
  memoryMb?: number;
  coreContainer?: string;
  defaultTimeoutSec?: number;
}

function localSandboxEnv(env: NodeJS.ProcessEnv): LocalSandboxEnv {
  return {
    ...(env.LOCAL_SANDBOX_IMAGE ? { image: env.LOCAL_SANDBOX_IMAGE } : {}),
    ...(env.LOCAL_SANDBOX_DOCKER_BIN ? { dockerBin: env.LOCAL_SANDBOX_DOCKER_BIN } : {}),
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
  baseUrl?: string;
  namePrefix?: string;
  egressProxyUrl?: string;
  egressProxyAdditionalUrls?: string[];
  snapshotS3Bucket?: string;
  memoryMb?: number;
  defaultTimeoutSec?: number;
}

function spritesSandboxEnv(env: NodeJS.ProcessEnv): SpritesSandboxEnv {
  return {
    ...(env.SPRITES_BASE_URL ? { baseUrl: env.SPRITES_BASE_URL } : {}),
    ...(env.SPRITES_NAME_PREFIX ? { namePrefix: env.SPRITES_NAME_PREFIX } : {}),
    ...(env.SPRITES_EGRESS_PROXY_URL ? { egressProxyUrl: env.SPRITES_EGRESS_PROXY_URL } : {}),
    ...(env.SPRITES_EGRESS_PROXY_ADDITIONAL_URLS?.trim()
      ? {
          egressProxyAdditionalUrls: env.SPRITES_EGRESS_PROXY_ADDITIONAL_URLS.split(",")
            .map((url) => url.trim())
            .filter(Boolean),
        }
      : {}),
    ...(env.SPRITES_SNAPSHOT_S3_BUCKET ? { snapshotS3Bucket: env.SPRITES_SNAPSHOT_S3_BUCKET } : {}),
    ...(numEnvStrict("SPRITES_MEMORY_MB", env.SPRITES_MEMORY_MB) !== undefined
      ? { memoryMb: numEnvStrict("SPRITES_MEMORY_MB", env.SPRITES_MEMORY_MB) }
      : {}),
    ...(numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC) !== undefined
      ? { defaultTimeoutSec: numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC) }
      : {}),
  };
}

interface E2bSandboxEnv {
  deployApiKey?: string;
  templateId?: string;
  namePrefix?: string;
  sandboxTtlSec?: number;

  proxy?: string;

  egressProxyUrl?: string;
  snapshotS3Bucket?: string;
  snapshotIntervalSec?: number;
  nativeSnapshotIntervalSec?: number;
  maxLifetimeSec?: number;
  defaultTimeoutSec?: number;
}

function e2bSandboxEnv(env: NodeJS.ProcessEnv): E2bSandboxEnv {
  return {
    ...(env.DEPLOY_PROVIDER === "e2b" && env.E2B_API_KEY ? { deployApiKey: env.E2B_API_KEY } : {}),
    ...(env.E2B_TEMPLATE_ID ? { templateId: env.E2B_TEMPLATE_ID } : {}),
    ...(env.E2B_NAME_PREFIX ? { namePrefix: env.E2B_NAME_PREFIX } : {}),
    ...(numEnvStrict("E2B_SANDBOX_TTL_SEC", env.E2B_SANDBOX_TTL_SEC) !== undefined
      ? { sandboxTtlSec: numEnvStrict("E2B_SANDBOX_TTL_SEC", env.E2B_SANDBOX_TTL_SEC) }
      : {}),
    ...(numEnvStrict("E2B_MAX_LIFETIME_SEC", env.E2B_MAX_LIFETIME_SEC) !== undefined
      ? { maxLifetimeSec: numEnvStrict("E2B_MAX_LIFETIME_SEC", env.E2B_MAX_LIFETIME_SEC) }
      : {}),
    ...(env.E2B_PROXY ? { proxy: env.E2B_PROXY } : {}),
    ...(env.E2B_EGRESS_PROXY_URL ? { egressProxyUrl: env.E2B_EGRESS_PROXY_URL } : {}),
    ...(env.E2B_SNAPSHOT_S3_BUCKET ? { snapshotS3Bucket: env.E2B_SNAPSHOT_S3_BUCKET } : {}),
    ...(numEnvStrict("E2B_SNAPSHOT_INTERVAL_SEC", env.E2B_SNAPSHOT_INTERVAL_SEC) !== undefined
      ? { snapshotIntervalSec: numEnvStrict("E2B_SNAPSHOT_INTERVAL_SEC", env.E2B_SNAPSHOT_INTERVAL_SEC) }
      : {}),
    ...(numEnvStrict("E2B_NATIVE_SNAPSHOT_INTERVAL_SEC", env.E2B_NATIVE_SNAPSHOT_INTERVAL_SEC) !== undefined
      ? {
          nativeSnapshotIntervalSec: numEnvStrict(
            "E2B_NATIVE_SNAPSHOT_INTERVAL_SEC",
            env.E2B_NATIVE_SNAPSHOT_INTERVAL_SEC,
          ),
        }
      : {}),
    ...(numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC) !== undefined
      ? { defaultTimeoutSec: numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC) }
      : {}),
  };
}

interface RenderSandboxEnv {
  defaultTimeoutSec?: number;
}

function renderSandboxEnv(env: NodeJS.ProcessEnv): RenderSandboxEnv {
  const defaultTimeoutSec = numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC);
  return defaultTimeoutSec !== undefined ? { defaultTimeoutSec } : {};
}

function renderRegion(env: NodeJS.ProcessEnv): string {
  return env.RENDER_REGION?.trim() || "oregon";
}

interface RenderDeployEnv {
  projectId: string;
  environmentId?: string;
  apiKey: string;
  workspaceId: string;
  minioServiceId: string;
  source?: { repo: string; branch: string; commit: string };
  region: string;
  appRegion: string;
}

function renderDeployEnv(env: NodeJS.ProcessEnv): RenderDeployEnv {
  const rawRepo = env.RENDER_DEPLOY_REPO?.trim();
  const repo = rawRepo ? githubRepoUrl(rawRepo) : undefined;
  const branch = env.RENDER_DEPLOY_BRANCH?.trim();
  const commit = env.GIT_SHA?.trim();
  const minioServiceId = env.RENDER_MINIO_SERVICE_ID?.trim() || "";
  if (Boolean(rawRepo) !== Boolean(branch))
    throw new Error("RENDER_DEPLOY_REPO and RENDER_DEPLOY_BRANCH must be set together");
  if (rawRepo && !repo)
    throw new Error("RENDER_DEPLOY_REPO must be an HTTPS GitHub repository URL without credentials");
  if (branch && !isGitBranchName(branch)) throw new Error("RENDER_DEPLOY_BRANCH must be a valid Git branch name");
  if (env.DEPLOY_PROVIDER === "render" && (!repo || !branch || !commitShaSchema.safeParse(commit).success))
    throw new Error("DEPLOY_PROVIDER=render requires RENDER_DEPLOY_REPO, RENDER_DEPLOY_BRANCH, and GIT_SHA");
  if (env.DEPLOY_PROVIDER === "render" && !/^srv-[a-z0-9]+$/.test(minioServiceId))
    throw new Error("DEPLOY_PROVIDER=render requires RENDER_MINIO_SERVICE_ID");
  const projectId = env.RENDER_PROJECT_ID?.trim() || "";
  if (env.DEPLOY_PROVIDER === "render" && !projectId)
    throw new Error("DEPLOY_PROVIDER=render requires RENDER_PROJECT_ID");
  if (projectId && !/^prj-[a-z0-9]+$/.test(projectId))
    throw new Error("RENDER_PROJECT_ID must be a project ID (prj-...)");
  const environmentId = env.RENDER_ENVIRONMENT_ID?.trim();
  if (env.DEPLOY_PROVIDER === "render" && !environmentId)
    throw new Error("DEPLOY_PROVIDER=render requires RENDER_ENVIRONMENT_ID");
  if (environmentId && !/^evm-[a-z0-9]+$/.test(environmentId))
    throw new Error("RENDER_ENVIRONMENT_ID must be an environment ID (evm-...)");
  const region = renderRegion(env);
  return {
    projectId,
    ...(environmentId ? { environmentId } : {}),
    apiKey: env.RENDER_API_KEY?.trim() || "",
    workspaceId: env.RENDER_WORKSPACE_ID?.trim() || "",
    minioServiceId,
    ...(repo && branch && commit ? { source: { repo, branch, commit } } : {}),
    region,
    appRegion: env.RENDER_APP_REGION?.trim() || region,
  };
}

interface ManagedAgentsSandboxEnv {
  apiBaseUrl?: string;
  template?: string;
  namePrefix?: string;
  sizeSlug?: string;
  idleTimeoutSec?: number;
  egressProxyUrl?: string;
  snapshotS3Bucket?: string;
  snapshotIntervalSec?: number;
  defaultTimeoutSec?: number;
}

function managedAgentsSandboxEnv(env: NodeJS.ProcessEnv): ManagedAgentsSandboxEnv {
  return {
    ...(env.DO_AGENTS_API_BASE_URL ? { apiBaseUrl: env.DO_AGENTS_API_BASE_URL } : {}),
    ...(env.DO_AGENTS_TEMPLATE ? { template: env.DO_AGENTS_TEMPLATE } : {}),
    ...(env.DO_AGENTS_NAME_PREFIX ? { namePrefix: env.DO_AGENTS_NAME_PREFIX } : {}),
    ...(env.DO_AGENTS_SIZE_SLUG ? { sizeSlug: env.DO_AGENTS_SIZE_SLUG } : {}),
    ...(numEnvStrict("DO_AGENTS_IDLE_TIMEOUT_SEC", env.DO_AGENTS_IDLE_TIMEOUT_SEC) !== undefined
      ? { idleTimeoutSec: numEnvStrict("DO_AGENTS_IDLE_TIMEOUT_SEC", env.DO_AGENTS_IDLE_TIMEOUT_SEC) }
      : {}),
    ...(env.DO_AGENTS_EGRESS_PROXY_URL ? { egressProxyUrl: env.DO_AGENTS_EGRESS_PROXY_URL } : {}),
    ...(env.DO_AGENTS_SNAPSHOT_S3_BUCKET ? { snapshotS3Bucket: env.DO_AGENTS_SNAPSHOT_S3_BUCKET } : {}),
    ...(numEnvStrict("DO_AGENTS_SNAPSHOT_INTERVAL_SEC", env.DO_AGENTS_SNAPSHOT_INTERVAL_SEC) !== undefined
      ? { snapshotIntervalSec: numEnvStrict("DO_AGENTS_SNAPSHOT_INTERVAL_SEC", env.DO_AGENTS_SNAPSHOT_INTERVAL_SEC) }
      : {}),
    ...(numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC) !== undefined
      ? { defaultTimeoutSec: numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC) }
      : {}),
  };
}

interface ModalSandboxEnv {
  nativeSnapshotIntervalSec?: number;
  snapshotRetentionSec?: number;
  appName?: string;
  environment?: string;
  image?: string;
  namePrefix?: string;
  cpus?: number;
  memoryMb?: number;
  regions?: string[];
  sandboxTimeoutSec?: number;
  rotateAfterSec?: number;
  reapIdleSec?: number;
  egressProxyUrl?: string;
  snapshotS3Bucket?: string;
  defaultTimeoutSec?: number;
}

function modalSandboxEnv(env: NodeJS.ProcessEnv): ModalSandboxEnv {
  const num = (name: string): number | undefined => numEnvStrict(name, env[name]);
  return {
    ...(num("MODAL_NATIVE_SNAPSHOT_INTERVAL_SEC") !== undefined
      ? { nativeSnapshotIntervalSec: num("MODAL_NATIVE_SNAPSHOT_INTERVAL_SEC") }
      : {}),
    ...(num("MODAL_SNAPSHOT_RETENTION_SEC") !== undefined
      ? { snapshotRetentionSec: num("MODAL_SNAPSHOT_RETENTION_SEC") }
      : {}),
    ...(env.MODAL_APP_NAME ? { appName: env.MODAL_APP_NAME } : {}),
    ...(env.MODAL_ENVIRONMENT ? { environment: env.MODAL_ENVIRONMENT } : {}),
    ...(env.MODAL_IMAGE ? { image: env.MODAL_IMAGE } : {}),
    ...(env.MODAL_NAME_PREFIX ? { namePrefix: env.MODAL_NAME_PREFIX } : {}),
    ...(num("MODAL_CPUS") !== undefined ? { cpus: num("MODAL_CPUS") } : {}),
    ...(num("MODAL_MEMORY_MB") !== undefined ? { memoryMb: num("MODAL_MEMORY_MB") } : {}),
    ...(env.MODAL_REGIONS?.trim()
      ? {
          regions: env.MODAL_REGIONS.split(",")
            .map((r) => r.trim())
            .filter(Boolean),
        }
      : {}),
    ...(num("MODAL_SANDBOX_TIMEOUT_SEC") !== undefined ? { sandboxTimeoutSec: num("MODAL_SANDBOX_TIMEOUT_SEC") } : {}),
    ...(num("MODAL_ROTATE_AFTER_SEC") !== undefined ? { rotateAfterSec: num("MODAL_ROTATE_AFTER_SEC") } : {}),
    ...(num("MODAL_REAP_IDLE_SEC") !== undefined ? { reapIdleSec: num("MODAL_REAP_IDLE_SEC") } : {}),
    ...(env.MODAL_EGRESS_PROXY_URL ? { egressProxyUrl: env.MODAL_EGRESS_PROXY_URL } : {}),
    ...(env.MODAL_SNAPSHOT_S3_BUCKET ? { snapshotS3Bucket: env.MODAL_SNAPSHOT_S3_BUCKET } : {}),
    ...(num("SANDBOX_TIMEOUT_SEC") !== undefined ? { defaultTimeoutSec: num("SANDBOX_TIMEOUT_SEC") } : {}),
  };
}

interface SmolmachinesSandboxEnv {
  baseUrl?: string;
  namePrefix?: string;
  image?: string;
  cpus?: number;
  memoryMb?: number;
  diskGb?: number;
  autoStopSec?: number;
  egressProxyUrl?: string;
  snapshotS3Bucket?: string;
  snapshotIntervalSec?: number;
  defaultTimeoutSec?: number;
}

function smolmachinesSandboxEnv(env: NodeJS.ProcessEnv): SmolmachinesSandboxEnv {
  return {
    ...(env.SMOLMACHINES_BASE_URL ? { baseUrl: env.SMOLMACHINES_BASE_URL } : {}),
    ...(env.SMOLMACHINES_NAME_PREFIX ? { namePrefix: env.SMOLMACHINES_NAME_PREFIX } : {}),
    ...(env.SMOLMACHINES_IMAGE ? { image: env.SMOLMACHINES_IMAGE } : {}),
    ...(numEnvStrict("SMOLMACHINES_CPUS", env.SMOLMACHINES_CPUS) !== undefined
      ? { cpus: numEnvStrict("SMOLMACHINES_CPUS", env.SMOLMACHINES_CPUS) }
      : {}),
    ...(numEnvStrict("SMOLMACHINES_MEMORY_MB", env.SMOLMACHINES_MEMORY_MB) !== undefined
      ? { memoryMb: numEnvStrict("SMOLMACHINES_MEMORY_MB", env.SMOLMACHINES_MEMORY_MB) }
      : {}),
    ...(numEnvStrict("SMOLMACHINES_DISK_GB", env.SMOLMACHINES_DISK_GB) !== undefined
      ? { diskGb: numEnvStrict("SMOLMACHINES_DISK_GB", env.SMOLMACHINES_DISK_GB) }
      : {}),
    ...(numEnvStrict("SMOLMACHINES_AUTOSTOP_SEC", env.SMOLMACHINES_AUTOSTOP_SEC) !== undefined
      ? { autoStopSec: numEnvStrict("SMOLMACHINES_AUTOSTOP_SEC", env.SMOLMACHINES_AUTOSTOP_SEC) }
      : {}),
    ...(env.SMOLMACHINES_EGRESS_PROXY_URL ? { egressProxyUrl: env.SMOLMACHINES_EGRESS_PROXY_URL } : {}),
    ...(env.SMOLMACHINES_SNAPSHOT_S3_BUCKET ? { snapshotS3Bucket: env.SMOLMACHINES_SNAPSHOT_S3_BUCKET } : {}),
    ...(numEnvStrict("SMOLMACHINES_SNAPSHOT_INTERVAL_SEC", env.SMOLMACHINES_SNAPSHOT_INTERVAL_SEC) !== undefined
      ? {
          snapshotIntervalSec: numEnvStrict(
            "SMOLMACHINES_SNAPSHOT_INTERVAL_SEC",
            env.SMOLMACHINES_SNAPSHOT_INTERVAL_SEC,
          ),
        }
      : {}),
    ...(numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC) !== undefined
      ? { defaultTimeoutSec: numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC) }
      : {}),
  };
}

interface PorterDeployEnv {
  token?: string;
  baseUrl?: string;
  runnerImage?: string;
  appsDomain?: string;
  visibility?: "public" | "private" | "internal";
  namePrefix?: string;
  ttlSec?: number;
}

function porterApiBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const deployProjectId = numEnvStrict("PORTER_DEPLOY_PROJECT_ID", env.PORTER_DEPLOY_PROJECT_ID);
  const deployClusterId = numEnvStrict("PORTER_DEPLOY_CLUSTER_ID", env.PORTER_DEPLOY_CLUSTER_ID);
  const derived =
    deployProjectId !== undefined && deployClusterId !== undefined
      ? `${(env.PORTER_DEPLOY_URL ?? "https://dashboard.porter.run").replace(/\/+$/, "")}/api/v2/alpha/projects/${deployProjectId}/clusters/${deployClusterId}`
      : undefined;
  return env.PORTER_SANDBOX_BASE_URL ?? derived;
}

const porterLocatorPresent = (env: NodeJS.ProcessEnv): boolean =>
  Boolean(porterApiBaseUrl(env) || env.PORTER_CLUSTER_ID || env.KUBERNETES_SERVICE_HOST);

function porterDeployVisibilityStrict(value: string | undefined): PorterDeployEnv["visibility"] {
  if (value === undefined || value.trim() === "") return undefined;
  const visibility = value.trim();
  if (visibility === "public" || visibility === "private" || visibility === "internal") return visibility;
  throw new Error(
    `PORTER_DEPLOY_VISIBILITY=${JSON.stringify(value)} is not recognized — use public, private, or internal, or unset it.`,
  );
}

function porterDeployEnv(env: NodeJS.ProcessEnv): PorterDeployEnv {
  const token = env.PORTER_DEPLOY_API_TOKEN;
  const baseUrl = porterApiBaseUrl(env);
  const visibility = porterDeployVisibilityStrict(env.PORTER_DEPLOY_VISIBILITY);
  if (visibility === "internal" && env.PORTER_DEPLOY_APPS_DOMAIN) {
    throw new Error(
      "PORTER_DEPLOY_VISIBILITY=internal serves apps inside the cluster only, so it takes no PORTER_DEPLOY_APPS_DOMAIN — unset one of them.",
    );
  }
  const ttlSec = numEnvStrict("PORTER_DEPLOY_TTL_SEC", env.PORTER_DEPLOY_TTL_SEC);
  const runnerImage = env.PORTER_DEPLOY_RUNNER_IMAGE ?? env.PORTER_SANDBOX_IMAGE;
  return {
    ...(token ? { token } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(runnerImage ? { runnerImage } : {}),
    ...(env.PORTER_DEPLOY_APPS_DOMAIN ? { appsDomain: env.PORTER_DEPLOY_APPS_DOMAIN } : {}),
    ...(visibility ? { visibility } : {}),
    ...(env.PORTER_SANDBOX_NAME_PREFIX ? { namePrefix: env.PORTER_SANDBOX_NAME_PREFIX } : {}),
    ...(ttlSec !== undefined ? { ttlSec } : {}),
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

function deployAppsEnv(
  env: NodeJS.ProcessEnv,
  defaultLoginUrl: string | undefined,
): {
  deployAppsSessionSecret?: string;
  deployAppsLoginUrl?: string;
  deployAppsLoginPath?: "/auth/login" | "/auth/trusted/login";
} {
  const explicit = env.DEPLOY_APPS_SESSION_SECRET;
  const shared = env.PORTAL_SESSION_SECRET;
  const loginUrl = env.DEPLOY_APPS_LOGIN_URL ?? (explicit || shared ? defaultLoginUrl : undefined);
  if (loginUrl && !explicit && !shared) {
    throw new Error("DEPLOY_APPS_LOGIN_URL requires DEPLOY_APPS_SESSION_SECRET");
  }
  if (explicit && !loginUrl) {
    throw new Error("DEPLOY_APPS_SESSION_SECRET needs a sign-in address — set DEPLOY_APPS_LOGIN_URL or PUBLIC_WEB_URL");
  }
  const secret = explicit ?? (loginUrl ? shared : undefined);
  const loginPath = env.DEPLOY_APPS_LOGIN_PATH ?? "/auth/login";
  if (loginPath !== "/auth/login" && loginPath !== "/auth/trusted/login") {
    throw new Error("DEPLOY_APPS_LOGIN_PATH must be /auth/login or /auth/trusted/login");
  }
  if (!secret || !loginUrl) return {};
  return {
    deployAppsSessionSecret: secret,
    deployAppsLoginUrl: loginUrl.replace(/\/$/, ""),
    deployAppsLoginPath: loginPath,
  };
}

const SHARED_PLATFORM_SUFFIXES = [
  "onporter.run",
  "withporter.run",
  "porter.run",
  "fly.dev",
  "herokuapp.com",
  "onrender.com",
  "railway.app",
  "vercel.app",
  "netlify.app",
  "ondigitalocean.app",
  "azurewebsites.net",
  "elasticbeanstalk.com",
  "amazonaws.com",
  "cloudfront.net",
  "github.io",
  "pages.dev",
  "workers.dev",
  "e2b.app",
];

function sharedPlatformSuffixOf(domain: string): string | undefined {
  const host = domain.toLowerCase();
  return SHARED_PLATFORM_SUFFIXES.find((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

const HOSTNAME_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_RE = new RegExp(`^${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})+$`);

function deployAppsDomainEnv(env: NodeJS.ProcessEnv, deployProvider: string): string | undefined {
  const raw = env.DEPLOY_APPS_DOMAIN?.trim();
  if (raw) {
    const canonical = raw.toLowerCase().replace(/\.$/, "");
    if (!HOSTNAME_RE.test(canonical)) {
      throw new Error(
        `DEPLOY_APPS_DOMAIN (${raw}) is not a plain DNS name — set it to a bare domain like apps.example.com (no scheme, port, path, or wildcard prefix).`,
      );
    }
    const suffix = sharedPlatformSuffixOf(canonical);
    if (suffix) {
      throw new Error(
        `DEPLOY_APPS_DOMAIN (${canonical}) is under ${suffix}, a shared platform domain that cannot carry per-app subdomains — attach a custom domain you control (set DEPLOY_APPS_DOMAIN=apps.<your-domain> with a wildcard DNS record pointing at this instance), or unset it to keep serving apps signed-in at /d/<app>/.`,
      );
    }
    return canonical;
  }
  if (deployProvider === "porter" && env.PORTER_DEPLOY_APPS_DOMAIN) return env.PORTER_DEPLOY_APPS_DOMAIN;
  return env.AWS_DEPLOY_APPS_DOMAIN;
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

interface FlyDeployEnv {
  token: string;
  appPrefix: string;
  sharedAppName?: string;
  wireguardPeers?: string;
  metadataUri?: string;
  baseImage: string;
  org: string;
  region?: string;
  dataVolumeSizeGb?: number;
}

function flyDeployEnv(env: NodeJS.ProcessEnv): FlyDeployEnv {
  return {
    token: env.FLY_DEPLOY_API_TOKEN ?? "",
    appPrefix: env.FLY_DEPLOY_APP_PREFIX ?? "",
    ...(env.FLY_DEPLOY_SHARED_APP_NAME ? { sharedAppName: env.FLY_DEPLOY_SHARED_APP_NAME } : {}),
    ...(env.FLY_DEPLOY_WIREGUARD_PEERS ? { wireguardPeers: env.FLY_DEPLOY_WIREGUARD_PEERS } : {}),
    ...(env.ECS_CONTAINER_METADATA_URI_V4 ? { metadataUri: env.ECS_CONTAINER_METADATA_URI_V4 } : {}),
    baseImage: env.FLY_DEPLOY_BASE_IMAGE ?? "",
    org: env.FLY_ORG ?? "",
    ...(env.FLY_REGION ? { region: env.FLY_REGION } : {}),
    ...(env.FLY_DEPLOY_DATA_VOLUME_SIZE_GB !== undefined
      ? { dataVolumeSizeGb: Number(env.FLY_DEPLOY_DATA_VOLUME_SIZE_GB) }
      : {}),
  };
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

const CLAUDE_PROCESS_ENV = [
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
] as const;

function harnessEnvStrict(value: string | undefined): Config["harness"] {
  if (value === undefined || value.trim() === "") return "pi";
  const harness = value.trim();
  if (harness === "pi" || harness === "claude") return harness;
  throw new Error(`HARNESS=${JSON.stringify(value)} is not recognized — use pi or claude, or unset it.`);
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

function resolveStoreKinds(env: NodeJS.ProcessEnv): Pick<Config, "sessionStore" | "runStore"> {
  for (const key of ["SESSION_STORE", "RUN_STORE", "ARTIFACT_STORE"] as const) {
    if (env[key] === "sqlite") {
      throw new Error(
        `${key}=sqlite is no longer supported — SQLite was removed. ` +
          `Set ${key === "ARTIFACT_STORE" ? "DATABASE_URL (Postgres)" : `${key}=postgres (with DATABASE_URL)`}.`,
      );
    }
  }
  const sessionStore = env.SESSION_STORE === "postgres" ? "postgres" : "memory";
  const runStore = env.RUN_STORE === "memory" || env.RUN_STORE === "postgres" ? env.RUN_STORE : sessionStore;
  if (env.NODE_ENV === "production" && (sessionStore === "memory" || runStore === "memory")) {
    throw new Error(
      `production requires SESSION_STORE=postgres and a Postgres run store (got SESSION_STORE=${env.SESSION_STORE ?? "unset"}, RUN_STORE=${env.RUN_STORE ?? "unset"}): in-memory sessions and runs are lost on restart and invisible to other instances.`,
    );
  }
  return { sessionStore, runStore };
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
  const harness = harnessEnvStrict(env.HARNESS);
  const deployAppsDomain = deployAppsDomainEnv(env, env.DEPLOY_PROVIDER ?? "docker");
  const missingSecrets = validateCoreSecretEnv(env);
  if (missingSecrets.length) {
    const described = missingSecrets.map((name) => {
      const reason = CORE_SECRET_SPECS.find((spec) => spec.name === name)?.reason;
      return reason ? `${name} (${reason})` : name;
    });
    throw new Error(`missing or insecure required core secrets: ${described.join(", ")}`);
  }
  const { sessionStore, runStore } = resolveStoreKinds(env);
  const dataDir = resolve(env.DATA_DIR ?? "./data");
  if (env.DEPLOY_PROVIDER === "porter" && !env.PORTER_DEPLOY_APPS_DOMAIN && !env.DEPLOY_APPS_DOMAIN) {
    console.warn(
      "[config] DEPLOY_PROVIDER=porter without an apps domain — published apps are reachable signed-in at /d/<app>/ only; set DEPLOY_APPS_DOMAIN to a domain you control to serve each app on its own subdomain.",
    );
  }
  const porterLabel =
    env.DEPLOY_PROVIDER === "porter"
      ? "DEPLOY_PROVIDER=porter"
      : env.PORTER_DEPLOY_API_TOKEN && "PORTER_DEPLOY_API_TOKEN";
  if (porterLabel && !porterLocatorPresent(env)) {
    throw new Error(
      `${porterLabel} requires PORTER_DEPLOY_PROJECT_ID and PORTER_DEPLOY_CLUSTER_ID (or PORTER_SANDBOX_BASE_URL, or PORTER_CLUSTER_ID) to locate the Porter sandbox API.`,
    );
  }
  if (env.DEPLOY_PROVIDER === "render" && !env.RENDER_WORKSPACE_ID?.trim())
    throw new Error("Render providers require RENDER_WORKSPACE_ID");
  const retiredBrainEnv = ["BRAIN", "BRAIN_MCP_URL", "BRAIN_RO_CLIENT_ID", "BRAIN_RW_CLIENT_ID"].filter((name) =>
    env[name]?.trim(),
  );
  if (retiredBrainEnv.length) {
    console.warn(
      `[config] ${retiredBrainEnv.join(", ")} ${retiredBrainEnv.length === 1 ? "is" : "are"} retired and ignored — the brain integration was removed; point an external knowledge server at MEMORY_PROVIDER_CONFIG (docs/memory-providers.md). Remove the variables.`,
    );
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
  const publicUrl = env.PUBLIC_WEB_URL || publicApiUrl;
  const deployProvider = env.DEPLOY_PROVIDER ?? "docker";
  if (
    deployProvider !== "aws" &&
    deployProvider !== "docker" &&
    deployProvider !== "fly" &&
    deployProvider !== "porter" &&
    deployProvider !== "e2b" &&
    deployProvider !== "render"
  ) {
    throw new Error(
      `DEPLOY_PROVIDER=${JSON.stringify(deployProvider)} is not recognized (expected aws, docker, fly, porter, e2b, or render)`,
    );
  }
  const claudeProcessEnv = Object.fromEntries(
    CLAUDE_PROCESS_ENV.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])),
  ) as NodeJS.ProcessEnv;
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
    sessionStore,
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
    ...(env.DATABASE_OWNER_URL ? { databaseOwnerUrl: env.DATABASE_OWNER_URL } : {}),
    ...(env.DATABASE_READER_URL ? { databaseReaderUrl: env.DATABASE_READER_URL } : {}),
    ...(env.DATABASE_POOL_URL ? { databasePoolUrl: env.DATABASE_POOL_URL } : {}),
    ...(env.DATABASE_POOL_CA_CERT ? { databasePoolCaCert: env.DATABASE_POOL_CA_CERT } : {}),
    ...(env.DATABASE_POOL_MAX ? { databasePoolMax: numEnvStrict("DATABASE_POOL_MAX", env.DATABASE_POOL_MAX) } : {}),
    ...(env.DATABASE_DIRECT_POOL_MAX
      ? { databaseDirectPoolMax: numEnvStrict("DATABASE_DIRECT_POOL_MAX", env.DATABASE_DIRECT_POOL_MAX) }
      : {}),
    ...(env.DATABASE_CA_CERT ? { databaseCaCert: env.DATABASE_CA_CERT } : {}),
    ...(env.DATABASE_CA_CERT_FILE ? { databaseCaCertFile: env.DATABASE_CA_CERT_FILE } : {}),
    harness,
    deployProvider,
    ...(env.CLAUDE_BIN ? { claudeBinPath: env.CLAUDE_BIN } : {}),
    claudeProcessEnv,
    ...(env.ADMIN_GRANTS ? { adminGrants: env.ADMIN_GRANTS } : {}),
    ...(env.RESEND_API_KEY?.trim() ? { resendApiKey: env.RESEND_API_KEY.trim() } : {}),
    ...(env.AUTH_EMAIL_FROM?.trim() ? { emailFrom: env.AUTH_EMAIL_FROM.trim() } : {}),
    piCaptureRequests: boolEnvStrict("PI_CAPTURE_REQUESTS", env.PI_CAPTURE_REQUESTS) ?? true,
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
    ...(numEnvStrict("MAX_CONTEXT_TOKENS", env.MAX_CONTEXT_TOKENS) !== undefined
      ? { maxContextTokens: numEnvStrict("MAX_CONTEXT_TOKENS", env.MAX_CONTEXT_TOKENS) }
      : {}),
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
    ...(env.BACKGROUND_DEPLOYMENT_ID ? { backgroundDeploymentId: env.BACKGROUND_DEPLOYMENT_ID } : {}),
    ...(env.DEPLOYMENT_CONTROL_SECRET ? { deploymentControlSecret: env.DEPLOYMENT_CONTROL_SECRET } : {}),
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
    runStore,
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
    ...(numEnvStrict("MEMORY_CAPTURE_MAX_TURNS", env.MEMORY_CAPTURE_MAX_TURNS) !== undefined
      ? { memoryCaptureMaxTurns: numEnvStrict("MEMORY_CAPTURE_MAX_TURNS", env.MEMORY_CAPTURE_MAX_TURNS) }
      : {}),
    snapshotStore: env.SNAPSHOT_STORE === "s3" ? "s3" : "local",
    workspaceStore: env.WORKSPACE_STORE === "postgres" ? "postgres" : "local",
    transferStore: env.TRANSFER_STORE === "s3" ? "s3" : "local",
    ...(env.S3_BUCKET ? { s3Bucket: env.S3_BUCKET } : {}),
    ...(env.S3_REGION ? { s3Region: env.S3_REGION } : {}),
    ...(s3Endpoint ? { s3Endpoint } : {}),
    ...(env.S3_PREFIX ? { s3Prefix: env.S3_PREFIX } : {}),
    ...(numEnvStrict("DEPLOY_IDLE_TTL_MS", env.DEPLOY_IDLE_TTL_MS) !== undefined
      ? { deployIdleTtlMs: numEnvStrict("DEPLOY_IDLE_TTL_MS", env.DEPLOY_IDLE_TTL_MS) }
      : {}),
    deployGitDir: env.DEPLOY_GIT_DIR ? resolve(env.DEPLOY_GIT_DIR) : join(dataDir, "deploy-git"),
    deployDialTimeoutMs:
      numEnvStrict("DEPLOY_DIAL_TIMEOUT_MS", env.DEPLOY_DIAL_TIMEOUT_MS) ?? CONFIG_DEFAULTS.deployDialTimeoutMs,
    ...deployAppsEnv(env, publicUrl),
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
    localSandbox: localSandboxEnv(env),
    spritesSandbox: spritesSandboxEnv(env),
    smolmachinesSandbox: smolmachinesSandboxEnv(env),
    renderSandbox: renderSandboxEnv(env),
    renderDeploy: renderDeployEnv(env),
    porterDeploy: porterDeployEnv(env),
    e2bSandbox: e2bSandboxEnv(env),
    managedAgentsSandbox: managedAgentsSandboxEnv(env),
    modalSandbox: modalSandboxEnv(env),
    awsDeploy: {
      ...awsDeployEnv(env),
      ...(env.DEPLOY_APPS_DOMAIN && deployAppsDomain && !env.AWS_DEPLOY_APPS_DOMAIN
        ? { appsDomain: deployAppsDomain }
        : {}),
    },
    ...(deployAppsDomain ? { deployAppsDomain } : {}),
    flyDeploy: flyDeployEnv(env),
  };
}
