import { errMessage } from "../util/errors.ts";
import {
  credentialInjectionError,
  isComposioHost,
  isValidBrokerHost,
  isValidBrokerMethod,
  isValidBrokerPathPrefix,
  isValidCredentialSlug,
  isValidServiceCredentialEnvKey,
  type CredentialInjection,
  type DecryptedServiceCredential,
  type PublicServiceCredential,
  type ServiceCredentialStore,
} from "./keychain.ts";
import type { ScopeId } from "../types.ts";
import { boundTenant, isInstallTenant } from "../tenants/context.ts";
import { loadedTenantSettings } from "../tenants/settings.ts";

export interface DeploymentBrokerCredential {
  slug: string;
  name: string;
  secret: string;
  host: string;
  injection?: CredentialInjection;
  allowedMethods?: string[];
  allowedPathPrefixes?: string[];
  maxRequestsPerDay?: number;
}

const FIELDS = new Set([
  "slug",
  "displayName",
  "secretEnv",
  "host",
  "injection",
  "allowedMethods",
  "allowedPathPrefixes",
  "maxRequestsPerDay",
]);

function stringList(value: unknown, label: string, valid: (item: string) => boolean): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !valid(item)))
    throw new Error(`${label} is invalid`);
  return value as string[];
}

function parseEntry(
  raw: unknown,
  index: number,
  env: Readonly<Record<string, string | undefined>>,
): DeploymentBrokerCredential {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`BROKER_CREDENTIALS[${index}] must be an object`);
  const entry = raw as Record<string, unknown>;
  const unknownField = Object.keys(entry).find((key) => !FIELDS.has(key));
  if (unknownField) throw new Error(`BROKER_CREDENTIALS[${index}] has unknown field "${unknownField}"`);
  const slug = entry.slug;
  if (typeof slug !== "string" || !isValidCredentialSlug(slug))
    throw new Error(`BROKER_CREDENTIALS[${index}].slug must be lowercase kebab-case (a-z, 0-9, -)`);
  const at = `BROKER_CREDENTIALS "${slug}"`;
  const host = entry.host;
  if (typeof host !== "string" || !isValidBrokerHost(host))
    throw new Error(`${at}: host must be a bare lowercase hostname`);
  if (isComposioHost(host)) throw new Error(`${at}: Composio hosts cannot be brokered`);
  const secretEnv = entry.secretEnv;
  if (typeof secretEnv !== "string" || !isValidServiceCredentialEnvKey(secretEnv) || secretEnv === "BROKER_CREDENTIALS")
    throw new Error(`${at}: secretEnv must name an UPPER_SNAKE_CASE env var`);
  const secret = env[secretEnv]?.trim();
  if (!secret) throw new Error(`${at}: env var ${secretEnv} is unset or empty`);
  const injectionError = credentialInjectionError(entry.injection);
  if (injectionError) throw new Error(`${at}: ${injectionError}`);
  const allowedMethods = stringList(entry.allowedMethods, `${at}: allowedMethods`, isValidBrokerMethod);
  const allowedPathPrefixes = stringList(
    entry.allowedPathPrefixes,
    `${at}: allowedPathPrefixes`,
    isValidBrokerPathPrefix,
  );
  const cap = entry.maxRequestsPerDay;
  if (cap !== undefined && !(typeof cap === "number" && Number.isSafeInteger(cap) && cap >= 1))
    throw new Error(`${at}: maxRequestsPerDay must be a positive whole number`);
  const name = entry.displayName ?? slug;
  if (typeof name !== "string" || !name.trim() || name.length > 100)
    throw new Error(`${at}: displayName must be 1-100 characters`);
  return {
    slug,
    name: name.trim(),
    secret,
    host,
    ...(entry.injection ? { injection: entry.injection as CredentialInjection } : {}),
    ...(allowedMethods?.length ? { allowedMethods } : {}),
    ...(allowedPathPrefixes?.length ? { allowedPathPrefixes } : {}),
    ...(cap !== undefined ? { maxRequestsPerDay: cap as number } : {}),
  };
}

export function deploymentBrokerCredentialsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): DeploymentBrokerCredential[] {
  const raw = env.BROKER_CREDENTIALS?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`BROKER_CREDENTIALS must be a JSON array (${errMessage(error)})`, { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error("BROKER_CREDENTIALS must be a JSON array");
  const credentials = parsed.map((entry, index) => parseEntry(entry, index, env));
  const seen = new Set<string>();
  for (const { slug } of credentials) {
    if (seen.has(slug)) throw new Error(`BROKER_CREDENTIALS lists slug "${slug}" more than once`);
    seen.add(slug);
  }
  return credentials;
}

function tenantBrokerEnv(env: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.entries(env)
      .filter(([name]) => name === "BROKER_CREDENTIALS" || name.startsWith("BROKER_SECRET_"))
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

export function tenantBrokerCredentials(
  deployment: readonly DeploymentBrokerCredential[],
): () => readonly DeploymentBrokerCredential[] {
  const parsed = new Map<string, { env: string; credentials: readonly DeploymentBrokerCredential[] }>();
  return () => {
    const tenant = boundTenant();
    const env = tenant ? loadedTenantSettings().env : undefined;
    if (!tenant) return deployment;
    // The deployment-wide set belongs to the install tenant's org only. Any other tenant
    // without its own BROKER_CREDENTIALS gets none, never the deployment's secrets.
    if (!env?.BROKER_CREDENTIALS?.trim()) return isInstallTenant() ? deployment : [];
    const current = tenantBrokerEnv(env);
    const cached = parsed.get(tenant);
    if (cached?.env === current) return cached.credentials;
    let credentials: readonly DeploymentBrokerCredential[] = [];
    try {
      credentials = deploymentBrokerCredentialsFromEnv(env);
    } catch (error) {
      console.warn(`[broker-credentials] tenant ${tenant} BROKER_CREDENTIALS ignored: ${errMessage(error)}`);
    }
    parsed.set(tenant, { env: current, credentials });
    return credentials;
  };
}

function decrypted(c: DeploymentBrokerCredential): DecryptedServiceCredential {
  return {
    slug: c.slug,
    name: c.name,
    secret: c.secret,
    delivery: "broker",
    host: c.host,
    ...(c.injection ? { injection: c.injection } : {}),
    ...(c.allowedMethods ? { allowedMethods: c.allowedMethods } : {}),
    ...(c.allowedPathPrefixes ? { allowedPathPrefixes: c.allowedPathPrefixes } : {}),
    ...(c.maxRequestsPerDay !== undefined ? { maxRequestsPerDay: c.maxRequestsPerDay } : {}),
    deployments: false,
    enabled: true,
    source: "deployment",
  };
}

function projected(c: DeploymentBrokerCredential): PublicServiceCredential {
  const { secret: _secret, ...rest } = decrypted(c);
  return { ...rest, hasSecret: true, updatedAt: 0 };
}

export function nonDeploymentCredential<T extends { source?: "deployment" }>(record: T | null): T | null {
  return record && record.source !== "deployment" ? record : null;
}

function reservedSlugError(slug: string): Error {
  return new Error(`credential "${slug}" is supplied by this deployment and cannot be changed here`);
}

export function withDeploymentCredentials(
  store: ServiceCredentialStore,
  orgScopeId: ScopeId | (() => ScopeId),
  credentials: readonly DeploymentBrokerCredential[] | (() => readonly DeploymentBrokerCredential[]),
): ServiceCredentialStore {
  if (typeof credentials !== "function" && !credentials.length) return store;
  const indexes = new WeakMap<readonly DeploymentBrokerCredential[], Map<string, DeploymentBrokerCredential>>();
  const active = () => {
    const list = typeof credentials === "function" ? credentials() : credentials;
    let bySlug = indexes.get(list);
    if (!bySlug) indexes.set(list, (bySlug = new Map(list.map((c) => [c.slug, c]))));
    return { org: typeof orgScopeId === "function" ? orgScopeId() : orgScopeId, list, bySlug };
  };
  const guard = (scope: ScopeId, slug: string) => {
    const { org, bySlug } = active();
    if (scope === org && bySlug.has(slug)) throw reservedSlugError(slug);
  };
  return {
    async getServiceCredentialSecret(scope, slug) {
      const { org, bySlug } = active();
      const own = scope === org ? bySlug.get(slug) : undefined;
      return own ? decrypted(own) : store.getServiceCredentialSecret(scope, slug);
    },
    async listServiceCredentials(scope) {
      const { org, list, bySlug } = active();
      const stored = await store.listServiceCredentials(scope);
      if (scope !== org) return stored;
      return [...list.map(projected), ...stored.filter((c) => !bySlug.has(c.slug))];
    },
    async setServiceCredential(scope, input) {
      guard(scope, input.slug);
      return store.setServiceCredential(scope, input);
    },
    async setServiceCredentialIfAbsent(scope, input) {
      guard(scope, input.slug);
      return store.setServiceCredentialIfAbsent(scope, input);
    },
    async setServiceCredentialIfCurrent(scope, input, expectedUpdatedAt) {
      guard(scope, input.slug);
      return store.setServiceCredentialIfCurrent(scope, input, expectedUpdatedAt);
    },
    async deleteServiceCredential(scope, slug) {
      guard(scope, slug);
      return store.deleteServiceCredential(scope, slug);
    },
    async deleteServiceCredentialIfCurrent(scope, slug, expectedUpdatedAt) {
      guard(scope, slug);
      return store.deleteServiceCredentialIfCurrent(scope, slug, expectedUpdatedAt);
    },
  };
}
