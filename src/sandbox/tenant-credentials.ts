import {
  requireTenantSetting,
  TenantSettingMissingError,
  type TenantSettingKey,
  type TenantSettings,
} from "../tenants/settings.ts";
import type { SandboxBackendName } from "./sandbox-routing.ts";
import type { E2bClient } from "./e2b-client.ts";
import type { ManagedAgentsClient } from "./managed-agents-client.ts";
import { modalSandboxLifetimeMs, type ModalClient } from "./modal-client.ts";
import type { RenderClient } from "./render-client.ts";

const TENANT_SANDBOX_KEYS: Partial<Record<SandboxBackendName, readonly TenantSettingKey[]>> = {
  sprites: ["SPRITES_TOKEN"],
  smolmachines: ["SMOLMACHINES_TOKEN"],
  e2b: ["E2B_API_KEY"],
  modal: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
  "do-managed-agents": ["DO_AGENTS_API_TOKEN"],
  render: ["RENDER_SANDBOX_API_KEY", "RENDER_SANDBOX_WORKSPACE_ID"],
};

export function tenantSandboxBackends(
  settings: TenantSettings,
  constructed: readonly SandboxBackendName[],
): SandboxBackendName[] {
  return constructed.filter((backend) => (TENANT_SANDBOX_KEYS[backend] ?? []).every((key) => settings.values[key]));
}

export function tenantDefaultSandboxBackend(
  settings: TenantSettings,
  constructed: readonly SandboxBackendName[],
): SandboxBackendName {
  const backend = settings.sandboxBackend;
  if (!backend) throw new TenantSettingMissingError("SANDBOX_BACKEND");
  for (const key of TENANT_SANDBOX_KEYS[backend] ?? []) requireTenantSetting(settings, key);
  if (!constructed.includes(backend)) throw new Error(`sandbox backend unavailable: ${backend}`);
  return backend;
}

export function tenantSandboxRouting(
  settings: () => Promise<TenantSettings>,
  backends: Partial<Record<SandboxBackendName, unknown>>,
) {
  const constructed = Object.keys(backends) as SandboxBackendName[];
  return {
    usable: async () => tenantSandboxBackends(await settings(), constructed),
    defaultBackend: async () => tenantDefaultSandboxBackend(await settings(), constructed),
  };
}

export function tenantCredential(
  settings: () => Promise<TenantSettings>,
  key: TenantSettingKey,
): () => Promise<string> {
  return async () => requireTenantSetting(await settings(), key);
}

export function clientPerCredential<C>(
  make: (...credential: string[]) => C,
  limit = 32,
): (...credential: string[]) => C {
  const clients = new Map<string, C>();
  return (...credential) => {
    const id = JSON.stringify(credential);
    const client = clients.get(id) ?? make(...credential);
    clients.delete(id);
    clients.set(id, client);
    if (clients.size > limit) clients.delete(clients.keys().next().value!);
    return client;
  };
}

type AsyncMethod<C> = {
  [K in keyof C]-?: NonNullable<C[K]> extends (...args: never[]) => Promise<unknown> ? K : never;
}[keyof C];

type StreamMethod<C> = {
  [K in keyof C]-?: NonNullable<C[K]> extends (...args: never[]) => AsyncIterable<unknown> ? K : never;
}[keyof C];

export function tenantSdkClient<C extends object>(opts: {
  settings: () => Promise<TenantSettings>;
  keys: readonly TenantSettingKey[];
  make: (...credential: string[]) => C;
  methods: Record<AsyncMethod<C>, true>;
  streams?: Record<StreamMethod<C>, true>;
  fixed?: Partial<C>;
}): C {
  const clientFor = clientPerCredential(opts.make);
  const current = async (): Promise<C> => {
    const settings = await opts.settings();
    return clientFor(...opts.keys.map((key) => requireTenantSetting(settings, key)));
  };
  const bound: Record<string, unknown> = { ...opts.fixed };
  for (const method of Object.keys(opts.methods)) {
    bound[method] = async (...args: unknown[]) => {
      const client = (await current()) as Record<string, (...a: unknown[]) => Promise<unknown>>;
      return client[method]!(...args);
    };
  }
  for (const method of Object.keys(opts.streams ?? {})) {
    bound[method] = async function* (...args: unknown[]) {
      const client = (await current()) as Record<string, (...a: unknown[]) => AsyncIterable<unknown>>;
      yield* client[method]!(...args);
    };
  }
  return bound as C;
}

export function tenantSandboxClients(settings: () => Promise<TenantSettings>) {
  return {
    sprites: tenantCredential(settings, "SPRITES_TOKEN"),
    smolmachines: tenantCredential(settings, "SMOLMACHINES_TOKEN"),
    e2b: (make: (apiKey: string) => E2bClient) =>
      tenantSdkClient({
        settings,
        keys: ["E2B_API_KEY"],
        make,
        methods: { info: true, create: true, connect: true, list: true, kill: true, deleteSnapshot: true },
        fixed: { nativePause: true },
      }),
    managedAgents: (make: (apiToken: string) => ManagedAgentsClient) =>
      tenantSdkClient({
        settings,
        keys: ["DO_AGENTS_API_TOKEN"],
        make,
        methods: { info: true, create: true, connect: true, list: true, rollback: true, kill: true },
        fixed: { nativePause: true },
      }),
    modal: (sandboxTimeoutSec: number | undefined, make: (tokenId: string, tokenSecret: string) => ModalClient) =>
      tenantSdkClient({
        settings,
        keys: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
        make: (tokenId, tokenSecret) => make(tokenId!, tokenSecret!),
        methods: { create: true, fromId: true, fromName: true, terminate: true },
        streams: { listRunning: true },
        fixed: { lifetimeMs: modalSandboxLifetimeMs(sandboxTimeoutSec ? sandboxTimeoutSec * 1000 : undefined) },
      }),
    render: (make: (apiKey: string, workspaceId: string) => RenderClient) =>
      tenantSdkClient({
        settings,
        keys: ["RENDER_SANDBOX_API_KEY", "RENDER_SANDBOX_WORKSPACE_ID"],
        make: (apiKey, workspaceId) => make(apiKey!, workspaceId!),
        methods: {
          create: true,
          get: true,
          terminate: true,
          runScript: true,
          readFileBytes: true,
          writeFileBytes: true,
          createSnapshot: true,
          getSnapshot: true,
          waitSnapshot: true,
          deleteSnapshot: true,
        },
      }),
  };
}
