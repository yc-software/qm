import type { LegacySandboxScopeDefaults } from "./sandbox-resource-upgrade.ts";
import { parseSandboxBackend } from "../tenants/settings-parse.ts";
import { parseScopeId } from "../types.ts";
import { numEnvStrict, optNum } from "../util/env.ts";

export interface SandboxSettings {
  legacySandboxScopeDefaults?: LegacySandboxScopeDefaults;
  awsSandbox: AwsSandboxEnv;
  localSandbox: LocalSandboxEnv;
  spritesSandbox: SpritesSandboxEnv;
  smolmachinesSandbox: SmolmachinesSandboxEnv;
  agent37Sandbox: Agent37SandboxEnv;
  superserveSandbox: SuperserveSandboxEnv;
  e2bSandbox: E2bSandboxEnv;
  managedAgentsSandbox: ManagedAgentsSandboxEnv;
  modalSandbox: ModalSandboxEnv;
  porterSandbox: PorterSandboxEnv;
  renderSandbox: RenderSandboxEnv;
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
    ...optNum(env, "AWS_SANDBOX_AGENT_PORT", "agentPort"),
    ...optNum(env, "AWS_SANDBOX_MAX_IDLE_SEC", "maxIdleDurationSeconds"),
    ...optNum(env, "AWS_SANDBOX_SUSPENDED_SEC", "suspendedDurationSeconds"),
    ...optNum(env, "AWS_SANDBOX_MAX_DURATION_SEC", "maximumDurationInSeconds"),
    ...optNum(env, "AWS_SANDBOX_ROTATE_AFTER_SEC", "rotateAfterSeconds"),
    ...optNum(env, "AWS_SANDBOX_SNAPSHOT_INTERVAL_MS", "snapshotIntervalMs"),
    ...optNum(env, "SANDBOX_TIMEOUT_SEC", "defaultTimeoutSec"),
    ...optNum(env, "AWS_SANDBOX_CPUS", "cpus"),
    ...optNum(env, "AWS_SANDBOX_MEMORY_MB", "memoryMb"),
    ...optNum(env, "AWS_SANDBOX_DISK_GB", "diskGb"),
  };
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
    ...optNum(env, "LOCAL_SANDBOX_CPUS", "cpus"),
    ...optNum(env, "LOCAL_SANDBOX_MEMORY_MB", "memoryMb"),
    ...(env.QM_CORE_CONTAINER ? { coreContainer: env.QM_CORE_CONTAINER } : {}),
    ...optNum(env, "SANDBOX_TIMEOUT_SEC", "defaultTimeoutSec"),
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
    ...optNum(env, "SPRITES_MEMORY_MB", "memoryMb"),
    ...optNum(env, "SANDBOX_TIMEOUT_SEC", "defaultTimeoutSec"),
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
    ...optNum(env, "E2B_SANDBOX_TTL_SEC", "sandboxTtlSec"),
    ...optNum(env, "E2B_MAX_LIFETIME_SEC", "maxLifetimeSec"),
    ...(env.E2B_PROXY ? { proxy: env.E2B_PROXY } : {}),
    ...(env.E2B_EGRESS_PROXY_URL ? { egressProxyUrl: env.E2B_EGRESS_PROXY_URL } : {}),
    ...(env.E2B_SNAPSHOT_S3_BUCKET ? { snapshotS3Bucket: env.E2B_SNAPSHOT_S3_BUCKET } : {}),
    ...optNum(env, "E2B_SNAPSHOT_INTERVAL_SEC", "snapshotIntervalSec"),
    ...optNum(env, "E2B_NATIVE_SNAPSHOT_INTERVAL_SEC", "nativeSnapshotIntervalSec"),
    ...optNum(env, "SANDBOX_TIMEOUT_SEC", "defaultTimeoutSec"),
  };
}

interface RenderSandboxEnv {
  defaultTimeoutSec?: number;
}

