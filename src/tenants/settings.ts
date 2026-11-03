import { z } from "zod";
import { boundTenant } from "./context.ts";

const text = z.string().min(1).max(4096);

export const tenantSettingsSchema = z
  .object({
    storageBucket: text,
    storagePrefix: text,
    sandboxNamePrefix: z.string().regex(/^[a-z0-9-]{1,32}$/),
    sandboxCredentials: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), text),
    modelGatewayKey: text,
    oidcClient: z.object({ issuer: z.url(), clientId: text, clientSecret: text }).strict(),
    slackBridgeToken: text,
    connectorSecretKey: z.string().min(32).max(4096),
    orgId: z.string().min(1).max(200),
  })
  .partial()
  .strict();

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

let loader: ((tenant: string) => Promise<TenantSettings>) | undefined;
const loaded = new Map<string, TenantSettings>();

export function configureTenantSettings(load: ((tenant: string) => Promise<TenantSettings>) | undefined): void {
  loader = load;
  loaded.clear();
}

export async function tenantSettings(): Promise<TenantSettings> {
  const tenant = boundTenant();
  if (!tenant || !loader) return {};
  const settings = await loader(tenant);
  loaded.set(tenant, settings);
  return settings;
}

export function replaceLoadedTenantSettings(all: ReadonlyMap<string, TenantSettings>): void {
  loaded.clear();
  for (const [tenant, settings] of all) loaded.set(tenant, settings);
}

export function loadedTenantSettings(): TenantSettings {
  const tenant = boundTenant();
  return (tenant && loaded.get(tenant)) || {};
}

export async function tenantSetting<K extends keyof TenantSettings>(key: K): Promise<TenantSettings[K]> {
  return (await tenantSettings())[key];
}
