import { RENDER_SANDBOX_TTL_SEC } from "./render-limits.ts";
import type { SandboxBackendName } from "./sandbox-routing.ts";
import { numEnvStrict, optNum } from "../util/env.ts";

export interface SandboxSettings {
  sandboxBackend: SandboxBackendName;
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
  defaultTimeoutSec?: number;
}

function renderSandboxEnv(env: NodeJS.ProcessEnv): RenderSandboxEnv {
  const defaultTimeoutSec = numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC);
  return {
    ...(env.RENDER_API_KEY?.trim() ? { apiKey: env.RENDER_API_KEY.trim() } : {}),
    ...(env.RENDER_WORKSPACE_ID?.trim() ? { workspaceId: env.RENDER_WORKSPACE_ID.trim() } : {}),
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

export function enabledSandboxBackends(config: SandboxSettings): SandboxBackendName[] {
  const credentialed: Record<SandboxBackendName, boolean> = {
    local: Boolean(config.localSandbox?.image),
    sprites: Boolean(config.spritesSandbox?.token),
    smolmachines: Boolean(config.smolmachinesSandbox?.token),
    e2b: Boolean(config.e2bSandbox?.apiKey),
    "do-managed-agents": Boolean(config.managedAgentsSandbox?.apiToken),
    modal: Boolean(config.modalSandbox?.tokenId && config.modalSandbox?.tokenSecret),
    render: Boolean(config.renderSandbox?.apiKey && config.renderSandbox?.workspaceId),
  };
  const enabled = new Set<SandboxBackendName>([config.sandboxBackend]);
  for (const [name, on] of Object.entries(credentialed)) {
    if (on) enabled.add(name as SandboxBackendName);
  }
  return [...enabled];
}

function sandboxBackendEnvStrict(value: string | undefined): SandboxBackendName {
  if (value === undefined || value.trim() === "") return "local";
  const backend = value.trim();
  if (
    backend === "local" ||
    backend === "sprites" ||
    backend === "smolmachines" ||
    backend === "e2b" ||
    backend === "modal" ||
    backend === "do-managed-agents" ||
    backend === "render"
  )
    return backend;
  throw new Error(
    `SANDBOX_BACKEND=${JSON.stringify(value)} is not recognized — use local, sprites, smolmachines, e2b, modal, do-managed-agents, or render, or unset it.`,
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
}

export function sandboxSettings(env: NodeJS.ProcessEnv): SandboxSettings {
  warnUnprotectedSandboxes(env);
  if (env.NODE_ENV === "production" && !env.SANDBOX_BACKEND?.trim()) {
    throw new Error(
      "SANDBOX_BACKEND must be set explicitly in production — use sprites, smolmachines, e2b, modal, do-managed-agents, render, or local.",
    );
  }
  const sandboxBackend = sandboxBackendEnvStrict(env.SANDBOX_BACKEND);
  if (sandboxBackend === "render" && !env.RENDER_WORKSPACE_ID?.trim())
    throw new Error("Render providers require RENDER_WORKSPACE_ID");
  if (sandboxBackend === "render" && env.WORKSPACE_STORE !== "postgres")
    throw new Error("SANDBOX_BACKEND=render requires WORKSPACE_STORE=postgres");
  const renderSandboxEnabled =
    sandboxBackend === "render" || Boolean(env.RENDER_API_KEY?.trim() && env.RENDER_WORKSPACE_ID?.trim());
  if (renderSandboxEnabled) {
    if ((numEnvStrict("SANDBOX_TIMEOUT_SEC", env.SANDBOX_TIMEOUT_SEC) ?? 600) + 60 >= RENDER_SANDBOX_TTL_SEC)
      throw new Error(
        `SANDBOX_TIMEOUT_SEC must stay more than 60 seconds below the ${RENDER_SANDBOX_TTL_SEC} second Render sandbox lifetime`,
      );
  }
  return {
    sandboxBackend,
    localSandbox: localSandboxEnv(env),
    spritesSandbox: spritesSandboxEnv(env),
    smolmachinesSandbox: smolmachinesSandboxEnv(env),
    renderSandbox: renderSandboxEnv(env),
    e2bSandbox: e2bSandboxEnv(env),
    managedAgentsSandbox: managedAgentsSandboxEnv(env),
    modalSandbox: modalSandboxEnv(env),
  };
}
