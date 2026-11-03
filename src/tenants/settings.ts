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
  })
  .partial()
  .strict();

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

let loader: ((tenant: string) => Promise<TenantSettings>) | undefined;

export function configureTenantSettings(load: ((tenant: string) => Promise<TenantSettings>) | undefined): void {
  loader = load;
}

export async function tenantSettings(): Promise<TenantSettings> {
  const tenant = boundTenant();
  return tenant && loader ? loader(tenant) : {};
}

export async function tenantSetting<K extends keyof TenantSettings>(key: K): Promise<TenantSettings[K]> {
  return (await tenantSettings())[key];
}
