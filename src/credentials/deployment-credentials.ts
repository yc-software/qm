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
  return credentials;
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
  orgScopeId: ScopeId,
  credentials: readonly DeploymentBrokerCredential[],
): ServiceCredentialStore {
  if (!credentials.length) return store;
  const bySlug = new Map(credentials.map((c) => [c.slug, c]));
  const reserved = (scope: ScopeId, slug: string) => scope === orgScopeId && bySlug.has(slug);
  const guard = (scope: ScopeId, slug: string) => {
    if (reserved(scope, slug)) throw reservedSlugError(slug);
  };
  return {
    async getServiceCredentialSecret(scope, slug) {
      const own = scope === orgScopeId ? bySlug.get(slug) : undefined;
      return own ? decrypted(own) : store.getServiceCredentialSecret(scope, slug);
    },
    async listServiceCredentials(scope) {
      const stored = await store.listServiceCredentials(scope);
      if (scope !== orgScopeId) return stored;
      return [...credentials.map(projected), ...stored.filter((c) => !bySlug.has(c.slug))];
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
