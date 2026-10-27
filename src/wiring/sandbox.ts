import type { StoresModule } from "./stores.ts";
import type { FilesModule } from "./files.ts";
import type { DeploymentLayerModule } from "./deployment-layer.ts";
import type { Head } from "./late.ts";
import { createSandboxResources } from "../sandbox/sandbox-resources.ts";
import { createSandboxResourceStore } from "../sandbox/sandbox-resource-store.ts";
import { mintCapabilityToken, EGRESS_PROXY_AUD, CAPABILITY_TTL_MS } from "../auth/capability-token.ts";
import { egressClaimAllowingControlPlane } from "../core/orchestrator.ts";
import type { Sandbox, BackendSandbox } from "../sandbox/sandbox.ts";
import { createSandboxRouter, type SandboxBackendName } from "../sandbox/sandbox-routing.ts";
import type { ScopeId } from "../types.ts";
import { BACKGROUND_JOB_TTL_MAX_MS } from "../connectors/background-exec-broker.ts";
import { type StoredE2bSandbox, createE2bSandbox, E2B_BODIES, E2B_TEMPLATE_TOOLS } from "../sandbox/e2b-sandbox.ts";
import { type StoredModalSandbox, MODAL_BODIES, createModalSandbox } from "../sandbox/modal-sandbox.ts";
import { createLocalSandbox, LOCAL_BODIES, type StoredLocalSandbox } from "../sandbox/local-sandbox.ts";
import { createSpritesSandbox, SPRITES_BODIES, type StoredSpritesSandbox } from "../sandbox/sprites-sandbox.ts";
import { loadConnectorSdk } from "../sandbox/connector-sdk.ts";
import { createSandboxBodies } from "../sandbox/sandbox-bodies.ts";
import {
  createSmolmachinesSandbox,
  SMOLMACHINES_BODIES,
  type StoredSmolmachinesSandbox,
} from "../sandbox/smolmachines-sandbox.ts";
import { type E2bClient, createSdkE2bClient } from "../sandbox/e2b-client.ts";
import { E2B_DEPLOY_IDLE_TIMEOUT_SEC } from "../deploy/e2b-deploy-provider.ts";
import {
  createManagedAgentsSandbox,
  MANAGED_AGENTS_BODIES,
  QM_TEMPLATE_TOOLS,
  type StoredManagedAgentsSandbox,
} from "../sandbox/managed-agents-sandbox.ts";
import { createSdkManagedAgentsClient } from "../sandbox/managed-agents-client.ts";
import { createSdkModalClient } from "../sandbox/modal-client.ts";
import { tenantConfig } from "../tenants/tenant-config.ts";
import { type Config, enabledSandboxBackends } from "../config.ts";

type SandboxInputs = Pick<Head, "config" | "late"> & {
  stores: StoresModule;
  files: FilesModule;
  deploymentLayer: DeploymentLayerModule;
};

export function buildSandbox(deps: SandboxInputs) {
  const { databaseUrl, advisoryLock, canUseSandboxScope } = deps.stores;
  const { config, late } = deps;
  const { sandboxBackends, sandboxOnError, e2bClient } = buildSandboxBackends(deps);

  const sandboxResources = createSandboxResources({
    store: createSandboxResourceStore(databaseUrl),
    backends: sandboxBackends,
    defaultBackend: config.sandboxBackend,
    lock: advisoryLock,
    beforeRetire: async (record) => {
      if ((await late.processes?.liveByScope(record.ownerScopeId))?.some((process) => process.sandboxId === record.id))
        throw new Error("stop this sandbox's background jobs before retiring it");
    },
    provisionOptions: async (scopeId) => {
      const { capabilitySecret, signingSecret, apiBaseUrl } = tenantConfig(config);
      const secret = capabilitySecret ?? signingSecret;
      if (!secret) return {};
      const egressToken = await mintCapabilityToken(
        {
          actorId: "system:sandbox-create",
          scopeId,
          aud: EGRESS_PROXY_AUD,
          egress: egressClaimAllowingControlPlane({ allowedHosts: [] }, apiBaseUrl ?? ""),
          exp: Date.now() + CAPABILITY_TTL_MS,
        },
        secret,
        config.capabilityTokenCompression,
      );
      return { egressToken };
    },
    canUseScope: canUseSandboxScope,
  });
  const sandbox: Sandbox = createSandboxRouter({
    resources: sandboxResources,
    backends: sandboxBackends,
    defaultBackend: config.sandboxBackend,
    onError: sandboxOnError,
  });
  return { sandbox, sandboxResources, sandboxOnError, e2bClient };
}

