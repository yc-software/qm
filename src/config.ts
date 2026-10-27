import { httpChatConfigsFromEnv, type HttpChatConfig } from "./surfaces/http-chat.ts";
import {
  deploymentBrokerCredentialsFromEnv,
  type DeploymentBrokerCredential,
} from "./credentials/deployment-credentials.ts";
import type { ExternalSlackPolicies } from "./resolution/external-slack.ts";
import { isBearerSecret, isStrongSigningSecret } from "./auth/source-auth.ts";
import { SANDBOX_BACKEND_NAMES, type SandboxBackendName } from "./sandbox/sandbox-routing.ts";
import { existsSync, readdirSync } from "node:fs";
import { homeTenantSettings, tenantSecretsKey, type TenantSettings } from "../plugins/chassis/src/tenant-settings.ts";
import { parseProviderBaseUrl, type ModelGatewayTransportConfig } from "./model/provider-endpoints.ts";
import { join, resolve } from "node:path";
import { RUN_MAX_AGE_MS } from "./runs/run-store.ts";
import { DEFAULT_MEMORY_POLICY, type MemoryCaptureMode, type MemoryRecallMode } from "./memory/policy.ts";
import { sanitizeBranding } from "./resolution/branding.ts";
import type { OrgBranding } from "./resolution/config-store.ts";
import { CORE_SECRET_SPECS, validateCoreSecretEnv } from "./deployment/secret-schema.ts";
import { DEFAULT_CAPTURE_QUIET_MS } from "./memory/strategies/per-turn.ts";
import { slackPluginConfigFromEnv, slackAccountConfigsFromEnv, type SlackPluginConfig } from "./slack/config.ts";
import {
  DEFAULT_CODEX_MODEL_ID,
  MODEL_PROVIDERS,
  defaultModelForProvider,
  isModelProvider,
  onlyProvider,
  type ModelProvider,
  type ModelProviderAvailability,
} from "./model/pi-models.ts";
import {
  awsDeployEnv,
  defined,
  deployAppsDomainEnv,
  deployAppsEnv,
  flag,
  num,
  porterDeployEnv,
  porterLocatorPresent,
  raw,
  readEnv,
  sandboxEnv,
  sandboxProvidersEnv,
  str,
  trimmed,
  type Env,
} from "./config-env.ts";

interface TenantConfig {
  orgId: string;
  brandingDefault?: OrgBranding;
  brokerCredentials?: DeploymentBrokerCredential[];
  adminGrants?: string;
  trustedOidcAdminIssuer?: string;
  emailAuthPrincipals?: string[];
  emailAuthDomain?: string;
  apiBaseUrl?: string;
  publicUrl?: string;
  publicWebUrl?: string;
  slack?: SlackPluginConfig;
  externalSlackPolicies?: ExternalSlackPolicies;
  chatSurfaces?: HttpChatConfig[];
  s3Prefix?: string;
  deployAppsSessionSecret?: string;
  deployAppsLoginUrl?: string;
  deployAppsLoginPath?: "/auth/login" | "/auth/trusted/login";
  deployAppsDomain?: string;
}

