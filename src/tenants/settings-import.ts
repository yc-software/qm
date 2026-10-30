import { PROVIDERS } from "../connectors/oauth.ts";
import type { ModelCredentialStore } from "../model/model-credential-store.ts";
import { MODEL_PROVIDERS, type ModelProvider } from "../model/pi-models.ts";
import { sanitizeBranding } from "../resolution/branding.ts";
import type { ScopedConfigStore } from "../resolution/config-store.ts";
import { parseSharingPosture } from "../resolution/sharing-posture.ts";
import { parseSecurityPosture } from "../security/security-posture.ts";
import type { ScopeId } from "../types.ts";
import { isTenantSettingKey, TENANT_SETTING_KEYS, type TenantSettingsStore } from "./settings.ts";

const PROVIDER_KEY_ENV: Record<ModelProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const BRANDING_ENV = ["ORG_BRAND_ACCENT", "ORG_BRAND_MARK", "ORG_BRAND_SELF_LABEL", "ORG_BRAND_ORG_NAME"] as const;
const POSTURE_ENV = ["HARNESS_SECURITY_POSTURE", "HARNESS_SHARING_POSTURE"] as const;

function oauthClientEnv(): string[] {
  return [
    ...Object.values(PROVIDERS).flatMap((provider) => [provider.clientIdEnv, provider.clientSecretEnv]),
    "GOOGLE_WORKSPACE_DOMAIN",
  ];
}

export function tenantImportKeys(): string[] {
  return [
    ...TENANT_SETTING_KEYS,
    ...Object.values(PROVIDER_KEY_ENV),
    ...BRANDING_ENV,
    ...POSTURE_ENV,
    ...oauthClientEnv(),
  ];
}

export function tenantEnvPresent(env: NodeJS.ProcessEnv): string[] {
  return tenantImportKeys().filter((key) => env[key]?.trim());
}

export interface TenantSettingsImportDeps {
  settings: TenantSettingsStore;
  modelCredentials: Pick<ModelCredentialStore, "set">;
  config: Pick<ScopedConfigStore, "setSecurityPosture" | "setSharingPosture" | "setBranding" | "setConnectorClient">;
  rootScope: ScopeId;
  actor: string;
}

export function unknownTenantImportKeys(values: Readonly<Record<string, unknown>>): string[] {
  const known = new Set(tenantImportKeys());
  return Object.keys(values).filter((key) => !known.has(key));
}

function parsedPostures(values: Readonly<Record<string, string | undefined>>) {
  const security = values.HARNESS_SECURITY_POSTURE?.trim();
  const sharing = values.HARNESS_SHARING_POSTURE?.trim();
  const securityPosture = security ? parseSecurityPosture(security) : undefined;
  const sharingPosture = sharing ? parseSharingPosture(sharing) : undefined;
  if (security && !securityPosture)
    throw new Error(
      `HARNESS_SECURITY_POSTURE=${JSON.stringify(security)} is not recognized — use dangerous, auto, or strict.`,
    );
  if (sharing && !sharingPosture)
    throw new Error(`HARNESS_SHARING_POSTURE=${JSON.stringify(sharing)} is not recognized — use isolated or open.`);
  return { securityPosture, sharingPosture };
}

export async function importTenantSettings(
  values: Readonly<Record<string, string | undefined>>,
  deps: TenantSettingsImportDeps,
): Promise<string[]> {
  const unknown = unknownTenantImportKeys(values);
  if (unknown.length) throw new Error(`Not tenant settings: ${unknown.join(", ")}`);
  const present = Object.keys(values).filter((key) => values[key] !== undefined);
  const { securityPosture, sharingPosture } = parsedPostures(values);
  await deps.settings.update(Object.fromEntries(present.filter(isTenantSettingKey).map((key) => [key, values[key]!])));
  for (const provider of MODEL_PROVIDERS) {
    const key = values[PROVIDER_KEY_ENV[provider]]?.trim();
    if (key) await deps.modelCredentials.set(provider, key, deps.actor);
  }
  if (securityPosture) await deps.config.setSecurityPosture(deps.rootScope, securityPosture);
  if (sharingPosture) await deps.config.setSharingPosture(deps.rootScope, sharingPosture);
  if (BRANDING_ENV.some((key) => values[key] !== undefined)) {
    await deps.config.setBranding(
      deps.rootScope,
      sanitizeBranding({
        accent: values.ORG_BRAND_ACCENT,
        mark: values.ORG_BRAND_MARK,
        selfLabel: values.ORG_BRAND_SELF_LABEL,
        orgName: values.ORG_BRAND_ORG_NAME,
      }) ?? null,
    );
  }
  for (const [name, provider] of Object.entries(PROVIDERS)) {
    const clientId = values[provider.clientIdEnv]?.trim();
    const clientSecret = values[provider.clientSecretEnv]?.trim();
    if (!clientId || !clientSecret) continue;
    const hostedDomain = name === "google" ? values.GOOGLE_WORKSPACE_DOMAIN?.trim() : undefined;
    await deps.config.setConnectorClient(deps.rootScope, name, {
      clientId,
      clientSecret,
      ...(hostedDomain ? { hostedDomain } : {}),
      updatedBy: deps.actor,
    });
  }
  return present;
}
