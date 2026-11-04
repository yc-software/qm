import { z } from "zod";
import { boundTenant } from "./context.ts";

const text = z.string().min(1).max(4096);

export const TENANT_ENV_NAMES = [
  "ADMIN_GRANTS",
  "ANTHROPIC_API_KEY",
  "AUTH_ALLOWED_EMAILS",
  "AUTH_CLIENT_SECRET",
  "AUTH_EMAIL_FROM",
  "BROKER_CREDENTIALS",
  "CAPABILITY_SECRET",
  "COMPOSIO_API_KEY",
  "MODAL_APP_NAME",
  "MODAL_ENVIRONMENT",
  "MODAL_NAME_PREFIX",
  "MODAL_SNAPSHOT_S3_BUCKET",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "OPENROUTER_API_KEY",
  "ORG_BRAND_ORG_NAME",
  "PUBLIC_WEB_URL",
  "RESEND_API_KEY",
  "S3_BUCKET",
  "S3_PREFIX",
  "SANDBOX_BACKEND",
  "SANDBOX_SCOPE_BACKENDS",
  "SKILL_SIGNING_SECRET",
  "SPRITES_NAME_PREFIX",
  "SPRITES_TOKEN",
] as const;

const BROKER_SECRET_ENV = /^BROKER_SECRET_[A-Z0-9_]{1,64}$/;

export type TenantEnvName = (typeof TENANT_ENV_NAMES)[number] | `BROKER_SECRET_${string}`;

const tenantEnvNames: ReadonlySet<string> = new Set(TENANT_ENV_NAMES);

export function isTenantEnvName(name: string): name is TenantEnvName {
  return tenantEnvNames.has(name) || BROKER_SECRET_ENV.test(name);
}

export const tenantSettingsSchema = z
  .object({
    env: z
      .record(z.string().max(64), text)
      .refine((env) => Object.keys(env).every(isTenantEnvName), "not a per-tenant env name"),
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

export function tenantSettingsLoaded(): boolean {
  const tenant = boundTenant();
  return !tenant || !loader || loaded.has(tenant);
}

export async function tenantSetting<K extends keyof TenantSettings>(key: K): Promise<TenantSettings[K]> {
  return (await tenantSettings())[key];
}

export function tenantEnv(name: TenantEnvName): string | undefined {
  return loadedTenantSettings().env?.[name];
}