interface DeploymentConfig extends ReturnType<typeof sandboxProvidersEnv> {
  productAnalytics?: { apiKey: string; host?: string };
  suggestedActivitiesEnabled?: boolean;
  suggestedActivitiesContext?: string;
  production: boolean;
  /** QM_MULTITENANT=1: one process serves every registered tenant from one database with row-level tenancy. */
  multitenant: boolean;
  tenantSecretsKey?: Buffer;
  port: number;
  publicPort?: number;
  dataDir: string;
  databaseUrl?: string;
  databaseCaCert?: string;
  databaseCaCertFile?: string;
  databasePoolUrl?: string;
  databasePoolCaCert?: string;
  databasePoolMax?: number;
  databaseDirectPoolMax?: number;
  sandboxBackend: SandboxBackendName;
  deployProvider: "docker" | "aws" | "porter" | "e2b";
  modelId?: string;
  /** Keychain credential id holding the Codex ChatGPT OAuth auth.json (production path). */
  codexAuthCredential?: string;
  /** Keychain credential id holding a Claude Code subscription token (production path). */
  claudeAuthCredential?: string;
  detectModelId?: string;
  titleModelId?: string;
  judgeModelId?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  openrouterApiKey?: string;
  modelProvider?: ModelProvider;
  modelGateway?: ModelGatewayTransportConfig;
  resendApiKey?: string;
  emailFrom?: string;
  budgetUsdPerWindow?: number;
  orgBudgetUsdPerWindow?: number;
  maxContextTokens?: number;
  turnWallClockMs: number;
  runWaitMs: number;
  backgroundWorkEnabled: boolean;
  backgroundDeploymentId?: string;
  deploymentControlSecret?: string;
  spendExportToken?: string;
  buildSha?: string;
  signingSecret?: string;
  capabilitySecret?: string;
  capabilityTokenCompression?: boolean;
  portalIdentitySecret?: string;
  requireSignedPortalIdentity?: boolean;
  connectorSecretKey?: string;
  seedSkills: boolean;
  pluginSkillDirs: string[];
  deploymentLayerDir?: string;
  layerEnv?: Readonly<Record<string, string | undefined>>;
  s3Bucket?: string;
  s3Region?: string;
  deployGitDir: string;
  cronFireConcurrency: number;
  memoryRecall: MemoryRecallMode;
  memoryCapture: MemoryCaptureMode;
  memoryCaptureQuietMs: number;
  workers: number;
  reaperIntervalMs: number;
  shutdownDrainMs: number;
  maxAttempts: number;
  approvalSummaryTimeoutMs: number;
  turnLeaseWaitMs: number;
  securityScreenTimeoutMs: number;
  securityScreenProxy?: {
    provider: string;
    endpoint: string;
    token: string;
  };
  reachExecEnabled: boolean;
  sandbox: ReturnType<typeof sandboxEnv>;
  porterDeploy: ReturnType<typeof porterDeployEnv>;
  awsDeploy: ReturnType<typeof awsDeployEnv>;
}

export type Config = DeploymentConfig & TenantConfig;

export function configuredModel(config: Config): string | undefined {
  if (
    !config.modelId &&
    !config.anthropicApiKey &&
    !config.modelProvider &&
    companySubscriptionAuth(config) === "openai"
  )
    return DEFAULT_CODEX_MODEL_ID;
  return config.modelId;
}

export function providerKeysPresent(config: Config): ModelProviderAvailability {
  return {
    anthropic: Boolean(config.anthropicApiKey || config.claudeAuthCredential),
    openai: Boolean(config.openaiApiKey),
    openrouter: Boolean(config.openrouterApiKey),
    ...(config.codexAuthCredential ? { codexOAuth: true } : {}),
  };
}

export function baseModelProviders(config: Config): ModelProviderAvailability | undefined {
  return config.modelProvider ? onlyProvider(config.modelProvider) : undefined;
}

export function companySubscriptionAuth(config: Config): ModelProvider | undefined {
  if (!config.anthropicApiKey && config.claudeAuthCredential) return "anthropic";
  if (config.codexAuthCredential) return "openai";
  return undefined;
}

const DEFAULT_ORG_ID = "default-org";

export function processOrgId(): string {
  return process.env.ORG_ID ?? DEFAULT_ORG_ID;
}

export function processTenantSettings(home: { orgId: string; id?: string; slug?: string }): TenantSettings {
  return homeTenantSettings(process.env, home);
}

export const CONFIG_DEFAULTS = {
  port: 8080,
  turnWallClockSec: 0,
  backgroundWorkEnabled: true,
  cronFireConcurrency: 4,
  approvalSummaryTimeoutMs: 6_000,
  turnLeaseWaitMs: 5_000,
  securityScreenTimeoutMs: 15_000,
  workers: 16,
  reaperIntervalMs: 15_000,
  shutdownDrainMs: 30_000,
  maxAttempts: 3,
} as const;

