import { createServer as createNetServer, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Worker } from "node:worker_threads";
import { errMessage } from "./errors.ts";
import { createHostFront, proxyTarget, type HostRoute, type HostTarget } from "./tenant-hosts.ts";
import {
  deriveTenantSecret,
  homeHosts,
  homeTenantSettings,
  TENANT_COLUMNS,
  tenantFromRow,
  tenantSecretsKey,
  type TenantSettings,
} from "./tenant-settings.ts";

export type TenantService = "core" | "portal" | "web-ui";

interface TenantRegistrySnapshot {
  homeId: string;
  tenants: TenantSettings[];
}

type Env = Record<string, string | undefined>;

export function multitenant(env: Env): boolean {
  return env.QM_MULTITENANT === "1";
}

interface PgClient {
  connect(): Promise<void>;
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  end(): Promise<void>;
}

async function readTenantRegistry(env: Env): Promise<TenantRegistrySnapshot> {
  if (!env.DATABASE_URL) throw new Error("QM_MULTITENANT=1 needs DATABASE_URL to read the tenant registry");
  const pgModule = "pg";
  const { default: pg } = (await import(pgModule)) as {
    default: { Client: new (config: { connectionString: string }) => PgClient };
  };
  const client = new pg.Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const key = tenantSecretsKey(env);
    const home = await client.query<{ id: string }>("SELECT id::text AS id FROM qm_tenant LIMIT 1");
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT ${TENANT_COLUMNS} FROM tenants WHERE status = 'active' ORDER BY created_at`,
    );
    return { homeId: home.rows[0]?.id ?? "", tenants: rows.map((row) => tenantFromRow(row, key)) };
  } finally {
    await client.end();
  }
}

const DERIVED_SECRETS = [
  "CORE_SIGNING_SECRET",
  "CAPABILITY_SECRET",
  "PORTAL_IDENTITY_SECRET",
  "PORTAL_SESSION_SECRET",
  "AUTH_TOKEN_SECRET",
];

const EMBEDDED_AUTH_SECRETS = ["AUTH_CLIENT_SECRET", "OIDC_CLIENT_SECRET"];

const PUBLIC_URLS = [
  "PUBLIC_WEB_URL",
  "PUBLIC_API_URL",
  "WEB_UI_PUBLIC_URL",
  "PORTAL_PUBLIC_URL",
  "AWS_PUBLIC_ORIGIN_URL",
];

const HOST_URLS = [
  "AGENT_API_URL",
  "DEPLOY_APPS_LOGIN_URL",
  "AUTH_ISSUER",
  "AUTH_REDIRECT_URI",
  "OIDC_ISSUER",
  "OIDC_AUTH_ENDPOINT",
  "OIDC_TOKEN_ENDPOINT",
  "OIDC_USERINFO_ENDPOINT",
  "OIDC_JWKS_URI",
];

const HOME_ONLY = [
  "ADMIN_GRANTS",
  "QM_SLACK_SERVICE_TOKEN",
  "QM_SLACK_SERVICE_URL",
  "SENTRY_DEPLOYMENT",
  "PORTAL_APPS_DOMAIN",
  "DEPLOY_APPS_DOMAIN",
  "S3_PREFIX",
  "PORTAL_API_ALLOWED_ORIGINS",
  "PORTAL_TRUSTED_OIDC",
  "PORTAL_TRUSTED_OIDC_CLIENT_SECRET",
  "PORTAL_TRUSTED_OIDC_LABEL",
  "PORTAL_TRUSTED_OIDC_ADMIN",
];

function hostUrls(base: Env, url: string): Env {
  const origins = homeHosts(base).map((host) => `https://${host}`);
  const rebased: Env = Object.fromEntries(PUBLIC_URLS.map((name) => [name, url]));
  for (const name of HOST_URLS) {
    const value = base[name];
    const origin = value && origins.find((o) => value === o || value.startsWith(`${o}/`));
    if (origin) rebased[name] = url + value.slice(origin.length);
  }
  return rebased;
}

function trustedOidc(base: Env, tenant: TenantSettings): Env {
  if (!tenant.oidcClientId) return {};
  const shared = base.PORTAL_TRUSTED_OIDC?.trim() ? (JSON.parse(base.PORTAL_TRUSTED_OIDC) as object) : {};
  return {
    PORTAL_TRUSTED_OIDC: JSON.stringify({ ...shared, clientId: tenant.oidcClientId }),
    PORTAL_TRUSTED_OIDC_CLIENT_SECRET: tenant.secrets.oidcClientSecret,
    PORTAL_TRUSTED_OIDC_LABEL: tenant.oidcLabel,
    PORTAL_TRUSTED_OIDC_ADMIN: tenant.oidcAdmin ? "1" : undefined,
  };
}

function derivedSecrets(base: Env, tenantId: string): Env {
  const names = base.AUTH_EMBEDDED === "1" ? [...DERIVED_SECRETS, ...EMBEDDED_AUTH_SECRETS] : DERIVED_SECRETS;
  return Object.fromEntries(
    names.filter((name) => base[name]).map((name) => [name, deriveTenantSecret(base[name]!, tenantId)]),
  );
}

