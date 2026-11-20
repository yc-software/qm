import { errMessage } from "../util/errors.ts";
import { credentialInjectionError, type CredentialInjection } from "./credential-injection.ts";
import {
  isBackendCredential,
  isComposioHost,
  isValidBrokerHost,
  isValidBrokerMethod,
  isValidBrokerPathPrefix,
  isValidCredentialSlug,
  isValidServiceCredentialEnvKey,
  type DecryptedServiceCredential,
  type PublicServiceCredential,
  type ServiceCredentialStore,
} from "./keychain.ts";
import type { ScopeId } from "../types.ts";

export interface DeploymentBrokerCredential {
  slug: string;
  name: string;
  secret: string;
  host: string;
  delivery?: "env";
  envKey?: string;
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
  "delivery",
  "envKey",
]);

const BROKER_ONLY_FIELDS = ["host", "injection", "allowedMethods", "allowedPathPrefixes", "maxRequestsPerDay"];

function stringList(value: unknown, label: string, valid: (item: string) => boolean): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !valid(item)))
    throw new Error(`${label} is invalid`);
  return value as string[];
}

function parseEntry(raw: unknown, index: number, env: NodeJS.ProcessEnv): DeploymentBrokerCredential {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`BROKER_CREDENTIALS[${index}] must be an object`);
  const entry = raw as Record<string, unknown>;
  const unknownField = Object.keys(entry).find((key) => !FIELDS.has(key));
  if (unknownField) throw new Error(`BROKER_CREDENTIALS[${index}] has unknown field "${unknownField}"`);
  const slug = entry.slug;
  if (typeof slug !== "string" || !isValidCredentialSlug(slug))
    throw new Error(`BROKER_CREDENTIALS[${index}].slug must be lowercase kebab-case (a-z, 0-9, -)`);
  const at = `BROKER_CREDENTIALS "${slug}"`;
  const secretEnv = entry.secretEnv;
  if (typeof secretEnv !== "string" || !isValidServiceCredentialEnvKey(secretEnv) || secretEnv === "BROKER_CREDENTIALS")
    throw new Error(`${at}: secretEnv must name an UPPER_SNAKE_CASE env var`);
  const secret = env[secretEnv]?.trim();
  if (!secret) throw new Error(`${at}: env var ${secretEnv} is unset or empty`);
  const name = entry.displayName ?? slug;
  if (typeof name !== "string" || !name.trim() || name.length > 100)
    throw new Error(`${at}: displayName must be 1-100 characters`);
  if (entry.delivery !== undefined || entry.envKey !== undefined) {
    if (entry.delivery !== "env") throw new Error(`${at}: delivery must be "env" when set`);
    const envKey = entry.envKey;
    if (typeof envKey !== "string" || !isBackendCredential({ envKey }))
      throw new Error(`${at}: env delivery is only for the Composio key; set envKey to COMPOSIO_API_KEY`);
    const brokerField = BROKER_ONLY_FIELDS.find((key) => entry[key] !== undefined);
    if (brokerField) throw new Error(`${at}: ${brokerField} only applies to broker delivery`);
    return { slug, name: name.trim(), secret, host: "", delivery: "env", envKey };
  }
  const host = entry.host;
  if (typeof host !== "string" || !isValidBrokerHost(host))
    throw new Error(`${at}: host must be a bare lowercase hostname`);
  if (isComposioHost(host)) throw new Error(`${at}: Composio hosts cannot be brokered`);
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

export function deploymentBrokerCredentialsFromEnv(env: NodeJS.ProcessEnv): DeploymentBrokerCredential[] {
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
  if (credentials.filter(isDeploymentDefault).length > 1)
    throw new Error("BROKER_CREDENTIALS lists more than one env-delivered Composio key");
  return credentials;
}

function isDeploymentDefault(c: DeploymentBrokerCredential): boolean {
  return c.delivery === "env";
}

function decrypted(c: DeploymentBrokerCredential): DecryptedServiceCredential {
  return {
    slug: c.slug,
    name: c.name,
    secret: c.secret,
    delivery: c.delivery ?? "broker",
    ...(c.envKey ? { envKey: c.envKey } : {}),
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
  orgScopeId: ScopeId,
  credentials: readonly DeploymentBrokerCredential[],
): ServiceCredentialStore {
  if (!credentials.length) return store;
  const bySlug = new Map(credentials.map((c) => [c.slug, c]));
  const reserved = (scope: ScopeId, slug: string) => {
    const own = scope === orgScopeId ? bySlug.get(slug) : undefined;
    return Boolean(own && !isDeploymentDefault(own));
  };
  const guard = (scope: ScopeId, slug: string) => {
    if (reserved(scope, slug)) throw reservedSlugError(slug);
  };
  return {
    async getServiceCredentialSecret(scope, slug) {
      const own = scope === orgScopeId ? bySlug.get(slug) : undefined;
      if (!own) return store.getServiceCredentialSecret(scope, slug);
      if (!isDeploymentDefault(own)) return decrypted(own);
      return (await store.getServiceCredentialSecret(scope, slug)) ?? decrypted(own);
    },
    async listServiceCredentials(scope) {
      const stored = await store.listServiceCredentials(scope);
      if (scope !== orgScopeId) return stored;
      const storedSlugs = new Set(stored.map((c) => c.slug));
      const supplied = credentials.filter((c) => !isDeploymentDefault(c) || !storedSlugs.has(c.slug));
      return [...supplied.map(projected), ...stored.filter((c) => !reserved(scope, c.slug))];
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