function backgroundWorkEnabled(env: Env): boolean {
  return (
    readEnv(env, { BACKGROUND_WORK_ENABLED: flag }).BACKGROUND_WORK_ENABLED ?? CONFIG_DEFAULTS.backgroundWorkEnabled
  );
}

function orgBrandingFromEnv(env: Env): Config["brandingDefault"] {
  return sanitizeBranding({
    accent: env.ORG_BRAND_ACCENT,
    mark: env.ORG_BRAND_MARK,
    selfLabel: env.ORG_BRAND_SELF_LABEL,
    orgName: env.ORG_BRAND_ORG_NAME,
  });
}

export function enabledSandboxBackends(config: Config): Array<Config["sandboxBackend"]> {
  const credentialed: Record<Config["sandboxBackend"], boolean> = {
    local: Boolean(config.localSandbox?.image),
    sprites: Boolean(config.spritesSandbox?.token),
    smolmachines: Boolean(config.smolmachinesSandbox?.token),
    e2b: Boolean(config.e2bSandbox?.apiKey),
    "do-managed-agents": Boolean(config.managedAgentsSandbox?.apiToken),
    modal: Boolean(config.modalSandbox?.tokenId && config.modalSandbox?.tokenSecret),
  };
  const enabled = new Set<Config["sandboxBackend"]>([config.sandboxBackend]);
  for (const [name, on] of Object.entries(credentialed)) {
    if (on) enabled.add(name as Config["sandboxBackend"]);
  }
  return [...enabled];
}

/** "a, b, or c" */
const orList = (names: readonly string[]): string => `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`;

function sandboxBackendEnvStrict(value: string | undefined, name = "SANDBOX_BACKEND"): Config["sandboxBackend"] {
  if (value === undefined || value.trim() === "") return "local";
  const backend = value.trim();
  if ((SANDBOX_BACKEND_NAMES as readonly string[]).includes(backend)) return backend as SandboxBackendName;
  throw new Error(
    `${name}=${JSON.stringify(value)} is not recognized — use ${orList(SANDBOX_BACKEND_NAMES)}, or unset it.`,
  );
}

export function modelGatewayFromEnv(env: Env): ModelGatewayTransportConfig | undefined {
  const names = ["MODEL_GATEWAY_URL", "MODEL_GATEWAY_API_KEY", "MODEL_GATEWAY_API_KEY_HEADER", "MODEL_GATEWAY_MODELS"];
  if (!names.some((name) => env[name]?.trim())) return undefined;
  for (const name of names.filter((name) => name !== "MODEL_GATEWAY_MODELS")) {
    if (!env[name]?.trim()) throw new Error(`${name} is required when model gateway routing is configured`);
  }
  const apiKeyHeader = env.MODEL_GATEWAY_API_KEY_HEADER!.trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(apiKeyHeader)) {
    throw new Error("MODEL_GATEWAY_API_KEY_HEADER must be a valid HTTP header name");
  }
  const models: Record<string, string> = {};
  for (const mapping of env.MODEL_GATEWAY_MODELS?.trim() ? env.MODEL_GATEWAY_MODELS.split(",") : []) {
    const separator = mapping.indexOf("=");
    const source = mapping.slice(0, separator).trim();
    const target = mapping.slice(separator + 1).trim();
    if (separator < 1 || !source || !target) throw new Error(`invalid MODEL_GATEWAY_MODELS mapping: ${mapping}`);
    if (models[source]) throw new Error(`duplicate MODEL_GATEWAY_MODELS source: ${source}`);
    models[source] = target;
  }
  return {
    url: parseProviderBaseUrl("MODEL_GATEWAY_URL", env.MODEL_GATEWAY_URL!),
    apiKey: env.MODEL_GATEWAY_API_KEY!,
    apiKeyHeader,
    models,
  };
}

