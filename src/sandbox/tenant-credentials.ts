import { LRUCache } from "lru-cache";
import {
  requireTenantSetting,
  TenantSettingMissingError,
  type TenantSettingKey,
  type TenantSettings,
} from "../tenants/settings.ts";
import { currentTenant } from "../tenants/context.ts";
import type { SandboxBackendName } from "./sandbox-routing.ts";
import type { E2bClient } from "./e2b-client.ts";
import type { ManagedAgentsClient } from "./managed-agents-client.ts";
import { modalSandboxLifetimeMs, type ModalClient } from "./modal-client.ts";
import type { RenderClient } from "./render-client.ts";
import type { SuperserveClient } from "./superserve-client.ts";

const CREDENTIAL_KEYS = {
  sprites: ["SPRITES_TOKEN"],
  smolmachines: ["SMOLMACHINES_TOKEN"],
  e2b: ["E2B_API_KEY"],
  modal: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
  agent37: ["AGENT37_API_KEY"],
  superserve: ["SUPERSERVE_API_KEY"],
  "do-managed-agents": ["DO_AGENTS_API_TOKEN"],
  render: ["RENDER_SANDBOX_API_KEY", "RENDER_SANDBOX_WORKSPACE_ID"],
} as const satisfies Partial<Record<SandboxBackendName, readonly TenantSettingKey[]>>;

type CredentialedBackend = keyof typeof CREDENTIAL_KEYS;

const TENANT_SANDBOX_KEYS: Partial<Record<SandboxBackendName, readonly TenantSettingKey[]>> = CREDENTIAL_KEYS;

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

export type MisconfiguredSandboxBackends = Partial<Record<SandboxBackendName, string>>;

export function misconfiguredSandboxError(backend: string, reason: string): Error {
  return new Error(`sandbox backend ${backend} cannot run on this install: ${reason}`);
}

export function tenantSandboxRouting(
  settings: () => Promise<TenantSettings>,
  backends: Partial<Record<SandboxBackendName, { profile: { egressEnforcement?: string } }>>,
  misconfigured: MisconfiguredSandboxBackends = {},
) {
  const constructed = [...Object.keys(backends), ...Object.keys(misconfigured)] as SandboxBackendName[];
  const warned = new Set<string>();
  return {
    usable: async () => tenantSandboxBackends(await settings(), constructed),
    defaultBackend: async () => {
      const backend = tenantDefaultSandboxBackend(await settings(), constructed);
      const reason = misconfigured[backend];
      if (reason) throw misconfiguredSandboxError(backend, reason);
      const key = `${currentTenant()}:${backend}`;
      if (backends[backend]?.profile.egressEnforcement !== "domain" && !warned.has(key)) {
        warned.add(key);
        console.warn(
          `[sandbox] tenant ${currentTenant()} uses ${backend} with NO egress enforcement (fail-open); configure the ${backend} egress proxy to force sandbox traffic through it.`,
        );
      }
      return backend;
    },
  };
}

export function tenantCredential(
  settings: () => Promise<TenantSettings>,
  backend: "sprites" | "smolmachines" | "agent37",
): () => Promise<string> {
  return async () => requireTenantSetting(await settings(), CREDENTIAL_KEYS[backend][0]);
}

export function clientPerCredential<C extends object>(
  make: (...credential: string[]) => C,
): (...credential: string[]) => C {
  const clients = new LRUCache<string, C>({ max: 32 });
  return (...credential) => {
    const id = JSON.stringify(credential);
    const client = clients.get(id) ?? make(...credential);
    clients.set(id, client);
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
  backend: CredentialedBackend;
  make: (...credential: string[]) => C;
  methods: Record<AsyncMethod<C>, true>;
  streams?: Record<StreamMethod<C>, true>;
  fixed?: Partial<C>;
}): C {
  const clientFor = clientPerCredential(opts.make);
  const current = async (): Promise<C> => {
    const settings = await opts.settings();
    return clientFor(...CREDENTIAL_KEYS[opts.backend].map((key) => requireTenantSetting(settings, key)));
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
    sprites: tenantCredential(settings, "sprites"),
    smolmachines: tenantCredential(settings, "smolmachines"),
    agent37: tenantCredential(settings, "agent37"),
    e2b: (make: (apiKey: string) => E2bClient) =>
      tenantSdkClient({
        settings,
        backend: "e2b",
        make,
        methods: { info: true, create: true, connect: true, list: true, kill: true, deleteSnapshot: true },
        fixed: { nativePause: true },
      }),
    managedAgents: (make: (apiToken: string) => ManagedAgentsClient) =>
      tenantSdkClient({
        settings,
        backend: "do-managed-agents",
        make,
        methods: { info: true, create: true, connect: true, list: true, rollback: true, kill: true },
        fixed: { nativePause: true },
      }),
    modal: (sandboxTimeoutSec: number | undefined, make: (tokenId: string, tokenSecret: string) => ModalClient) =>
      tenantSdkClient({
        settings,
        backend: "modal",
        make: (tokenId, tokenSecret) => make(tokenId!, tokenSecret!),
        methods: { create: true, fromId: true, fromName: true, terminate: true },
        streams: { listRunning: true },
        fixed: { lifetimeMs: modalSandboxLifetimeMs(sandboxTimeoutSec ? sandboxTimeoutSec * 1000 : undefined) },
      }),
    superserve: (make: (apiKey: string) => SuperserveClient) =>
      tenantSdkClient({
        settings,
        backend: "superserve",
        make,
        methods: { create: true, connect: true, update: true, info: true, list: true, kill: true },
      }),
    render: (make: (apiKey: string, workspaceId: string) => RenderClient) =>
      tenantSdkClient({
        settings,
        backend: "render",
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