function renderSandboxEnv(env: NodeJS.ProcessEnv): RenderSandboxEnv {
  const defaultTimeoutSec = numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC);
  return defaultTimeoutSec !== undefined ? { defaultTimeoutSec } : {};
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
    ...optNum(env, "DO_AGENTS_IDLE_TIMEOUT_SEC", "idleTimeoutSec"),
    ...(env.DO_AGENTS_EGRESS_PROXY_URL ? { egressProxyUrl: env.DO_AGENTS_EGRESS_PROXY_URL } : {}),
    ...(env.DO_AGENTS_SNAPSHOT_S3_BUCKET ? { snapshotS3Bucket: env.DO_AGENTS_SNAPSHOT_S3_BUCKET } : {}),
    ...optNum(env, "DO_AGENTS_SNAPSHOT_INTERVAL_SEC", "snapshotIntervalSec"),
    ...optNum(env, "SANDBOX_TIMEOUT_SEC", "defaultTimeoutSec"),
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
  return {
    ...optNum(env, "MODAL_NATIVE_SNAPSHOT_INTERVAL_SEC", "nativeSnapshotIntervalSec"),
    ...optNum(env, "MODAL_SNAPSHOT_RETENTION_SEC", "snapshotRetentionSec"),
    ...(env.MODAL_APP_NAME ? { appName: env.MODAL_APP_NAME } : {}),
    ...(env.MODAL_ENVIRONMENT ? { environment: env.MODAL_ENVIRONMENT } : {}),
    ...(env.MODAL_IMAGE ? { image: env.MODAL_IMAGE } : {}),
    ...(env.MODAL_NAME_PREFIX ? { namePrefix: env.MODAL_NAME_PREFIX } : {}),
    ...optNum(env, "MODAL_CPUS", "cpus"),
    ...optNum(env, "MODAL_MEMORY_MB", "memoryMb"),
    ...(env.MODAL_REGIONS?.trim()
      ? {
          regions: env.MODAL_REGIONS.split(",")
            .map((r) => r.trim())
            .filter(Boolean),
        }
      : {}),
    ...optNum(env, "MODAL_SANDBOX_TIMEOUT_SEC", "sandboxTimeoutSec"),
    ...optNum(env, "MODAL_ROTATE_AFTER_SEC", "rotateAfterSec"),
    ...optNum(env, "MODAL_REAP_IDLE_SEC", "reapIdleSec"),
    ...(env.MODAL_EGRESS_PROXY_URL ? { egressProxyUrl: env.MODAL_EGRESS_PROXY_URL } : {}),
    ...(env.MODAL_SNAPSHOT_S3_BUCKET ? { snapshotS3Bucket: env.MODAL_SNAPSHOT_S3_BUCKET } : {}),
    ...optNum(env, "SANDBOX_TIMEOUT_SEC", "defaultTimeoutSec"),
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
    ...optNum(env, "SMOLMACHINES_CPUS", "cpus"),
    ...optNum(env, "SMOLMACHINES_MEMORY_MB", "memoryMb"),
    ...optNum(env, "SMOLMACHINES_DISK_GB", "diskGb"),
    ...optNum(env, "SMOLMACHINES_AUTOSTOP_SEC", "autoStopSec"),
    ...(env.SMOLMACHINES_EGRESS_PROXY_URL ? { egressProxyUrl: env.SMOLMACHINES_EGRESS_PROXY_URL } : {}),
    ...(env.SMOLMACHINES_SNAPSHOT_S3_BUCKET ? { snapshotS3Bucket: env.SMOLMACHINES_SNAPSHOT_S3_BUCKET } : {}),
    ...optNum(env, "SMOLMACHINES_SNAPSHOT_INTERVAL_SEC", "snapshotIntervalSec"),
    ...optNum(env, "SANDBOX_TIMEOUT_SEC", "defaultTimeoutSec"),
  };
}

interface PorterSandboxEnv {
  image?: string;
  token?: string;
  baseUrl?: string;
  namePrefix?: string;
  homeDir?: string;
  ttlSec?: number;
  egressProxyUrl?: string;
  defaultTimeoutSec?: number;
}

export function porterApiBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const deployProjectId = numEnvStrict("PORTER_DEPLOY_PROJECT_ID", env.PORTER_DEPLOY_PROJECT_ID);
  const deployClusterId = numEnvStrict("PORTER_DEPLOY_CLUSTER_ID", env.PORTER_DEPLOY_CLUSTER_ID);
  const derived =
    deployProjectId !== undefined && deployClusterId !== undefined
      ? `${(env.PORTER_DEPLOY_URL ?? "https://dashboard.porter.run").replace(/\/+$/, "")}/api/v2/alpha/projects/${deployProjectId}/clusters/${deployClusterId}`
      : undefined;
  return env.PORTER_SANDBOX_BASE_URL ?? derived;
}

export const porterLocatorPresent = (env: NodeJS.ProcessEnv): boolean =>
  Boolean(porterApiBaseUrl(env) || env.PORTER_CLUSTER_ID || env.KUBERNETES_SERVICE_HOST);