function defaultPluginSkillDirs(): string[] {
  const root = resolve("./plugins");
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, "skills"))
      .filter((dir) => existsSync(dir));
  } catch {
    return [];
  }
}

function modelProviderEnvStrict(env: Env): ModelProvider | undefined {
  const declared = env.MODEL_PROVIDER?.trim();
  if (!declared) return undefined;
  if (!isModelProvider(declared)) {
    throw new Error(
      `MODEL_PROVIDER=${JSON.stringify(declared)} is not recognized — use ${MODEL_PROVIDERS.join(", ")}.`,
    );
  }
  if (!defaultModelForProvider(declared)) {
    throw new Error(
      `MODEL_PROVIDER=${declared} cannot serve a base model — no ${declared} model is available, so every turn would be refused.`,
    );
  }
  return declared;
}

/**
 * Source requests, capability tokens, portal identity and connector keys each sign with their own secret, so a
 * surface holding one cannot forge another. Whenever source signing or portal identity is on, all three are required.
 */
function assertDistinctSecrets(secrets: {
  signing?: string;
  capability?: string;
  portalIdentity?: string;
  connector?: string;
  enforcePortalIdentity: boolean;
}): void {
  if (secrets.signing || secrets.enforcePortalIdentity) {
    const shared = (name: string, value: string | undefined): string | null => {
      if (!value) return `${name} is not set`;
      return value === secrets.signing ? `${name} must differ from CORE_SIGNING_SECRET` : null;
    };
    const problem =
      shared("CAPABILITY_SECRET", secrets.capability) ??
      shared("PORTAL_IDENTITY_SECRET", secrets.portalIdentity) ??
      (secrets.capability === secrets.portalIdentity
        ? "PORTAL_IDENTITY_SECRET must differ from CAPABILITY_SECRET"
        : null);
    if (problem)
      throw new Error(
        `${problem}: CORE_SIGNING_SECRET, CAPABILITY_SECRET and PORTAL_IDENTITY_SECRET must all be set and distinct, or a surface could forge capabilities or portal identity.`,
      );
  }
  const reusedConnectorKey = (
    [
      ["CORE_SIGNING_SECRET", secrets.signing],
      ["CAPABILITY_SECRET", secrets.capability],
      ["PORTAL_IDENTITY_SECRET", secrets.portalIdentity],
    ] as const
  ).find(([, value]) => secrets.connector && secrets.connector === value)?.[0];
  if (reusedConnectorKey) throw new Error(`CONNECTOR_SECRET_KEY must differ from ${reusedConnectorKey}`);
}

const DNS_LABEL_MAX_LENGTH = 63;

