import { parseRenderSandboxImage, RENDER_SANDBOX_TTL_SEC } from "./render-limits.ts";
import type { LegacySandboxScopeDefaults } from "./sandbox-resource-upgrade.ts";
import type { SandboxBackendName } from "./sandbox-routing.ts";
import { parseScopeId } from "../types.ts";
import { numEnvStrict, optNum } from "../util/env.ts";

export interface SandboxSettings {
  sandboxBackend: SandboxBackendName;
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
  token?: string;
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
    ...(env.SPRITES_TOKEN ? { token: env.SPRITES_TOKEN } : {}),
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
  apiKey?: string;
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
    ...(env.E2B_API_KEY ? { apiKey: env.E2B_API_KEY } : {}),
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
  apiKey?: string;
  workspaceId?: string;
  image?: string;
  defaultTimeoutSec?: number;
}

function renderSandboxEnv(env: NodeJS.ProcessEnv): RenderSandboxEnv {
  const defaultTimeoutSec = numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC);
  const image = env.RENDER_SANDBOX_IMAGE?.trim();
  if (image) parseRenderSandboxImage(image);
  return {
    ...(env.RENDER_API_KEY?.trim() ? { apiKey: env.RENDER_API_KEY.trim() } : {}),
    ...(env.RENDER_WORKSPACE_ID?.trim() ? { workspaceId: env.RENDER_WORKSPACE_ID.trim() } : {}),
    ...(image ? { image } : {}),
    ...(defaultTimeoutSec !== undefined ? { defaultTimeoutSec } : {}),
  };
}