function porterSandboxEnv(env: NodeJS.ProcessEnv): PorterSandboxEnv {
  const token = env.PORTER_DEPLOY_API_TOKEN;
  const baseUrl = porterApiBaseUrl(env);
  const ttlSec = numEnvStrict("PORTER_SANDBOX_TTL_SEC", env.PORTER_SANDBOX_TTL_SEC);
  return {
    ...(env.PORTER_SANDBOX_IMAGE ? { image: env.PORTER_SANDBOX_IMAGE } : {}),
    ...(token ? { token } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(env.PORTER_SANDBOX_NAME_PREFIX ? { namePrefix: env.PORTER_SANDBOX_NAME_PREFIX } : {}),
    ...(env.PORTER_SANDBOX_HOME ? { homeDir: env.PORTER_SANDBOX_HOME } : {}),
    ...(ttlSec !== undefined ? { ttlSec } : {}),
    ...(env.PORTER_SANDBOX_EGRESS_PROXY_URL ? { egressProxyUrl: env.PORTER_SANDBOX_EGRESS_PROXY_URL } : {}),
    ...optNum(env, "SANDBOX_TIMEOUT_SEC", "defaultTimeoutSec"),
  };
}

interface Agent37SandboxEnv {
  baseUrl?: string;
  namePrefix?: string;
  template?: string;
  cpus?: number;
  memoryGb?: number;
  diskGb?: number;
  egressProxyUrl?: string;
  defaultTimeoutSec?: number;
}

function agent37SandboxEnv(env: NodeJS.ProcessEnv): Agent37SandboxEnv {
  return {
    ...(env.AGENT37_API_BASE_URL ? { baseUrl: env.AGENT37_API_BASE_URL } : {}),
    ...(env.AGENT37_NAME_PREFIX ? { namePrefix: env.AGENT37_NAME_PREFIX } : {}),
    ...(env.AGENT37_TEMPLATE ? { template: env.AGENT37_TEMPLATE } : {}),
    ...optNum(env, "AGENT37_CPUS", "cpus"),
    ...optNum(env, "AGENT37_MEMORY_GB", "memoryGb"),
    ...optNum(env, "AGENT37_DISK_GB", "diskGb"),
    ...(env.AGENT37_EGRESS_PROXY_URL ? { egressProxyUrl: env.AGENT37_EGRESS_PROXY_URL } : {}),
    ...optNum(env, "SANDBOX_TIMEOUT_SEC", "defaultTimeoutSec"),
  };
}

interface SuperserveSandboxEnv {
  baseUrl?: string;
  namePrefix?: string;
  template?: string;
  homeDir?: string;
  idlePauseSec?: number;
  retentionSec?: number;
  egressAllow?: string[];
  egressDeny?: string[];
  defaultTimeoutSec?: number;
  configGeneration?: number;
}

const csvList = (value: string | undefined): string[] | undefined => {
  const items = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
};

function superserveSandboxEnv(env: NodeJS.ProcessEnv): SuperserveSandboxEnv {
  const egressAllow = csvList(env.SUPERSERVE_EGRESS_ALLOW);
  const egressDeny = csvList(env.SUPERSERVE_EGRESS_DENY);
  const configGeneration = numEnvStrict("SUPERSERVE_CONFIG_GENERATION", env.SUPERSERVE_CONFIG_GENERATION);
  if (configGeneration !== undefined && (!Number.isSafeInteger(configGeneration) || configGeneration < 0)) {
    throw new Error(
      `SUPERSERVE_CONFIG_GENERATION=${JSON.stringify(env.SUPERSERVE_CONFIG_GENERATION)} must be a nonnegative safe integer, or unset it.`,
    );
  }
  return {
    ...(env.SUPERSERVE_BASE_URL?.trim() ? { baseUrl: env.SUPERSERVE_BASE_URL.trim() } : {}),
    ...(env.SUPERSERVE_NAME_PREFIX ? { namePrefix: env.SUPERSERVE_NAME_PREFIX } : {}),
    ...(env.SUPERSERVE_TEMPLATE?.trim() ? { template: env.SUPERSERVE_TEMPLATE.trim() } : {}),
    ...(env.SUPERSERVE_HOME_DIR ? { homeDir: env.SUPERSERVE_HOME_DIR } : {}),
    ...optNum(env, "SUPERSERVE_IDLE_PAUSE_SEC", "idlePauseSec"),
    ...optNum(env, "SUPERSERVE_RETENTION_SEC", "retentionSec"),
    ...(egressAllow ? { egressAllow } : {}),
    ...(egressDeny ? { egressDeny } : {}),
    ...optNum(env, "SANDBOX_TIMEOUT_SEC", "defaultTimeoutSec"),
    ...(configGeneration !== undefined ? { configGeneration } : {}),
  };
}

export function sandboxSettings(env: NodeJS.ProcessEnv): SandboxSettings {
  const legacySandboxScopeDefaults: LegacySandboxScopeDefaults = {};
  if (env.SANDBOX_SCOPE_BACKENDS) {
    const values: unknown = JSON.parse(env.SANDBOX_SCOPE_BACKENDS);
    if (!values || typeof values !== "object" || Array.isArray(values))
      throw new Error("SANDBOX_SCOPE_BACKENDS must be an object of scope kinds and backend names");
    for (const [kind, value] of Object.entries(values)) {
      const parsed = parseScopeId(kind + ":scope").kind;
      if (!parsed || parsed !== kind || typeof value !== "string" || !value.trim())
        throw new Error("Invalid SANDBOX_SCOPE_BACKENDS entry: " + kind);
      legacySandboxScopeDefaults[parsed] = parseSandboxBackend("SANDBOX_SCOPE_BACKENDS." + kind, value);
    }
  }
  return {
    legacySandboxScopeDefaults,
    awsSandbox: awsSandboxEnv(env),
    localSandbox: localSandboxEnv(env),
    spritesSandbox: spritesSandboxEnv(env),
    smolmachinesSandbox: smolmachinesSandboxEnv(env),
    agent37Sandbox: agent37SandboxEnv(env),
    superserveSandbox: superserveSandboxEnv(env),
    porterSandbox: porterSandboxEnv(env),
    renderSandbox: renderSandboxEnv(env),
    e2bSandbox: e2bSandboxEnv(env),
    managedAgentsSandbox: managedAgentsSandboxEnv(env),
    modalSandbox: modalSandboxEnv(env),
  };
}