function checkedDeploymentEnv(env: Env) {
  const token = env.SPEND_EXPORT_TOKEN;
  if (token) {
    const reused = Object.entries(env).some(([name, value]) => name !== "SPEND_EXPORT_TOKEN" && value === token);
    if (!isStrongSigningSecret(token) || !isBearerSecret(token) || reused)
      throw new Error(
        "SPEND_EXPORT_TOKEN must be at least 32 characters, have no surrounding whitespace and differ from every other environment value",
      );
  }
  if (env.BACKGROUND_DEPLOYMENT_ID !== undefined) {
    if (!env.BACKGROUND_DEPLOYMENT_ID.trim()) throw new Error("BACKGROUND_DEPLOYMENT_ID must be nonempty");
    if (!env.DATABASE_URL) throw new Error("Background ownership requires DATABASE_URL");
    if (
      !isStrongSigningSecret(env.CORE_SIGNING_SECRET) ||
      !isStrongSigningSecret(env.DEPLOYMENT_CONTROL_SECRET) ||
      env.DEPLOYMENT_CONTROL_SECRET === env.CORE_SIGNING_SECRET
    )
      throw new Error(
        "Background ownership requires a distinct DEPLOYMENT_CONTROL_SECRET of at least 32 characters and CORE_SIGNING_SECRET",
      );
  }
  const deployAppsDomain = deployAppsDomainEnv(env);
  const missingSecrets = validateCoreSecretEnv(env);
  if (missingSecrets.length) {
    const described = missingSecrets.map((name) => {
      const reason = CORE_SECRET_SPECS.find((spec) => spec.name === name)?.reason;
      return reason ? `${name} (${reason})` : name;
    });
    throw new Error(`missing or insecure required core secrets: ${described.join(", ")}`);
  }
  assertDistinctSecrets({
    signing: env.CORE_SIGNING_SECRET || undefined,
    capability: env.CAPABILITY_SECRET || undefined,
    portalIdentity: env.PORTAL_IDENTITY_SECRET || undefined,
    connector: env.CONNECTOR_SECRET_KEY || undefined,
    enforcePortalIdentity: env.NODE_ENV === "production" || env.REQUIRE_SIGNED_PORTAL_IDENTITY === "1",
  });
  const modelProvider = modelProviderEnvStrict(env);
  if (env.DEPLOY_PROVIDER === "porter" && !env.PORTER_DEPLOY_APPS_DOMAIN && !deployAppsDomain) {
    console.warn(
      "[config] DEPLOY_PROVIDER=porter without an apps domain — published apps are reachable signed-in at /d/<app>/ only; set DEPLOY_APPS_DOMAIN to a domain you control to serve each app on its own subdomain.",
    );
  }
  if (env.DEPLOY_PROVIDER === "porter" && !porterLocatorPresent(env)) {
    throw new Error(
      "DEPLOY_PROVIDER=porter requires PORTER_DEPLOY_PROJECT_ID and PORTER_DEPLOY_CLUSTER_ID (or PORTER_SANDBOX_BASE_URL, or PORTER_CLUSTER_ID) to locate the Porter sandbox API.",
    );
  }
  if (env.NODE_ENV === "production" && !env.SANDBOX_BACKEND?.trim()) {
    throw new Error(`SANDBOX_BACKEND must be set explicitly in production — use ${orList(SANDBOX_BACKEND_NAMES)}.`);
  }
  const sandboxBackend = sandboxBackendEnvStrict(env.SANDBOX_BACKEND);
  const selectedBackend = env.SANDBOX_BACKEND?.trim();
  if (selectedBackend && selectedBackend !== "local" && !env.SANDBOX_EGRESS_PROXY_URL?.trim()) {
    console.warn(
      `[config] SANDBOX_BACKEND=${selectedBackend} without SANDBOX_EGRESS_PROXY_URL — sandboxes run with NO egress enforcement (fail-open); set SANDBOX_EGRESS_PROXY_URL to the public egress proxy to force sandbox traffic through it.`,
    );
  }
  return { deployAppsDomain, modelProvider, sandboxBackend };
}

function securityScreenProxyEnv(env: Env): Config["securityScreenProxy"] {
  const proxyProvider = env.SECURITY_SCREEN_PROXY_PROVIDER?.trim();
  const proxyEndpoint = env.SECURITY_SCREEN_PROXY_ENDPOINT?.trim();
  const proxyToken = env.SECURITY_SCREEN_PROXY_TOKEN?.trim();
  const hasProxyScreen = [proxyProvider, proxyEndpoint, proxyToken].some(Boolean);
  if (hasProxyScreen && (!proxyProvider || !proxyEndpoint || !proxyToken)) {
    throw new Error(
      "SECURITY_SCREEN_PROXY_PROVIDER, SECURITY_SCREEN_PROXY_ENDPOINT, and SECURITY_SCREEN_PROXY_TOKEN must be set together",
    );
  }
  if (
    proxyProvider &&
    (proxyProvider.length > DNS_LABEL_MAX_LENGTH || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(proxyProvider))
  ) {
    throw new Error("SECURITY_SCREEN_PROXY_PROVIDER must be a lowercase DNS label");
  }
  if (proxyProvider === "surface" || proxyProvider === "origin") {
    throw new Error("SECURITY_SCREEN_PROXY_PROVIDER must not collide with a security screen metadata field");
  }
  if (proxyEndpoint) {
    try {
      const url = new URL(proxyEndpoint);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.hostname.endsWith("."))
        throw new Error("endpoint");
    } catch {
      throw new Error(
        "SECURITY_SCREEN_PROXY_ENDPOINT must be an HTTPS URL without credentials, a fragment, or a trailing hostname dot",
      );
    }
  }
  return hasProxyScreen ? { provider: proxyProvider!, endpoint: proxyEndpoint!, token: proxyToken! } : undefined;
}

