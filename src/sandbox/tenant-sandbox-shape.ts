import { createHash } from "node:crypto";
import { bootTenant, tenancyBooted } from "../tenants/boot.ts";
import { loadTenant } from "../tenants/cache.ts";
import { boundTenant } from "../tenants/context.ts";
import { loadedTenantSettings, type TenantSettings } from "../tenants/settings.ts";
import type { ModalClient } from "./modal-client.ts";

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

export async function tenantModalShape(base: ModalShape): Promise<ModalShape> {
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
