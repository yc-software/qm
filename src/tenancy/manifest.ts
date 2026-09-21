import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { loadConfig, type Config } from "../config.ts";
import { isStrongSigningSecret } from "../auth/source-auth.ts";
import { parseFlyWireguardPeers } from "../deploy/fly-tunnel-manager.ts";
import { slackAccountConfigsFromEnv } from "../slack/config.ts";
import { hashId } from "../util/crypto.ts";
import { createTenantContext, runWithTenant, type TenantContext } from "./context.ts";

export interface TenantDefinition {
  context: TenantContext;
  config: Config;
  hosts: readonly string[];
}

export interface HostConfig {
  pooled: boolean;
  port: number;
  concurrency: number;
  tenants: readonly TenantDefinition[];
}

const PLATFORM_ENV = [
  "PATH",
  "NODE_ENV",
  "ECS_AGENT_URI",
  "ECS_CONTAINER_METADATA_URI_V4",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "GIT_SHA",
] as const;

const NAME_PREFIXES = [
  "SPRITES_NAME_PREFIX",
  "SMOLMACHINES_NAME_PREFIX",
  "E2B_NAME_PREFIX",
  "MODAL_NAME_PREFIX",
  "PORTER_SANDBOX_NAME_PREFIX",
  "AGENT37_NAME_PREFIX",
  "SUPERSERVE_NAME_PREFIX",
  "FLY_DEPLOY_APP_PREFIX",
] as const;

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const TENANT_SECRETS = [
  "CORE_SIGNING_SECRET",
  "CAPABILITY_SECRET",
  "PORTAL_IDENTITY_SECRET",
  "CONNECTOR_SECRET_KEY",
] as const;

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function integer(value: string | undefined, fallback: number, name: string, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > max) throw new Error(`${name} must be between 1 and ${max}`);
  return result;
}

export function tenantHost(value: string): string {
  const host = value.toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::[0-9]+)?$/.test(host))
    throw new Error(`Invalid tenant host: ${value}`);
  return host;
}