function deployProviderEnv(env: Env): Config["deployProvider"] {
  const deployProvider = env.DEPLOY_PROVIDER ?? "docker";
  if (
    deployProvider !== "aws" &&
    deployProvider !== "docker" &&
    deployProvider !== "porter" &&
    deployProvider !== "e2b"
  ) {
    throw new Error(
      `DEPLOY_PROVIDER=${JSON.stringify(deployProvider)} is not recognized (expected aws, docker, porter, or e2b)`,
    );
  }
  return deployProvider;
}

function loadDeploymentConfig(env: Env): DeploymentConfig {
  const { deployAppsDomain, modelProvider, sandboxBackend } = checkedDeploymentEnv(env);
  const dataDir = resolve(env.DATA_DIR ?? "./data");
  const securityScreenProxy = securityScreenProxyEnv(env);
  const deployProvider = deployProviderEnv(env);
  const modelGateway = modelGatewayFromEnv(env);
  const e = readEnv(env, {
    NODE_ENV: raw,
    QM_MULTITENANT: raw,
    PORT: num,
    PUBLIC_PORT: num,
    POSTHOG_API_KEY: trimmed,
    POSTHOG_HOST: raw,
    DATABASE_URL: str,
    DATABASE_POOL_URL: str,
    DATABASE_POOL_CA_CERT: str,
    DATABASE_POOL_MAX: num,
    DATABASE_DIRECT_POOL_MAX: num,
    DATABASE_CA_CERT: str,
    DATABASE_CA_CERT_FILE: str,
    PI_MODEL: str,
    CODEX_AUTH_CREDENTIAL: trimmed,
    CLAUDE_AUTH_CREDENTIAL: trimmed,
    PI_DETECT_MODEL: str,
    PI_TITLE_MODEL: str,
    PI_JUDGE_MODEL: str,
    ANTHROPIC_API_KEY: str,
    OPENAI_API_KEY: str,
    OPENROUTER_API_KEY: str,
    RESEND_API_KEY: trimmed,
    AUTH_EMAIL_FROM: trimmed,
    BUDGET_USD_PER_WINDOW: num,
    ORG_BUDGET_USD_PER_WINDOW: num,
    BACKGROUND_DEPLOYMENT_ID: str,
    DEPLOYMENT_CONTROL_SECRET: raw,
    SPEND_EXPORT_TOKEN: str,
    GIT_SHA: str,
    CORE_SIGNING_SECRET: str,
    CAPABILITY_SECRET: str,
    PORTAL_IDENTITY_SECRET: str,
    CAPABILITY_TOKEN_COMPRESSION: flag,
    REQUIRE_SIGNED_PORTAL_IDENTITY: raw,
    CONNECTOR_SECRET_KEY: str,
    DEPLOYMENT_LAYER: str,
    S3_BUCKET: str,
    S3_REGION: str,
    CRON_FIRE_CONCURRENCY: num,
    WORKERS: num,
    SHUTDOWN_DRAIN_MS: num,
    REACH_EXEC: flag,
    SUGGESTED_ACTIVITIES_ENABLED: flag,
    SUGGESTED_ACTIVITIES_CONTEXT: str,
  });
  return {
    ...defined({
      suggestedActivitiesContext: e.SUGGESTED_ACTIVITIES_CONTEXT,
      publicPort: e.PUBLIC_PORT,
      productAnalytics: e.POSTHOG_API_KEY ? { apiKey: e.POSTHOG_API_KEY, host: e.POSTHOG_HOST?.trim() } : undefined,
      databaseUrl: e.DATABASE_URL,
      databasePoolUrl: e.DATABASE_POOL_URL,
      databasePoolCaCert: e.DATABASE_POOL_CA_CERT,
      databasePoolMax: e.DATABASE_POOL_MAX,
      databaseDirectPoolMax: e.DATABASE_DIRECT_POOL_MAX,
      databaseCaCert: e.DATABASE_CA_CERT,
      databaseCaCertFile: e.DATABASE_CA_CERT_FILE,
      securityScreenProxy,
      modelId: e.PI_MODEL,
      codexAuthCredential: e.CODEX_AUTH_CREDENTIAL,
      claudeAuthCredential: e.CLAUDE_AUTH_CREDENTIAL,
      detectModelId: e.PI_DETECT_MODEL,
      titleModelId: e.PI_TITLE_MODEL,
      judgeModelId: e.PI_JUDGE_MODEL,
      anthropicApiKey: e.ANTHROPIC_API_KEY,
      openaiApiKey: e.OPENAI_API_KEY,
      openrouterApiKey: e.OPENROUTER_API_KEY,
      modelProvider,
      modelGateway,
      resendApiKey: e.RESEND_API_KEY,
      emailFrom: e.AUTH_EMAIL_FROM,
      budgetUsdPerWindow: e.BUDGET_USD_PER_WINDOW,
      orgBudgetUsdPerWindow: e.ORG_BUDGET_USD_PER_WINDOW,
      spendExportToken: e.SPEND_EXPORT_TOKEN,
      buildSha: e.GIT_SHA,
      signingSecret: e.CORE_SIGNING_SECRET,
      capabilitySecret: e.CAPABILITY_SECRET,
      portalIdentitySecret: e.PORTAL_IDENTITY_SECRET,
      connectorSecretKey: e.CONNECTOR_SECRET_KEY,
      deploymentLayerDir: e.DEPLOYMENT_LAYER ? resolve(e.DEPLOYMENT_LAYER) : undefined,
      s3Bucket: e.S3_BUCKET,
      s3Region: e.S3_REGION,
    }),
    ...(e.BACKGROUND_DEPLOYMENT_ID
      ? { backgroundDeploymentId: e.BACKGROUND_DEPLOYMENT_ID, deploymentControlSecret: e.DEPLOYMENT_CONTROL_SECRET }
      : {}),
    suggestedActivitiesEnabled: e.SUGGESTED_ACTIVITIES_ENABLED ?? true,
    production: e.NODE_ENV === "production",
    multitenant: e.QM_MULTITENANT === "1",
    ...defined({ tenantSecretsKey: tenantSecretsKey(env) }),
    port: e.PORT ?? CONFIG_DEFAULTS.port,
    dataDir,
    sandboxBackend,
    deployProvider,
    turnWallClockMs: CONFIG_DEFAULTS.turnWallClockSec * 1000,
    runWaitMs: RUN_MAX_AGE_MS + 60_000,
    seedSkills: true,
    pluginSkillDirs: defaultPluginSkillDirs(),
    memoryRecall: DEFAULT_MEMORY_POLICY.recall,
    memoryCapture: DEFAULT_MEMORY_POLICY.capture,
    memoryCaptureQuietMs: DEFAULT_CAPTURE_QUIET_MS,
    reaperIntervalMs: CONFIG_DEFAULTS.reaperIntervalMs,
    maxAttempts: CONFIG_DEFAULTS.maxAttempts,
    approvalSummaryTimeoutMs: CONFIG_DEFAULTS.approvalSummaryTimeoutMs,
    turnLeaseWaitMs: CONFIG_DEFAULTS.turnLeaseWaitMs,
    securityScreenTimeoutMs: CONFIG_DEFAULTS.securityScreenTimeoutMs,
    backgroundWorkEnabled: backgroundWorkEnabled(env),
    capabilityTokenCompression: e.CAPABILITY_TOKEN_COMPRESSION ?? false,
    requireSignedPortalIdentity: e.REQUIRE_SIGNED_PORTAL_IDENTITY === "1",
    layerEnv: { ...env },
    deployGitDir: join(dataDir, "deploy-git"),
    cronFireConcurrency: e.CRON_FIRE_CONCURRENCY ?? CONFIG_DEFAULTS.cronFireConcurrency,
    workers: e.WORKERS ?? CONFIG_DEFAULTS.workers,
    shutdownDrainMs: e.SHUTDOWN_DRAIN_MS ?? CONFIG_DEFAULTS.shutdownDrainMs,
    reachExecEnabled: e.REACH_EXEC ?? false,
    sandbox: sandboxEnv(env),
    ...sandboxProvidersEnv(env),
    porterDeploy: porterDeployEnv(env),
    awsDeploy: awsDeployEnv(env, env.DEPLOY_APPS_DOMAIN?.trim() ? deployAppsDomain : undefined),
  };
}

