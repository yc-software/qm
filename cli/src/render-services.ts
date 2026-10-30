import { securityScreenEnv, type QmConfig, type RenderConfig } from "./config.ts";
import { CliError } from "./log.ts";
import { discoverPlugins, type ResolvedPlugin } from "./plugins.ts";
import type { ServiceType } from "./render-api.ts";
import { computedSecrets, runtimeSecretNames } from "./secrets.ts";
import {
  coreWorkloadEnv,
  hostedServiceEnv,
  hostsWebEdge,
  isCoreWorkload,
  ordered,
  orgEnv,
  PUBLIC_PORT,
  runnableServices,
} from "./services.ts";

const RENDER_API_PORT = "8080";

export const renderComponent = (workload: string): string => (workload === "edge" ? "core" : workload);

export function renderWorkloads(
  config: QmConfig,
  configDir: string,
): Array<RenderBuild & { name: string; workload: string; command?: string; plugin?: ResolvedPlugin }> {
  const discovered = discoverPlugins(configDir, config);
  if (discovered.errors.length) throw new CliError(discovered.errors.join("\n"));
  const source = config.render?.source;
  if (!source) throw new CliError("Render requires a render config block");
  const build = (dockerfile: string): RenderBuild => ({ source, dockerfile });
  return [
    ...ordered(runnableServices(config.services)).map((service) => ({
      name: renderComponent(service.name),
      workload: service.name,
      ...build(`deploy/${service.docker.image}/Dockerfile`),
      ...(isCoreWorkload(service.name) ? { command: `node src/render/start.ts ${service.name}` } : {}),
    })),
    ...discovered.plugins.map((plugin) => ({
      name: plugin.name,
      workload: plugin.name,
      ...build(`plugins/${plugin.name}/Dockerfile`),
      plugin,
    })),
  ];
}

interface RenderBuild {
  source: NonNullable<QmConfig["render"]>["source"];
  dockerfile: string;
}

export type RenderWorkload = RenderBuild & {
  name: string;
  workload: string;
  type: ServiceType;
  plan: string;
  plugin?: ResolvedPlugin;
  command?: string;
  health?: string;
  diskSizeGB?: number;
};

export function renderManagedCoreEnv(render: RenderConfig): Record<string, string> {
  return {
    DATA_DIR: "/data",
    WORKSPACE_STORE: "postgres",
    SNAPSHOT_STORE: "s3",
    TRANSFER_STORE: "s3",
    SANDBOX_BACKEND: "render",
    DEPLOY_PROVIDER: "render",
    RENDER_WORKSPACE_ID: render.workspaceId,
    RENDER_REGION: render.region,
    RENDER_APP_REGION: render.appRegion ?? render.region,
  };
}

export function renderStorageEnv(storage?: { endpoint: string; secretKey: string }): Record<string, string> {
  return {
    S3_BUCKET: "qm-storage",
    S3_REGION: "us-east-1",
    AWS_ENDPOINT_URL_S3: storage?.endpoint ?? "",
    AWS_ACCESS_KEY_ID: "qm-storage",
    AWS_SECRET_ACCESS_KEY: storage?.secretKey ?? "",
    AWS_SESSION_TOKEN: "",
  };
}

export function renderServiceEnv(
  config: QmConfig,
  workload: string,
  values: ReadonlyMap<string, string>,
  connections: {
    databaseUrl: string;
    coreUrl: string;
    projectId?: string;
    environmentId?: string;
    minioServiceId?: string;
    commit?: string;
    storage?: { endpoint: string; secretKey: string };
  },
  plugin?: ResolvedPlugin,
): Record<string, string> {
  const render = config.render;
  if (!render) throw new CliError("Render requires a render config block");
  const coreAccess = (plugin ?? config.plugins.find((item) => item.name === workload))?.coreAccess !== false;
  const frontDoor = workload === "edge" && hostsWebEdge(config.services);
  const out: Record<string, string> = {
    ...hostedServiceEnv(config.services, config.env, workload),
    ...plugin?.env,
    ...(isCoreWorkload(workload)
      ? coreWorkloadEnv(config, workload)
      : orgEnv(workload, config.orgId, config.publicUrl, hostsWebEdge(config.services))),
    PORT: frontDoor ? String(PUBLIC_PORT) : RENDER_API_PORT,
    ...(frontDoor ? { RENDER_API_PORT } : {}),
    ...(coreAccess ? { CORE_API_URL: connections.coreUrl } : {}),
  };
  const managedValues: Record<string, string> = {
    ...(coreAccess ? { DATABASE_URL: connections.databaseUrl } : {}),
    PUBLIC_API_URL: config.apiUrl ?? config.publicUrl,
  };
  for (const secret of computedSecrets(config)) {
    const value = secret.managedBy === "render" ? managedValues[secret.name] : values.get(secret.name);
    if (value === undefined || secret.managedBy === "terraform") continue;
    for (const name of runtimeSecretNames(
      workload,
      secret,
      config.plugins.filter((item) => item.coreAccess !== false).map((item) => item.name),
    ))
      out[name] = value;
  }
  if (!isCoreWorkload(workload)) return out;
  Object.assign(out, {
    ...securityScreenEnv(config),
    ...renderManagedCoreEnv(render),
    ...managedValues,
    ...(connections.projectId ? { RENDER_PROJECT_ID: connections.projectId } : {}),
    ...(connections.minioServiceId ? { RENDER_MINIO_SERVICE_ID: connections.minioServiceId } : {}),
    ...(connections.environmentId ? { RENDER_ENVIRONMENT_ID: connections.environmentId } : {}),
    RENDER_DEPLOY_REPO: render.source.repo,
    RENDER_DEPLOY_BRANCH: render.source.branch,
    ...(connections.commit ? { GIT_SHA: connections.commit } : {}),
    ...(config.model ? { PI_MODEL: config.model } : {}),
    ...(config.modelProvider ? { MODEL_PROVIDER: config.modelProvider } : {}),
    ...renderStorageEnv(connections.storage),
  });
  out.AUTH_ALLOWED_EMAIL_DOMAIN =
    (config.services.includes("auth") ? config.env.auth?.AUTH_ALLOWED_EMAIL_DOMAIN : undefined) ??
    config.env.core?.AUTH_ALLOWED_EMAIL_DOMAIN ??
    "";
  if (workload !== "edge") return out;
  if (!config.services.includes("slack")) {
    for (const key of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_SIGNING_SECRET"]) out[key] = "";
  }
  if (frontDoor && !config.services.includes("auth")) {
    out.AUTH_EMBEDDED = "0";
    for (const [key, value] of Object.entries({
      AUTH_BROKER_UPSTREAM: "",
      OIDC_AUTH_ENDPOINT: "https://slack.com/openid/connect/authorize",
      OIDC_TOKEN_ENDPOINT: "https://slack.com/api/openid.connect.token",
      OIDC_USERINFO_ENDPOINT: "https://slack.com/api/openid.connect.userInfo",
      OIDC_ISSUER: "https://slack.com",
      OIDC_JWKS_URI: "https://slack.com/openid/connect/keys",
      OIDC_SCOPES: "openid profile email",
      OIDC_PRINCIPAL_CLAIM: "email",
      OIDC_ALLOWED_EMAIL_DOMAIN: "",
    }))
      out[key] = config.env.portal?.[key] ?? value;
  }
  return out;
}
