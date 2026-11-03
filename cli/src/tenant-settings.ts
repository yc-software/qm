import { sandboxCoreEnv, securityScreenEnv, tenantOf, type QmConfig } from "./config.ts";
import { CoreUnreachableError, isCoreUnreachable } from "./deployment-layer.ts";
import { CliError, errMessage, step, warn } from "./log.ts";
import { operatorCredentials, operatorInit, type CoreLink } from "./operator-request.ts";
import { computedSecrets } from "./secrets.ts";
import { brokerWiring } from "./services.ts";
import { TARGET_ENV_DEFAULTS } from "./target-env-defaults.ts";
import { deploymentSecretValue, readEnvFile } from "./util.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isTenantSetting } from "./tenant-setting-names.ts";

function sandboxBackendSetting(config: QmConfig): Record<string, string> {
  const backend =
    config.target === "render"
      ? "render"
      : config.env.core?.SANDBOX_BACKEND?.trim() ||
        sandboxCoreEnv(config).env.SANDBOX_BACKEND ||
        config.sandbox?.backend ||
        TARGET_ENV_DEFAULTS[config.target](config, "core", "SANDBOX_BACKEND");
  return backend ? { SANDBOX_BACKEND: backend } : {};
}

const SLACK_SIGN_IN: Record<string, string> = {
  OIDC_AUTH_ENDPOINT: "https://slack.com/openid/connect/authorize",
  OIDC_TOKEN_ENDPOINT: "https://slack.com/api/openid.connect.token",
  OIDC_USERINFO_ENDPOINT: "https://slack.com/api/openid.connect.userInfo",
  OIDC_ISSUER: "https://slack.com",
  OIDC_JWKS_URI: "https://slack.com/openid/connect/keys",
  OIDC_SCOPES: "openid profile email",
  OIDC_PRINCIPAL_CLAIM: "email",
};

function portalSignInSettings(config: QmConfig): Record<string, string> {
  if (!config.services.includes("portal")) return {};
  if (config.services.includes("auth")) {
    const allowedEmailDomain = config.env.auth?.AUTH_ALLOWED_EMAIL_DOMAIN;
    return brokerWiring("portal", {
      publicUrl: config.publicUrl,
      authBaseUrl: "",
      ...(allowedEmailDomain ? { allowedEmailDomain } : {}),
    });
  }
  return config.target === "render" ? SLACK_SIGN_IN : {};
}

function webUiAccess(config: QmConfig): Record<string, string> {
  const loopsUsers = config.services.includes("web-ui") ? config.env["web-ui"]?.LOOPS_USERS : undefined;
  return loopsUsers ? { LOOPS_USERS: loopsUsers } : {};
}

export function tenantSettingsEnv(config: QmConfig, values: ReadonlyMap<string, string>): Record<string, string> {
  const secret = (name: string): string | undefined => deploymentSecretValue(name, values.get(name));
  const fromSecrets: Record<string, string> = {};
  for (const { name, services, aliases } of computedSecrets(config)) {
    const value = secret(name);
    if (value === undefined) continue;
    if (services.some((service) => service !== "sandbox")) fromSecrets[name] = value;
    for (const alias of aliases ?? []) fromSecrets[alias.name] = value;
  }
  const renderSandbox =
    config.target === "render" && config.render
      ? {
          RENDER_SANDBOX_WORKSPACE_ID: config.render.workspaceId,
          ...(secret("RENDER_API_KEY") ? { RENDER_SANDBOX_API_KEY: secret("RENDER_API_KEY")! } : {}),
        }
      : {};
  const authDomain = config.services.includes("auth") ? config.env.auth?.AUTH_ALLOWED_EMAIL_DOMAIN : undefined;
  const env: Record<string, string> = {
    ...sandboxBackendSetting(config),
    ...(config.model ? { PI_MODEL: config.model } : {}),
    ...(config.modelProvider ? { MODEL_PROVIDER: config.modelProvider } : {}),
    ...(config.botName ? { ORG_BRAND_SELF_LABEL: config.botName } : {}),
    ...(config.orgName ? { ORG_BRAND_ORG_NAME: config.orgName } : {}),
    ...(authDomain ? { AUTH_ALLOWED_EMAIL_DOMAIN: authDomain } : {}),
    ...portalSignInSettings(config),
    ...config.env.auth,
    ...config.env.portal,
    ...config.env.core,
    ...securityScreenEnv(config),
    ...renderSandbox,
    ...fromSecrets,
  };
  return {
    ...Object.fromEntries(Object.entries(env).filter(([name]) => isTenantSetting(name))),
    ...webUiAccess(config),
  };
}