function loadTenantConfig(env: Env): TenantConfig {
  const publicApiUrl = env.PUBLIC_API_URL?.replace(/\/+$/, "");
  const publicWebUrl = env.PUBLIC_WEB_URL?.replace(/\/+$/, "");
  const publicUrl = publicWebUrl || publicApiUrl;
  const deployAppsDomain = deployAppsDomainEnv(env);
  const brokerCredentials = deploymentBrokerCredentialsFromEnv(env);
  const slack = slackPluginConfigFromEnv(env);
  const externalSlackPolicies = Object.fromEntries(
    [...(slack ? [slack] : []), ...slackAccountConfigsFromEnv(env)]
      .filter((account) => account.externalAccess)
      .map((account) => [account.accountId ?? "default", account.externalAccess!]),
  );
  const brandingDefault = orgBrandingFromEnv(env);
  return {
    orgId: env.ORG_ID ?? DEFAULT_ORG_ID,
    ...(brandingDefault ? { brandingDefault } : {}),
    ...(brokerCredentials.length ? { brokerCredentials } : {}),
    ...(env.TRUSTED_OIDC_ADMIN_ISSUER ? { trustedOidcAdminIssuer: env.TRUSTED_OIDC_ADMIN_ISSUER } : {}),
    ...(env.ADMIN_GRANTS ? { adminGrants: env.ADMIN_GRANTS } : {}),
    ...(env.AUTH_ALLOWED_EMAILS
      ? {
          emailAuthPrincipals: [
            ...new Set(
              env.AUTH_ALLOWED_EMAILS.split(",")
                .map((email) => email.trim().toLowerCase())
                .filter(Boolean),
            ),
          ],
        }
      : {}),
    ...(env.AUTH_ALLOWED_EMAIL_DOMAIN?.trim()
      ? { emailAuthDomain: env.AUTH_ALLOWED_EMAIL_DOMAIN.trim().toLowerCase() }
      : {}),
    ...(publicApiUrl ? { apiBaseUrl: publicApiUrl } : {}),
    ...(publicUrl ? { publicUrl } : {}),
    ...(publicWebUrl ? { publicWebUrl } : {}),
    ...(slack ? { slack } : {}),
    externalSlackPolicies,
    chatSurfaces: httpChatConfigsFromEnv(env),
    ...(env.S3_PREFIX ? { s3Prefix: env.S3_PREFIX } : {}),
    ...deployAppsEnv(env, publicUrl),
    ...(deployAppsDomain ? { deployAppsDomain } : {}),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return { ...loadDeploymentConfig(env), ...loadTenantConfig(env) };
}