function registeredTenantEnv(base: Env, tenant: TenantSettings & { id: string }): Env {
  const env: Env = { ...base };
  for (const name of HOME_ONLY) delete env[name];
  const favicon = tenant.faviconSvg;
  const own = tenant.secrets;
  return Object.assign(
    env,
    tenant.hosts[0] ? hostUrls(base, `https://${tenant.hosts[0]}`) : {},
    derivedSecrets(base, tenant.id),
    trustedOidc(base, tenant),
    {
      ORG_ID: tenant.orgId,
      S3_BUCKET: tenant.s3Bucket ?? base.S3_BUCKET,
      S3_PREFIX: tenant.s3Bucket ? undefined : `tenants/${tenant.slug}/`,
      SANDBOX_NAME_PREFIX: tenant.sandboxNamePrefix ?? `qm-${tenant.slug}`,
      MODAL_APP_NAME: tenant.modalAppName ?? base.MODAL_APP_NAME,
      MODAL_ENVIRONMENT: tenant.modalEnvironment ?? base.MODAL_ENVIRONMENT,
      MODAL_SNAPSHOT_S3_BUCKET: tenant.modalSnapshotBucket ?? base.MODAL_SNAPSHOT_S3_BUCKET,
      AWS_SANDBOX_S3_BUCKET: tenant.awsSandboxBucket ?? base.AWS_SANDBOX_S3_BUCKET,
      SENTRY_DEPLOYMENT: tenant.sentryDeployment,
      WEB_UI_FAVICON_SVG: favicon ?? base.WEB_UI_FAVICON_SVG,
      PORTAL_FAVICON_SVG: favicon ?? base.PORTAL_FAVICON_SVG,
      AUTH_FAVICON_SVG: favicon ?? base.AUTH_FAVICON_SVG,
      PORTAL_APPS_DOMAIN: tenant.appsDomain,
      DEPLOY_APPS_DOMAIN: tenant.appsDomain,
      MODEL_GATEWAY_API_KEY: own.modelGatewayApiKey ?? base.MODEL_GATEWAY_API_KEY,
      QM_SLACK_SERVICE_TOKEN: own.slackServiceToken,
      QM_SLACK_SERVICE_URL: own.slackServiceToken ? base.QM_SLACK_SERVICE_URL : undefined,
      ADMIN_GRANTS: own.adminGrants,
      CONNECTOR_SECRET_KEY: own.connectorSecretKey ?? base.CONNECTOR_SECRET_KEY,
    },
  );
}

export function tenantServiceEnv(base: Env, tenant: TenantSettings, service: TenantService): Record<string, string> {
  const merged: Env = tenant.id ? registeredTenantEnv(base, { ...tenant, id: tenant.id }) : { ...base };
  if (service !== "core") {
    merged.CORE_ORG_ID = tenant.orgId;
    if (tenant.hosts[0]) merged.CORE_TENANT_HOST = tenant.hosts[0];
  }
  return Object.fromEntries(
    Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function appsDomainOf(env: Env): string | undefined {
  return env.PORTAL_APPS_DOMAIN || env.DEPLOY_APPS_DOMAIN || undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export async function relocateEmbeddedAuth(env: Record<string, string>): Promise<Record<string, string>> {
  const current = env.AUTH_BROKER_UPSTREAM?.replace(/\/$/, "");
  if (env.AUTH_EMBEDDED !== "1" || !current) return env;
  const next = `http://127.0.0.1:${await freePort()}`;
  return Object.fromEntries(
    Object.entries(env).map(([name, value]) => [
      name,
      value.startsWith(current) ? next + value.slice(current.length) : value,
    ]),
  );
}

export interface TenantWorker {
  port: number;
  stop(): Promise<number>;
}

export function startTenantWorker(entry: URL, env: Record<string, string>): Promise<TenantWorker> {
  const worker = new Worker(new URL("./tenant-worker.ts", import.meta.url), {
    env,
    workerData: { entry: entry.href },
  });
  return new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("message", (port: number) => {
      worker.off("error", reject);
      worker.on("error", (error) => console.error(`[tenant] worker for ${entry.pathname} failed:`, errMessage(error)));
      resolve({ port, stop: () => worker.terminate() });
    });
  });
}

interface TenantFront {
  server: Server;
  workers: TenantWorker[];
}

export async function serveTenantsByHost(opts: {
  entry: URL;
  service: Exclude<TenantService, "core">;
  port: number;
  env: Env;
}): Promise<TenantFront> {
  const registry = await readTenantRegistry(opts.env);
  const home = homeTenantSettings(opts.env, { orgId: opts.env.CORE_ORG_ID ?? "" });
  const workers: TenantWorker[] = [];
  const routes: HostRoute<HostTarget>[] = [];
  let homeTarget: HostTarget | undefined;
  for (const tenant of [home, ...registry.tenants.filter((t) => t.id !== registry.homeId)]) {
    const serviceEnv = tenantServiceEnv(opts.env, tenant, opts.service);
    const env = tenant === home ? serviceEnv : await relocateEmbeddedAuth(serviceEnv);
    const worker = await startTenantWorker(opts.entry, env);
    workers.push(worker);
    const target = proxyTarget(worker.port);
    if (tenant === home) homeTarget = target;
    const appsDomain = appsDomainOf(env);
    routes.push({ hosts: tenant.hosts, ...(appsDomain ? { appsDomain } : {}), target });
  }
  const server = createHostFront(
    () => routes,
    () => homeTarget,
  );
  await new Promise<void>((resolve) => server.listen(opts.port, resolve));
  console.log(
    `[${opts.service}] multitenant front on :${(server.address() as AddressInfo).port} for ${routes.length} tenant(s)`,
  );
  return { server, workers };
}