export interface TenantSettingsTarget {
  coreLink(): Promise<CoreLink>;
  operatorSecret?: (name: string) => string | undefined;
  retireTenantEnv?: (names: readonly string[]) => string[];
}

function readStoredValues(
  config: QmConfig,
  values: Map<string, string>,
  target: TenantSettingsTarget,
  mode: "up" | "push",
): void {
  if (!target.operatorSecret) return;
  for (const { name, aliases } of computedSecrets(config)) {
    if (deploymentSecretValue(name, values.get(name)) !== undefined) continue;
    if (!isTenantSetting(name) && !(aliases ?? []).some((alias) => isTenantSetting(alias.name))) continue;
    let stored: string | undefined;
    try {
      stored = target.operatorSecret(name);
    } catch (error) {
      const message = `could not read ${name} from the deployment's secret store: ${errMessage(error)}`;
      if (mode === "push") throw new CliError(message);
      warn(`tenant settings: ${message}`);
      continue;
    }
    if (stored) values.set(name, stored);
  }
}

export async function seedTenantSettings(
  opts: { config: QmConfig; configDir: string; envFile?: string },
  target: TenantSettingsTarget,
  mode: "up" | "push",
): Promise<void> {
  const envPath = opts.envFile ?? join(opts.configDir, ".env");
  const values = new Map(existsSync(envPath) ? readEnvFile(envPath) : []);
  readStoredValues(opts.config, values, target, mode);
  let credentials: ReturnType<typeof operatorCredentials>;
  try {
    credentials = operatorCredentials(values, target.operatorSecret);
  } catch (error) {
    if (mode === "push") throw error;
    warn(`tenant settings: skipped (${errMessage(error)}); run \`qm settings push\` with them in .env`);
    return;
  }
  const settings = tenantSettingsEnv(opts.config, values);
  let core: CoreLink;
  try {
    core = await target.coreLink();
  } catch (error) {
    if (!(error instanceof CoreUnreachableError)) throw error;
    warn(`tenant settings: ${errMessage(error)}; run \`qm settings push\` once core is reachable`);
    return;
  }
  try {
    for (const [path, body] of [
      ["/v1/install/tenant", { tenant: tenantOf(opts.config) }],
      ["/v1/tenant-settings", { tenant: tenantOf(opts.config), env: settings }],
    ] as const) {
      const text = JSON.stringify(body);
      const response = await core.request(path, operatorInit(credentials, "PUT", path, text)).catch((error) => {
        if (!isCoreUnreachable(error)) throw error;
        throw new CoreUnreachableError(`core did not answer ${path}: ${errMessage(error)}`);
      });
      if (response.status < 200 || response.status >= 300)
        throw new CliError(`${path} failed (${response.status}): ${response.body}`);
    }
  } catch (error) {
    if (mode === "push" || !(error instanceof CoreUnreachableError)) throw error;
    warn(`tenant settings: ${errMessage(error)}; run \`qm settings push\` once core is reachable`);
    return;
  } finally {
    core.close();
  }
  step(`tenant settings: ${Object.keys(settings).sort().join(", ") || "nothing to seed"}`);
  const retired = target.retireTenantEnv?.(Object.keys(settings)) ?? [];
  if (retired.length) step(`tenant settings: removing ${retired.join(", ")} from the service env at the next deploy`);
}