export type SandboxModule = ReturnType<typeof buildSandbox>;

function buildSandboxBackends(deps: SandboxInputs) {
  const { errors, blobTransfer, workspace } = deps.files;
  const { config } = deps;
  const { advisoryLock, databaseUrl } = deps.stores;
  const { deploymentLayer } = deps.deploymentLayer;

  const sandboxOnError = (
    e: { category: string; code: string; message: string; scopeLabel?: string },
    error?: unknown,
  ) =>
    errors.record(
      {
        category: e.category,
        code: e.code,
        message: e.message,
        scopeLabel: (e.scopeLabel ?? "unknown") as ScopeId,
      },
      error,
    );
  const sandboxShared = {
    ...config.sandbox,
    keepWarmSec: Math.ceil(BACKGROUND_JOB_TTL_MAX_MS / 1000),
    advisoryLock,
    blobTransfer,
    extraTools: deploymentLayer.advertisedTools,
    credentialPaths: deploymentLayer.credentialPaths,
    layerToolFiles: () => deploymentLayer.installFiles,
    tenantConfig: () => tenantConfig(config),
    onError: sandboxOnError,
  };
  const e2bBodies = createSandboxBodies<StoredE2bSandbox>(databaseUrl, E2B_BODIES);
  const modalBodies = createSandboxBodies<StoredModalSandbox>(databaseUrl, MODAL_BODIES);
  const buildLocal = (): BackendSandbox =>
    createLocalSandbox(workspace, {
      ...sandboxShared,
      ...config.localSandbox,
      store: createSandboxBodies<StoredLocalSandbox>(databaseUrl, LOCAL_BODIES),
    });
  const buildSprites = (): BackendSandbox =>
    createSpritesSandbox(workspace, {
      ...sandboxShared,
      ...config.spritesSandbox,
      store: createSandboxBodies<StoredSpritesSandbox>(databaseUrl, SPRITES_BODIES),
      connectorSdk: loadConnectorSdk,
    });
  const buildSmolmachines = (): BackendSandbox =>
    createSmolmachinesSandbox(workspace, {
      ...sandboxShared,
      ...config.smolmachinesSandbox,
      store: createSandboxBodies<StoredSmolmachinesSandbox>(databaseUrl, SMOLMACHINES_BODIES),
    });
  const e2bClient = (use: "computers" | "apps"): E2bClient => {
    const e2b = config.e2bSandbox;
    if (!e2b.apiKey)
      throw new Error(`${use === "apps" ? "DEPLOY_PROVIDER" : "SANDBOX_BACKEND"}=e2b requires E2B_API_KEY`);
    return createSdkE2bClient({
      apiKey: e2b.apiKey,
      ...(e2b.templateId ? { templateId: e2b.templateId } : {}),
      ...(use === "apps" ? { sandboxTtlMs: E2B_DEPLOY_IDLE_TIMEOUT_SEC * 1000 } : {}),
      ...(use === "computers" && config.sandbox.idleParkSec ? { sandboxTtlMs: config.sandbox.idleParkSec * 1000 } : {}),
      ...(config.sandbox.maxLifetimeSec ? { maxLifetimeMs: config.sandbox.maxLifetimeSec * 1000 } : {}),
      ...(use === "computers" && config.sandbox.egressProxyUrl
        ? { egressProxyUrl: config.sandbox.egressProxyUrl }
        : {}),
    });
  };
  const buildE2b = (): BackendSandbox =>
    createE2bSandbox(workspace, {
      ...sandboxShared,
      client: e2bClient("computers"),
      extraTools: [...(config.e2bSandbox.templateId ? E2B_TEMPLATE_TOOLS : []), ...deploymentLayer.advertisedTools],
      store: e2bBodies,
    });
  const buildManagedAgents = (): BackendSandbox => {
    const managedAgents = config.managedAgentsSandbox;
    if (!managedAgents.apiToken) throw new Error("SANDBOX_BACKEND=do-managed-agents requires DO_AGENTS_API_TOKEN");
    return createManagedAgentsSandbox(workspace, {
      ...sandboxShared,
      client: createSdkManagedAgentsClient({
        apiToken: managedAgents.apiToken,
        ...(managedAgents.template ? { template: managedAgents.template } : {}),
        ...(config.sandbox.idleParkSec ? { idleTimeoutSec: config.sandbox.idleParkSec } : {}),
        ...(config.sandbox.egressProxyUrl ? { egressProxyUrl: config.sandbox.egressProxyUrl } : {}),
      }),
      extraTools: [...(managedAgents.template ? QM_TEMPLATE_TOOLS : []), ...deploymentLayer.advertisedTools],
      store: createSandboxBodies<StoredManagedAgentsSandbox>(databaseUrl, MANAGED_AGENTS_BODIES),
    });
  };
  const buildModal = (): BackendSandbox => {
    const modal = config.modalSandbox;
    if (!modal.tokenId || !modal.tokenSecret)
      throw new Error("SANDBOX_BACKEND=modal requires MODAL_TOKEN_ID and MODAL_TOKEN_SECRET");
    return createModalSandbox(workspace, {
      ...sandboxShared,
      client: createSdkModalClient({
        tokenId: modal.tokenId,
        tokenSecret: modal.tokenSecret,
        app: () => {
          const { modalAppName, modalEnvironment } = tenantConfig(config);
          return { name: modalAppName ?? "qm", ...(modalEnvironment ? { environment: modalEnvironment } : {}) };
        },
        ...(modal.image ? { image: modal.image } : {}),
        ...(config.sandbox.cpus !== undefined ? { cpus: config.sandbox.cpus } : {}),
        ...(config.sandbox.memoryMb !== undefined ? { memoryMb: config.sandbox.memoryMb } : {}),
        ...(config.sandbox.maxLifetimeSec ? { sandboxTimeoutMs: config.sandbox.maxLifetimeSec * 1000 } : {}),
        ...(config.sandbox.idleParkSec ? { idleTimeoutMs: 2 * config.sandbox.idleParkSec * 1000 } : {}),
        ...(config.sandbox.egressProxyUrl ? { egressProxyUrl: config.sandbox.egressProxyUrl } : {}),
      }),
      connectorSdk: loadConnectorSdk,
      store: modalBodies,
    });
  };
  const buildBackend: Record<Config["sandboxBackend"], () => BackendSandbox> = {
    local: buildLocal,
    sprites: buildSprites,
    smolmachines: buildSmolmachines,
    e2b: buildE2b,
    modal: buildModal,
    "do-managed-agents": buildManagedAgents,
  };
  const enabledBackends = new Set(enabledSandboxBackends(config));
  const sandboxBackends: Partial<Record<SandboxBackendName, BackendSandbox>> = {
    [config.sandboxBackend]: buildBackend[config.sandboxBackend](),
  };
  for (const name of Object.keys(buildBackend) as Array<Config["sandboxBackend"]>) {
    if (name !== config.sandboxBackend && enabledBackends.has(name)) sandboxBackends[name] = buildBackend[name]();
  }
  return { sandboxBackends, sandboxOnError, e2bClient };
}