interface ManagedAgentsSandboxEnv {
  apiToken?: string;
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
    ...(env.DO_AGENTS_API_TOKEN ? { apiToken: env.DO_AGENTS_API_TOKEN } : {}),
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
  tokenId?: string;
  tokenSecret?: string;
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
    ...(env.MODAL_TOKEN_ID ? { tokenId: env.MODAL_TOKEN_ID } : {}),
    ...(env.MODAL_TOKEN_SECRET ? { tokenSecret: env.MODAL_TOKEN_SECRET } : {}),
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
  token?: string;
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
    ...(env.SMOLMACHINES_TOKEN ? { token: env.SMOLMACHINES_TOKEN } : {}),
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
  apiKey?: string;
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
    ...(env.AGENT37_API_KEY ? { apiKey: env.AGENT37_API_KEY } : {}),
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
  apiKey?: string;
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
    ...(env.SUPERSERVE_API_KEY ? { apiKey: env.SUPERSERVE_API_KEY } : {}),
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

export function enabledSandboxBackends(config: SandboxSettings): SandboxBackendName[] {
  const credentialed: Record<SandboxBackendName, boolean> = {
    local: Boolean(config.localSandbox?.image),
    sprites: Boolean(config.spritesSandbox?.token),
    smolmachines: Boolean(config.smolmachinesSandbox?.token),
    agent37: Boolean(config.agent37Sandbox?.apiKey),
    superserve: Boolean(config.superserveSandbox?.apiKey && config.superserveSandbox?.template),
    e2b: Boolean(config.e2bSandbox?.apiKey),
    "do-managed-agents": Boolean(config.managedAgentsSandbox?.apiToken),
    modal: Boolean(config.modalSandbox?.tokenId && config.modalSandbox?.tokenSecret),
    aws: Boolean(config.awsSandbox?.s3Bucket),
    porter: Boolean(config.porterSandbox?.token),
    render: Boolean(config.renderSandbox?.apiKey && config.renderSandbox?.workspaceId && config.renderSandbox?.image),
  };
  const enabled = new Set<SandboxBackendName>([config.sandboxBackend]);
  for (const [name, on] of Object.entries(credentialed)) {
    if (on) enabled.add(name as SandboxBackendName);
  }
  return [...enabled];
}

function sandboxBackendEnvStrict(value: string | undefined, name = "SANDBOX_BACKEND"): SandboxBackendName {
  if (value === undefined || value.trim() === "") return "local";
  const backend = value.trim();
  if (
    backend === "aws" ||
    backend === "local" ||
    backend === "sprites" ||
    backend === "smolmachines" ||
    backend === "e2b" ||
    backend === "modal" ||
    backend === "agent37" ||
    backend === "superserve" ||
    backend === "do-managed-agents" ||
    backend === "porter" ||
    backend === "render"
  )
    return backend;
  throw new Error(
    `${name}=${JSON.stringify(value)} is not recognized — use aws, local, sprites, smolmachines, e2b, modal, porter, agent37, superserve, do-managed-agents, or render, or unset it.`,
  );
}

function warnUnprotectedSandboxes(env: NodeJS.ProcessEnv): void {
  if (env.E2B_API_KEY && !env.E2B_SNAPSHOT_S3_BUCKET) {
    console.warn(
      "[config] e2b sandbox backend enabled without E2B_SNAPSHOT_S3_BUCKET — provider pause preserves the machine, but there are no home snapshots, so a sandbox the provider loses comes back with an empty home; set E2B_SNAPSHOT_S3_BUCKET for durable portable recovery.",
    );
  }
  if (env.MODAL_TOKEN_ID && env.MODAL_TOKEN_SECRET && !env.MODAL_SNAPSHOT_S3_BUCKET) {
    console.warn(
      "[config] modal sandbox backend enabled without MODAL_SNAPSHOT_S3_BUCKET — homes are kept only as native Modal checkpoints (limited retention), and homes saved before native checkpoints cannot be restored. Configure DATABASE_URL for durable checkpoint references.",
    );
  }
  if (env.SMOLMACHINES_TOKEN && !env.SMOLMACHINES_SNAPSHOT_S3_BUCKET) {
    console.warn(
      "[config] smolmachines sandbox backend enabled without SMOLMACHINES_SNAPSHOT_S3_BUCKET — stopping a machine is not a backup; set SMOLMACHINES_SNAPSHOT_S3_BUCKET for durable home recovery snapshots.",
    );
  }
  if (env.SANDBOX_BACKEND === "sprites" && !env.SPRITES_EGRESS_PROXY_URL) {
    console.warn(
      "[config] SANDBOX_BACKEND=sprites without SPRITES_EGRESS_PROXY_URL — sandboxes run with NO egress enforcement (fail-open); set SPRITES_EGRESS_PROXY_URL to the public egress proxy to force sandbox traffic through it.",
    );
  }
  if (env.SANDBOX_BACKEND === "e2b" && !env.E2B_EGRESS_PROXY_URL) {
    console.warn(
      "[config] SANDBOX_BACKEND=e2b without E2B_EGRESS_PROXY_URL — sandboxes run with NO egress enforcement (fail-open); set E2B_EGRESS_PROXY_URL to the public egress proxy so E2B's network rules admit only that host.",
    );
  }
  if (env.SANDBOX_BACKEND === "do-managed-agents" && !env.DO_AGENTS_EGRESS_PROXY_URL) {
    console.warn(
      "[config] SANDBOX_BACKEND=do-managed-agents without DO_AGENTS_EGRESS_PROXY_URL — sandboxes run with NO egress enforcement (fail-open); set DO_AGENTS_EGRESS_PROXY_URL to the public egress proxy so the session's egress allowlist admits only that host.",
    );
  }
  if (env.DO_AGENTS_API_TOKEN && !env.DO_AGENTS_SNAPSHOT_S3_BUCKET) {
    console.warn(
      "[config] do-managed-agents sandbox backend enabled without DO_AGENTS_SNAPSHOT_S3_BUCKET — pause preserves the microVM, but a destroyed session takes the home with it; set DO_AGENTS_SNAPSHOT_S3_BUCKET so a replacement session can hydrate from a portable snapshot.",
    );
  }
  if (env.MODAL_TOKEN_ID && env.MODAL_TOKEN_SECRET && !env.MODAL_EGRESS_PROXY_URL) {
    console.warn(
      "[config] modal sandbox backend enabled without MODAL_EGRESS_PROXY_URL — sandboxes run with NO egress enforcement (fail-open); set MODAL_EGRESS_PROXY_URL to the public https egress proxy so Modal's outbound allowlist admits only that host.",
    );
  }
  if (env.SANDBOX_BACKEND === "sprites" && !env.SPRITES_SNAPSHOT_S3_BUCKET) {
    console.warn(
      "[config] SANDBOX_BACKEND=sprites without SPRITES_SNAPSHOT_S3_BUCKET — retiring a computer deletes its sprite and every checkpoint irreversibly with no exported home; set SPRITES_SNAPSHOT_S3_BUCKET to export the home to S3 before a sprite is destroyed and to rehydrate a replacement.",
    );
  }
  if (env.SANDBOX_BACKEND === "smolmachines" && !env.SMOLMACHINES_EGRESS_PROXY_URL) {
    console.warn(
      "[config] SANDBOX_BACKEND=smolmachines without SMOLMACHINES_EGRESS_PROXY_URL — machines are created with open outbound networking and NO egress enforcement (fail-open); set SMOLMACHINES_EGRESS_PROXY_URL to allow-list only the egress proxy.",
    );
  }
  if (env.SANDBOX_BACKEND === "porter" && !env.PORTER_SANDBOX_EGRESS_PROXY_URL) {
    console.warn(
      "[config] SANDBOX_BACKEND=porter without PORTER_SANDBOX_EGRESS_PROXY_URL — sandboxes run with NO egress enforcement (fail-open); set PORTER_SANDBOX_EGRESS_PROXY_URL to the egress proxy to force sandbox traffic through it.",
    );
  }
}

export function sandboxSettings(env: NodeJS.ProcessEnv): SandboxSettings {
  warnUnprotectedSandboxes(env);
  if (env.SANDBOX_BACKEND === "porter" && !porterLocatorPresent(env)) {
    throw new Error(
      "SANDBOX_BACKEND=porter requires PORTER_DEPLOY_PROJECT_ID and PORTER_DEPLOY_CLUSTER_ID (or PORTER_SANDBOX_BASE_URL, or PORTER_CLUSTER_ID) to locate the Porter sandbox API.",
    );
  }
  if (env.NODE_ENV === "production" && !env.SANDBOX_BACKEND?.trim()) {
    throw new Error(
      "SANDBOX_BACKEND must be set explicitly in production — use sprites, smolmachines, e2b, modal, porter, agent37, superserve, do-managed-agents, render, aws, or local.",
    );
  }
  const sandboxBackend = sandboxBackendEnvStrict(env.SANDBOX_BACKEND);
  if (sandboxBackend === "render" && !env.RENDER_WORKSPACE_ID?.trim())
    throw new Error("Render providers require RENDER_WORKSPACE_ID");
  if (sandboxBackend === "render" && env.WORKSPACE_STORE !== "postgres")
    throw new Error("SANDBOX_BACKEND=render requires WORKSPACE_STORE=postgres");
  if (sandboxBackend === "render" && !env.RENDER_SANDBOX_IMAGE?.trim())
    throw new Error("SANDBOX_BACKEND=render requires RENDER_SANDBOX_IMAGE");
  const renderSandboxEnabled =
    sandboxBackend === "render" ||
    Boolean(env.RENDER_API_KEY?.trim() && env.RENDER_WORKSPACE_ID?.trim() && env.RENDER_SANDBOX_IMAGE?.trim());
  if (renderSandboxEnabled) {
    if ((numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC) ?? 600) + 60 >= RENDER_SANDBOX_TTL_SEC)
      throw new Error(
        `SANDBOX_TIMEOUT_SEC must stay more than 60 seconds below the ${RENDER_SANDBOX_TTL_SEC} second lifetime of disposable Render sandboxes`,
      );
  }
  const legacySandboxScopeDefaults: LegacySandboxScopeDefaults = {};
  if (env.SANDBOX_SCOPE_BACKENDS) {
    const values: unknown = JSON.parse(env.SANDBOX_SCOPE_BACKENDS);
    if (!values || typeof values !== "object" || Array.isArray(values))
      throw new Error("SANDBOX_SCOPE_BACKENDS must be an object of scope kinds and backend names");
    for (const [kind, value] of Object.entries(values)) {
      const parsed = parseScopeId(kind + ":scope").kind;
      if (!parsed || parsed !== kind || typeof value !== "string" || !value.trim())
        throw new Error("Invalid SANDBOX_SCOPE_BACKENDS entry: " + kind);
      legacySandboxScopeDefaults[parsed] = sandboxBackendEnvStrict(value, "SANDBOX_SCOPE_BACKENDS." + kind);
    }
  }
  if (sandboxBackend === "superserve" && !env.SUPERSERVE_TEMPLATE?.trim()) {
    throw new Error(
      "SANDBOX_BACKEND=superserve requires SUPERSERVE_TEMPLATE, the ready qm-agent-<release> template that carries the agent toolchain.",
    );
  }
  return {
    sandboxBackend,
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
