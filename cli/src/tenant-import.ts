import {
  BRANDING_ENV,
  GOOGLE_WORKSPACE_DOMAIN,
  LOOPS_USERS,
  MODEL_KEY_ENV,
  OAUTH_CLIENT_ENV,
  POSTURE_ENV,
  isTenantSettingKey,
  type TenantSettingKey,
} from "./tenant-setting-names.ts";

type BrandingField = (typeof BRANDING_ENV)[keyof typeof BRANDING_ENV];
type PostureResource = (typeof POSTURE_ENV)[keyof typeof POSTURE_ENV];
type ModelProvider = keyof typeof MODEL_KEY_ENV;

export interface OAuthClientImport {
  provider: keyof typeof OAUTH_CLIENT_ENV;
  clientId: string;
  clientSecret: string;
  hostedDomain?: string;
}

export interface TenantImport {
  settings: Partial<Record<TenantSettingKey, string>>;
  branding: Partial<Record<BrandingField, string>>;
  postures: Partial<Record<PostureResource, string>>;
  modelKeys: Partial<Record<ModelProvider, string>>;
  oauthClients: OAuthClientImport[];
  loopsUsers: string[];
  names: string[];
}

export function tenantImport(env: Readonly<Record<string, string>>): TenantImport {
  const plan: TenantImport = {
    settings: {},
    branding: {},
    postures: {},
    modelKeys: {},
    oauthClients: [],
    loopsUsers: [],
    names: [],
  };
  const value = (name: string): string | undefined => env[name]?.trim() || undefined;
  const use = (...names: string[]): void => void plan.names.push(...names);
  for (const [name, raw] of Object.entries(env))
    if (isTenantSettingKey(name)) {
      plan.settings[name] = raw;
      use(name);
    }
  for (const [name, field] of Object.entries(BRANDING_ENV)) {
    const found = value(name);
    if (found) {
      plan.branding[field] = found;
      use(name);
    }
  }
  for (const [name, resource] of Object.entries(POSTURE_ENV)) {
    const found = value(name);
    if (found) {
      plan.postures[resource] = found;
      use(name);
    }
  }
  for (const [provider, name] of Object.entries(MODEL_KEY_ENV) as Array<[ModelProvider, string]>) {
    const found = value(name);
    if (found) {
      plan.modelKeys[provider] = found;
      use(name);
    }
  }
  const hostedDomain = value(GOOGLE_WORKSPACE_DOMAIN);
  for (const [provider, [idName, secretName]] of Object.entries(OAUTH_CLIENT_ENV) as Array<
    [keyof typeof OAUTH_CLIENT_ENV, readonly [string, string]]
  >) {
    const clientId = value(idName);
    const clientSecret = value(secretName);
    if (!clientId || !clientSecret) continue;
    const domain = provider === "google" ? hostedDomain : undefined;
    plan.oauthClients.push({ provider, clientId, clientSecret, ...(domain ? { hostedDomain: domain } : {}) });
    use(idName, secretName, ...(domain ? [GOOGLE_WORKSPACE_DOMAIN] : []));
  }
  plan.loopsUsers = (value(LOOPS_USERS) ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (plan.loopsUsers.length) use(LOOPS_USERS);
  plan.names = [...new Set(plan.names)].sort();
  return plan;
}

export type OperatorCall = (path: string, body: Record<string, unknown>) => Promise<{ status: number; body: string }>;

export class OperatorRouteError extends Error {}

export const ORG_SCOPE = "org:default-org";

const personal = (id: string): string => `personal:${id.includes("@") ? id.toLowerCase() : id}`;

export async function applyTenantImport(
  plan: TenantImport,
  tenant: string,
  call: OperatorCall,
  warn: (message: string) => void,
): Promise<{ applied: string[]; unsaved: string[] }> {
  const put = async (path: string, body: Record<string, unknown>): Promise<{ unchanged?: boolean }> => {
    const response = await call(path, { tenant, ...body });
    if (response.status < 200 || response.status >= 300)
      throw new OperatorRouteError(`${path} failed (${response.status}): ${response.body}`);
    return response.body ? (JSON.parse(response.body) as { unchanged?: boolean }) : {};
  };
  const applied: string[] = [];
  const unsaved: string[] = [];
  const resource = (name: string): string => `/v1/admin/scopes/${ORG_SCOPE}/${name}`;
  const putIfUnset = async (label: string, path: string, body: Record<string, unknown>): Promise<void> => {
    if (!(await put(path, { ...body, ifUnset: true })).unchanged) applied.push(label);
  };
  await put("/v1/install/tenant", {});
  await put("/v1/tenant-settings", { env: plan.settings });
  applied.push(...Object.keys(plan.settings).sort());
  if (Object.keys(plan.branding).length) await putIfUnset("branding", resource("branding"), plan.branding);
  for (const [name, posture] of Object.entries(plan.postures)) await putIfUnset(name, resource(name), { posture });
  for (const client of plan.oauthClients)
    await putIfUnset(`${client.provider} OAuth client`, resource("connectors"), { ...client });
  for (const scopeId of plan.loopsUsers.map(personal)) {
    await put(resource("feature-flags"), { featureName: "inbox_loops", scopeId, on: true });
    applied.push(`inbox_loops for ${scopeId}`);
  }
  for (const [provider, apiKey] of Object.entries(plan.modelKeys)) {
    const path = `/v1/admin/model-providers/${provider}`;
    const response = await call(path, { tenant, apiKey, ifUnset: true });
    if (response.status < 200 || response.status >= 300) {
      warn(`${provider} API key was not saved (${response.status}): ${response.body}`);
      unsaved.push(MODEL_KEY_ENV[provider as ModelProvider]);
    } else if (!(JSON.parse(response.body) as { unchanged?: boolean }).unchanged) applied.push(`${provider} API key`);
  }
  return { applied, unsaved };
}
