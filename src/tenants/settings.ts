import { z } from "zod";
import { boundTenant } from "./context.ts";

const text = z.string().min(1).max(4096);

const TENANT_ENV_NAMES = [
  "ADMIN_GRANTS",
  "ANTHROPIC_API_KEY",
  "AUTH_ALLOWED_EMAILS",
  "AUTH_CLIENT_SECRET",
  "AUTH_EMAIL_FROM",
  "AWS_PUBLIC_ORIGIN_URL",
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
  "PORTAL_TRUSTED_OIDC",
  "PORTAL_TRUSTED_OIDC_CLIENT_SECRET",
  "PUBLIC_API_URL",
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

function isTenantEnvName(name: string): name is TenantEnvName {
  return tenantEnvNames.has(name) || BROKER_SECRET_ENV.test(name);
}

const envName = z.string().max(64);

const tenantSettingsFields = {
  env: z.record(envName, text),
  modelGatewayKey: text,
  oidcClient: z.object({ issuer: z.url(), clientId: text, clientSecret: text }).strict(),
  slackBridgeToken: text,
  connectorSecretKey: z.string().min(32).max(4096),
  orgId: z.string().min(1).max(200),
};

export const tenantSettingsSchema = z
  .object({
    ...tenantSettingsFields,
    env: tenantSettingsFields.env.refine((env) => Object.keys(env).every(isTenantEnvName), "not a per-tenant env name"),
  })
  .partial()
  .strict();

const warnedSettings = new Set<string>();

function warnIgnoredSetting(tenant: string, key: string): void {
  const warning = `${tenant}:${key}`;
  if (warnedSettings.has(warning)) return;
  warnedSettings.add(warning);
  console.warn(`[tenant settings] ignoring unknown or invalid setting ${key} for tenant ${tenant}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readTenantSettings(value: unknown, tenant: string): TenantSettings {
  const settings: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(isRecord(value) ? value : {})) {
    if (key === "env" && isRecord(raw)) {
      const env: Record<string, string> = {};
      for (const [name, entry] of Object.entries(raw)) {
        const parsed = text.safeParse(entry);
        if (envName.safeParse(name).success && isTenantEnvName(name) && parsed.success) env[name] = parsed.data;
        else warnIgnoredSetting(tenant, `env.${name}`);
      }
      settings.env = env;
      continue;
    }
    const field = Object.hasOwn(tenantSettingsFields, key)
      ? tenantSettingsFields[key as keyof typeof tenantSettingsFields]
      : undefined;
    const parsed = field?.safeParse(raw);
    if (parsed?.success) settings[key] = parsed.data;
    else warnIgnoredSetting(tenant, key);
  }
  return settings as TenantSettings;
}

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

export function tenantAllowedEmails(): string[] | undefined {
  const raw = tenantEnv("AUTH_ALLOWED_EMAILS");
  if (raw === undefined) return undefined;
  return [
    ...new Set(
      raw
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}
