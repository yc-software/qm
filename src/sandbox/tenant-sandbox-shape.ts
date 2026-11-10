import { createHash } from "node:crypto";
import { bootTenant, tenancyBooted } from "../tenants/boot.ts";
import { loadTenant } from "../tenants/cache.ts";
import { boundTenant } from "../tenants/context.ts";
import { loadedTenantSettings, type TenantSettings } from "../tenants/settings.ts";
import type { ModalClient } from "./modal-client.ts";
import type { Sandbox } from "./sandbox.ts";
import type { LegacySandboxScopeDefaults } from "./sandbox-resource-upgrade.ts";
import type { SandboxBackendName } from "./sandbox-routing.ts";

interface TenantSandboxSettings {
  tenant: string;
  settings: TenantSettings;
}

async function tenantSandboxSettings(): Promise<TenantSandboxSettings | undefined> {
  const tenant = boundTenant();
  const boot = bootTenant();
  if (tenant === undefined) {
    if (boot === undefined && tenancyBooted()) throw new Error("sandbox work needs a bound tenant");
    return undefined;
  }
  if (tenant === boot) return undefined;
  await loadTenant();
  const settings = loadedTenantSettings();
  if (!settings) throw new Error("tenant settings are not loaded");
  return { tenant, settings };
}

export function tenantNamePrefix(prefix: string, tenant: string): string {
  return `${prefix}-${createHash("sha256").update(tenant).digest("hex").slice(0, 8)}`;
}

export interface SpritesShape {
  token: string;
  namePrefix: string;
}

export async function tenantSpritesShape(base: SpritesShape): Promise<SpritesShape> {
  const bound = await tenantSandboxSettings();
  if (!bound) return base;
  const { tenant, settings } = bound;
  return {
    token: settings.spritesToken ?? base.token,
    namePrefix: settings.spritesNamePrefix ?? tenantNamePrefix(base.namePrefix, tenant),
  };
}

export interface ModalShape {
  appName: string;
  environment?: string;
}

async function tenantModalShape(base: ModalShape): Promise<ModalShape> {
  const bound = await tenantSandboxSettings();
  if (!bound) return base;
  const environment = bound.settings.modalEnvironment ?? base.environment;
  return { appName: bound.settings.modalAppName ?? base.appName, ...(environment ? { environment } : {}) };
}

export async function tenantModalNamePrefix(prefix: string): Promise<string> {
  const bound = await tenantSandboxSettings();
  if (!bound) return prefix;
  const { modalNamePrefix, modalAppName, modalEnvironment } = bound.settings;
  if (modalNamePrefix && (modalAppName || modalEnvironment)) return modalNamePrefix;
  return tenantNamePrefix(prefix, bound.tenant);
}

export function tenantModalClient(base: ModalShape, make: (shape: ModalShape) => ModalClient): ModalClient {
  const clients = new Map<string, ModalClient>();
  const deployment = make(base);
  const current = async (): Promise<ModalClient> => {
    const shape = await tenantModalShape(base);
    const key = `${shape.appName}\0${shape.environment ?? ""}`;
    if (key === `${base.appName}\0${base.environment ?? ""}`) return deployment;
    let client = clients.get(key);
    if (!client) clients.set(key, (client = make(shape)));
    return client;
  };
  const byId = (): Promise<ModalClient> => (boundTenant() === undefined ? Promise.resolve(deployment) : current());
  const listRunning = deployment.listRunning?.bind(deployment);
  return {
    ...(deployment.lifetimeMs !== undefined ? { lifetimeMs: deployment.lifetimeMs } : {}),
    create: async (opts) => (await current()).create(opts),
    fromName: async (name) => (await current()).fromName(name),
    fromId: async (sandboxId) => (await byId()).fromId(sandboxId),
    terminate: async (sandboxId) => (await byId()).terminate(sandboxId),
    ...(listRunning ? { listRunning } : {}),
  };
}

export interface SandboxChoice {
  backend: SandboxBackendName;
  scopeBackends: LegacySandboxScopeDefaults;
}

export async function tenantSandboxChoice(base: SandboxChoice): Promise<SandboxChoice> {
  const bound = await tenantSandboxSettings();
  if (!bound) return base;
  const { sandboxBackend, sandboxScopeBackends } = bound.settings;
  if (!sandboxBackend && !sandboxScopeBackends) return base;
  return { backend: sandboxBackend ?? base.backend, scopeBackends: sandboxScopeBackends ?? {} };
}

export interface SuperserveShape {
  apiKey?: string;
  namePrefix: string;
  template?: string;
}

async function tenantSuperserveShape(base: SuperserveShape): Promise<SuperserveShape> {
  const bound = await tenantSandboxSettings();
  if (!bound) return base;
  const { superserveApiKey, superserveNamePrefix, superserveTemplate } = bound.settings;
  const template = superserveTemplate ?? base.template;
  const apiKey = superserveApiKey ?? base.apiKey;
  const shape = {
    ...(apiKey ? { apiKey } : {}),
    namePrefix: superserveNamePrefix ?? tenantNamePrefix(base.namePrefix, bound.tenant),
  };
  return { ...shape, ...(template ? { template } : {}) };
}

export function tenantSuperserveSandbox(
  base: SuperserveShape,
  make: (shape: SuperserveShape & { apiKey: string }) => Sandbox,
): Sandbox {
  const sandboxes = new Map<string, Sandbox>();
  const keyOf = (shape: SuperserveShape & { apiKey: string }): string =>
    JSON.stringify([shape.apiKey, shape.namePrefix, shape.template ?? ""]);
  const deployment = make({ ...base, apiKey: base.apiKey ?? "" });
  if (base.apiKey) sandboxes.set(keyOf({ ...base, apiKey: base.apiKey }), deployment);
  const current = async (): Promise<Sandbox> => {
    const shape = await tenantSuperserveShape(base);
    const apiKey = shape.apiKey;
    if (!apiKey) throw new Error("superserve has no API key for this tenant; set superserveApiKey in its settings");
    const key = keyOf({ ...shape, apiKey });
    let sandbox = sandboxes.get(key);
    if (!sandbox) sandboxes.set(key, (sandbox = make({ ...shape, apiKey })));
    return sandbox;
  };
  const delegated = Object.fromEntries(
    Object.entries(deployment)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => [
        name,
        async (...args: unknown[]): Promise<unknown> => {
          const sandbox = (await current()) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
          return sandbox[name]!(...args);
        },
      ]),
  );
  return { ...delegated, profile: deployment.profile } as unknown as Sandbox;
}

export class TenantKeyedMap<V> extends Map<string, V> {
  private static key(name: string): string {
    return `${boundTenant() ?? ""}\0${name}`;
  }
  override get(name: string): V | undefined {
    return super.get(TenantKeyedMap.key(name));
  }
  override set(name: string, value: V): this {
    return super.set(TenantKeyedMap.key(name), value);
  }
  override has(name: string): boolean {
    return super.has(TenantKeyedMap.key(name));
  }
  override delete(name: string): boolean {
    return super.delete(TenantKeyedMap.key(name));
  }
}