function databaseTarget(raw: string): string {
  const url = new URL(raw);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.pathname === "/" || !url.pathname)
    throw new Error("Every tenant needs an explicit PostgreSQL database name");
  if (!url.hostname || !url.username || url.hostname.includes("%"))
    throw new Error("Tenant database URLs require an explicit host and user");
  if (["host", "port", "user", "password", "database", "dbname"].some((key) => url.searchParams.has(key)))
    throw new Error("Tenant database URLs must specify their host and database in the URL authority and path");
  return `${url.hostname.toLowerCase().replace(/\.$/, "")}:${url.port || "5432"}/${decodeURIComponent(url.pathname.slice(1))}`;
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return !path || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function validateIsolation(tenants: readonly TenantDefinition[]): void {
  const hosts = new Set<string>();
  const databases = new Map<string, string>();
  const secrets = new Map<string, string>();
  const namespaces = new Map<string, string>();
  const paths: { id: string; path: string }[] = [];
  const storage: { id: string; bucket: string; prefix: string }[] = [];
  const secretPrefixes: { id: string; prefix: string }[] = [];
  const peers = new Map<string, string>();
  const slackTokens = new Map<string, string>();
  const appsDomains: { id: string; domain: string }[] = [];
  for (const tenant of tenants) {
    const { id, env } = tenant.context;
    const { config } = tenant;
    const slackAccounts = [
      { botToken: env.SLACK_BOT_TOKEN, appToken: env.SLACK_APP_TOKEN },
      ...slackAccountConfigsFromEnv(env),
    ];
    for (const account of slackAccounts) {
      for (const [key, token] of [
        ["SLACK_BOT_TOKEN", account.botToken],
        ["SLACK_APP_TOKEN", account.appToken],
      ] as const) {
        if (!token?.trim()) continue;
        const owner = slackTokens.get(token.trim());
        if (owner && owner !== id) throw new Error(`${id}: ${key} must be unique across tenants (${owner})`);
        slackTokens.set(token.trim(), id);
      }
    }
    if (config.secretsBackend === "aws") {
      for (const other of secretPrefixes)
        if (config.secretsPrefix.startsWith(other.prefix) || other.prefix.startsWith(config.secretsPrefix))
          throw new Error(`Tenant secret prefixes overlap: ${id} and ${other.id}`);
      secretPrefixes.push({ id, prefix: config.secretsPrefix });
    }
    if (config.flyDeploy.wireguardPeers) {
      for (const peer of parseFlyWireguardPeers(config.flyDeploy.wireguardPeers)) {
        const owner = peers.get(peer.id);
        if (owner) throw new Error(`Fly WireGuard peer identities must be unique across tenants: ${id} and ${owner}`);
        peers.set(peer.id, id);
      }
    }
    if (config.deployAppsDomain) {
      const domain = config.deployAppsDomain.toLowerCase();
      for (const other of appsDomains)
        if (domain === other.domain || domain.endsWith(`.${other.domain}`) || other.domain.endsWith(`.${domain}`))
          throw new Error(`Tenant app domains overlap: ${id} and ${other.id}`);
      appsDomains.push({ id, domain });
    }
    for (const host of tenant.hosts) {
      if (hosts.has(host)) throw new Error(`Tenant host is assigned more than once: ${host}`);
      hosts.add(host);
    }
    for (const url of [config.databaseUrl, config.databasePoolUrl]) {
      if (!url) continue;
      const db = databaseTarget(url);
      const owner = databases.get(db);
      if (owner && owner !== id) throw new Error(`Tenants ${owner} and ${id} must use separate databases`);
      databases.set(db, id);
    }
    for (const key of TENANT_SECRETS) {
      const secret = env[key]!;
      const owner = secrets.get(secret);
      if (owner)
        throw new Error(`${id}: ${key} must be distinct from every other tenant signing/encryption key (${owner})`);
      secrets.set(secret, `${id}/${key}`);
    }
    for (const path of [config.dataDir, config.deployGitDir]) {
      for (const other of paths)
        if (other.id !== id && (containsPath(path, other.path) || containsPath(other.path, path)))
          throw new Error(`Tenant data directories overlap: ${id} and ${other.id}`);
      paths.push({ id, path });
    }
    for (const key of [...NAME_PREFIXES, "FLY_DEPLOY_SHARED_APP_NAME"] as const) {
      const value = env[key];
      if (!value) continue;
      const name = `${key}:${value}`;
      if (namespaces.has(name)) throw new Error(`${key} must be unique per tenant: ${id} and ${namespaces.get(name)}`);
      namespaces.set(name, id);
    }
    for (const [bucket, prefix] of [
      [config.s3Bucket, config.s3Prefix],
      [config.awsSandbox.s3Bucket, config.awsSandbox.s3Prefix],
      [config.awsDeploy.dataBucket ?? config.awsSandbox.s3Bucket, config.awsDeploy.dataPrefix],
      [config.e2bSandbox.snapshotS3Bucket, `${config.s3Prefix}e2b-home/`],
      [config.modalSandbox.snapshotS3Bucket, `${config.s3Prefix}modal-home/`],
    ]) {
      if (!bucket) continue;
      if (!prefix) throw new Error(`${id}: shared object storage requires an explicit tenant prefix`);
      const normalized = `${prefix.replace(/\/+$/, "")}/`;
      for (const other of storage)
        if (
          other.id !== id &&
          other.bucket === bucket &&
          (normalized.startsWith(other.prefix) || other.prefix.startsWith(normalized))
        )
          throw new Error(`Tenant object storage prefixes overlap: ${id} and ${other.id}`);
      storage.push({ id, bucket, prefix: normalized });
    }
  }
  for (const tenant of tenants)
    for (const host of tenant.hosts)
      for (const apps of appsDomains)
        if (apps.id !== tenant.context.id && host.split(":")[0]!.endsWith(`.${apps.domain}`))
          throw new Error(`Tenant host overlaps another tenant's app domain: ${host}`);
}

