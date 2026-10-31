import { numEnvStrict, optNum } from "../util/env.ts";

export interface SandboxSettings {
  localSandbox: LocalSandboxEnv;
  spritesSandbox: SpritesSandboxEnv;
  smolmachinesSandbox: SmolmachinesSandboxEnv;
  e2bSandbox: E2bSandboxEnv;
  managedAgentsSandbox: ManagedAgentsSandboxEnv;
  modalSandbox: ModalSandboxEnv;
  renderSandbox: RenderSandboxEnv;
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

export function sandboxSettings(env: NodeJS.ProcessEnv): SandboxSettings {
  return {
    localSandbox: localSandboxEnv(env),
    spritesSandbox: spritesSandboxEnv(env),
    smolmachinesSandbox: smolmachinesSandboxEnv(env),
    renderSandbox: renderSandboxEnv(env),
    e2bSandbox: e2bSandboxEnv(env),
    managedAgentsSandbox: managedAgentsSandboxEnv(env),
    modalSandbox: modalSandboxEnv(env),
  };
}
