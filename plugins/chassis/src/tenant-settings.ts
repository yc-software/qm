import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { hostOfUrl } from "./tenant-hosts.ts";

export interface TenantSecrets {
  oidcClientSecret?: string;
  modelGatewayApiKey?: string;
  slackServiceToken?: string;
  adminGrants?: string;
  connectorSecretKey?: string;
}

export interface TenantSettings {
  id?: string;
  slug: string;
  orgId: string;
  hosts: string[];
  status: "active" | "suspended";
  appsDomain?: string;
  s3Bucket?: string;
  sandboxNamePrefix?: string;
  modalAppName?: string;
  modalEnvironment?: string;
  modalSnapshotBucket?: string;
  awsSandboxBucket?: string;
  sentryDeployment?: string;
  faviconSvg?: string;
  oidcClientId?: string;
  oidcLabel?: string;
  oidcAdmin: boolean;
  secrets: TenantSecrets;
}

type Env = Record<string, string | undefined>;

export const TENANT_SECRET_NAMES = [
  "oidcClientSecret",
  "modelGatewayApiKey",
  "slackServiceToken",
  "adminGrants",
  "connectorSecretKey",
] as const satisfies readonly (keyof TenantSecrets)[];

export const TENANT_TEXT_SETTINGS = [
  ["appsDomain", "apps_domain"],
  ["s3Bucket", "s3_bucket"],
  ["sandboxNamePrefix", "sandbox_name_prefix"],
  ["modalAppName", "modal_app_name"],
  ["modalEnvironment", "modal_environment"],
  ["modalSnapshotBucket", "modal_snapshot_bucket"],
  ["awsSandboxBucket", "aws_sandbox_bucket"],
  ["sentryDeployment", "sentry_deployment"],
  ["faviconSvg", "favicon_svg"],
  ["oidcClientId", "oidc_client_id"],
  ["oidcLabel", "oidc_label"],
] as const satisfies readonly (readonly [keyof TenantSettings, string])[];

export const TENANT_COLUMNS = [
  "id::text AS id, slug, org_id, hosts, status, oidc_admin, secrets",
  ...TENANT_TEXT_SETTINGS.map(([, column]) => column),
].join(", ");

export function tenantSecretsKey(env: Env): Buffer | undefined {
  const raw = env.QM_TENANT_SECRETS_KEY?.trim();
  if (!raw) return undefined;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("QM_TENANT_SECRETS_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function deriveTenantSecret(shared: string, tenantId: string): string {
  return Buffer.from(hkdfSync("sha256", shared, tenantId, "qm-tenant", 32)).toString("hex");
}

export function sealTenantSecret(value: unknown, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
}

export function openTenantSecret(sealed: Buffer, key: Buffer | undefined, slug: string): unknown {
  if (!key) throw new Error(`tenant ${slug} has secrets but QM_TENANT_SECRETS_KEY is unset`);
  if (sealed[0] !== 1) throw new Error(`tenant ${slug}: unknown secrets format`);
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(1, 13));
  decipher.setAuthTag(sealed.subarray(13, 29));
  const plain = Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

function onlySecrets(value: unknown): TenantSecrets {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const secrets: TenantSecrets = {};
  for (const name of TENANT_SECRET_NAMES) {
    const secret = source[name];
    if (typeof secret === "string" && secret) secrets[name] = secret;
  }
  return secrets;
}

export function sealTenantSecrets(secrets: TenantSecrets, key: Buffer | undefined): Buffer | null {
  if (!Object.values(secrets).some(Boolean)) return null;
  if (!key) throw new Error("QM_TENANT_SECRETS_KEY is required to store tenant secrets");
  return sealTenantSecret(secrets, key);
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

export function tenantFromRow(row: Record<string, unknown>, key: Buffer | undefined): TenantSettings & { id: string } {
  const slug = String(row.slug);
  const sealed = row.secrets as Buffer | null;
  return {
    id: String(row.id),
    slug,
    orgId: String(row.org_id),
    hosts: (row.hosts as string[] | null) ?? [],
    status: row.status === "suspended" ? "suspended" : "active",
    ...withoutUndefined(Object.fromEntries(TENANT_TEXT_SETTINGS.map(([field, column]) => [field, text(row[column])]))),
    oidcAdmin: row.oidc_admin === true,
    secrets: sealed?.length ? onlySecrets(openTenantSecret(sealed, key, slug)) : {},
  };
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function trustedClientId(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const parsed = JSON.parse(raw) as { clientId?: unknown };
  return text(parsed.clientId);
}

export type TenantEnvSettings = Omit<TenantSettings, "id" | "slug" | "orgId" | "hosts" | "status">;

export function settingsFromEnv(env: Env): TenantEnvSettings {
  const clientId = trustedClientId(env.PORTAL_TRUSTED_OIDC);
  return withoutUndefined({
    appsDomain: text(env.PORTAL_APPS_DOMAIN) ?? text(env.DEPLOY_APPS_DOMAIN),
    s3Bucket: text(env.S3_BUCKET),
    sandboxNamePrefix: text(env.SANDBOX_NAME_PREFIX),
    modalAppName: text(env.MODAL_APP_NAME),
    modalEnvironment: text(env.MODAL_ENVIRONMENT),
    modalSnapshotBucket: text(env.MODAL_SNAPSHOT_S3_BUCKET),
    awsSandboxBucket: text(env.AWS_SANDBOX_S3_BUCKET),
    sentryDeployment: text(env.SENTRY_DEPLOYMENT),
    faviconSvg: text(env.WEB_UI_FAVICON_SVG) ?? text(env.PORTAL_FAVICON_SVG),
    oidcClientId: clientId,
    oidcLabel: clientId ? text(env.PORTAL_TRUSTED_OIDC_LABEL) : undefined,
    oidcAdmin: Boolean(clientId) && env.PORTAL_TRUSTED_OIDC_ADMIN === "1",
    secrets: onlySecrets({
      oidcClientSecret: clientId ? env.PORTAL_TRUSTED_OIDC_CLIENT_SECRET : undefined,
      modelGatewayApiKey: env.MODEL_GATEWAY_API_KEY,
      slackServiceToken: env.QM_SLACK_SERVICE_TOKEN,
      adminGrants: env.ADMIN_GRANTS,
      connectorSecretKey: env.CONNECTOR_SECRET_KEY,
    }),
  });
}

export function homeHosts(env: Env): string[] {
  return [env.PORTAL_PUBLIC_URL, env.PUBLIC_WEB_URL, env.PUBLIC_API_URL, env.AGENT_API_URL]
    .map(hostOfUrl)
    .filter((host): host is string => Boolean(host));
}

export function homeTenantSettings(env: Env, home: { orgId: string; id?: string; slug?: string }): TenantSettings {
  return {
    ...(home.id ? { id: home.id } : {}),
    slug: home.slug ?? "home",
    orgId: home.orgId,
    hosts: homeHosts(env),
    status: "active",
    ...settingsFromEnv(env),
  };
}