export function loadHostConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
  if (!env.QM_TENANTS_FILE) {
    const context = createTenantContext({ id: env.ORG_ID ?? "default-org", env });
    const config = runWithTenant(context, () => loadConfig(context.env));
    return {
      pooled: false,
      port: config.port,
      concurrency: integer(env.WORKERS, config.workers, "WORKERS", 1024),
      tenants: [{ context, config, hosts: [] }],
    };
  }
  const file = resolve(env.QM_TENANTS_FILE);
  const manifest = object(JSON.parse(readFileSync(file, "utf8")), "Tenant manifest");
  if (!Array.isArray(manifest.tenants) || !manifest.tenants.length)
    throw new Error("Tenant manifest needs a nonempty tenants array");
  const ids = new Set<string>();
  const tenants = manifest.tenants.map((entry, index): TenantDefinition => {
    const raw = object(entry, `tenants[${index}]`);
    if (typeof raw.id !== "string" || raw.id.length > 48 || !SLUG_PATTERN.test(raw.id))
      throw new Error("Tenant id must be a lowercase slug of at most 48 characters");
    if (ids.has(raw.id)) throw new Error(`Duplicate tenant id: ${raw.id}`);
    ids.add(raw.id);
    if (typeof raw.envFile !== "string" || !raw.envFile) throw new Error(`${raw.id}: envFile is required`);
    if (!Array.isArray(raw.hosts) || !raw.hosts.length || raw.hosts.some((host) => typeof host !== "string"))
      throw new Error(`${raw.id}: hosts must be a nonempty array of DNS names`);
    const values = parseEnv(readFileSync(resolve(dirname(file), raw.envFile), "utf8"));
    for (const key of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "AWS_SHARED_CREDENTIALS_FILE",
      "AWS_CONFIG_FILE",
    ])
      if (values[key]) throw new Error(`${raw.id}: ${key} cannot override the shared host's AWS identity`);
    if (values.ORG_ID && values.ORG_ID !== raw.id) throw new Error(`${raw.id}: ORG_ID must match the manifest id`);
    const tenantEnv: NodeJS.ProcessEnv = {
      ...values,
      ...Object.fromEntries(PLATFORM_ENV.filter((key) => env[key] !== undefined).map((key) => [key, env[key]])),
      ORG_ID: raw.id,
      CORE_TENANT_ID: raw.id,
      PORT: env.PORT ?? "8080",
      DATA_DIR: resolve(values.DATA_DIR ?? resolve(env.DATA_DIR ?? "./data", raw.id)),
      SESSION_STORE: "postgres",
      RUN_STORE: "postgres",
      DATABASE_POOL_MAX: values.DATABASE_POOL_MAX ?? "4",
      DATABASE_DIRECT_POOL_MAX: values.DATABASE_DIRECT_POOL_MAX ?? "8",
      WORKERS: String(integer(values.WORKERS, 2, `${raw.id}: WORKERS`, 1024)),
      REQUIRE_SIGNED_PORTAL_IDENTITY: "1",
    };
    if (!tenantEnv.DATABASE_URL) throw new Error(`${raw.id}: DATABASE_URL is required`);
    for (const key of ["DATABASE_URL", "DATABASE_POOL_URL"]) {
      const value = tenantEnv[key];
      if (!value) continue;
      databaseTarget(value);
      const url = new URL(value);
      url.port ||= "5432";
      tenantEnv[key] = url.toString();
    }
    if (values.ALLOW_UNAUTHENTICATED_CORE && values.ALLOW_UNAUTHENTICATED_CORE !== "0")
      throw new Error(`${raw.id}: pooled core requires authenticated ingress`);
    for (const key of TENANT_SECRETS)
      if (!isStrongSigningSecret(tenantEnv[key]))
        throw new Error(`${raw.id}: ${key} must contain at least 32 characters`);
    if (
      tenantEnv.HARNESS === "codex" &&
      !tenantEnv.CODEX_AUTH_CREDENTIAL &&
      !tenantEnv.CODEX_AUTH_FILE &&
      !tenantEnv.OPENAI_API_KEY
    )
      throw new Error(`${raw.id}: Codex authentication must be explicitly configured per tenant`);
    tenantEnv.S3_PREFIX ??= `tenants/${raw.id}/`;
    if (!tenantEnv.S3_PREFIX.endsWith("/")) tenantEnv.S3_PREFIX += "/";
    tenantEnv.AWS_SANDBOX_S3_PREFIX ??= `${tenantEnv.S3_PREFIX}sandbox-home`;
    tenantEnv.AWS_DEPLOY_DATA_PREFIX ??= `${tenantEnv.S3_PREFIX}deploy-data`;
    for (const key of NAME_PREFIXES) {
      const value = tenantEnv[key];
      if (value !== undefined && !value.trim()) throw new Error(`${raw.id}: ${key} must not be empty`);
      let defaultPrefix = `qm-${raw.id}`;
      if (key === "FLY_DEPLOY_APP_PREFIX" && defaultPrefix.length > 26)
        defaultPrefix = `qm-${raw.id.slice(0, 12)}-${hashId([raw.id], 10)}`;
      const prefix = value?.trim() ?? defaultPrefix;
      if (!SLUG_PATTERN.test(prefix))
        throw new Error(`${raw.id}: ${key} must be a lowercase slug with alphanumeric ends`);
      if (key === "FLY_DEPLOY_APP_PREFIX" && prefix.length > 26)
        throw new Error(`${raw.id}: FLY_DEPLOY_APP_PREFIX must be no longer than 26 characters`);
      tenantEnv[key] = prefix;
    }
    const context = createTenantContext({ id: raw.id, env: tenantEnv, pooled: true });
    const config = runWithTenant(context, () => loadConfig(context.env));
    return { context, config, hosts: raw.hosts.map((host) => tenantHost(host as string)) };
  });
  validateIsolation(tenants);
  return {
    pooled: true,
    port: integer(env.PORT, 8080, "PORT", 65535),
    concurrency: integer(env.QM_WORKER_CONCURRENCY, 16, "QM_WORKER_CONCURRENCY", 1024),
    tenants,
  };
}
