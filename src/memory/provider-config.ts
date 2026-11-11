import { parseScopeId, type ScopeId, type ScopeKind } from "../types.ts";
import { isPrivateNetworkIp, parsePrivateNetworkOrigins } from "../util/network.ts";
import type { MemoryCapturePolicy, MemoryProviderRoute } from "./provider-router.ts";
import { parseMemorableProvider, type MemorableMemoryProviderConfig } from "./memorable/config.ts";
import { trimTrailingSlashes } from "../util/text.ts";

const KINDS = new Set<ScopeKind>(["personal", "channel", "team", "org", "group"]);
export const MEMORY_PROVIDER_ID = /^[a-z][a-z0-9-]{0,62}$/;
const ARG = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const ENV = /^[A-Z][A-Z0-9_]*$/;
export const MAX_PROVIDER_TIMEOUT_MS = 30_000;

interface McpMemoryAuthConfig {
  clientId: string;
  clientSecret: string;
}

export interface McpMemoryOperationConfig {
  tool: string;
  auth: McpMemoryAuthConfig;
  queryArg?: string;
  contentArg?: string;
  factsArg?: string;
  actorArg?: string;
  scopeArg?: string;
  maxCharsArg?: string;
  inputArg?: string;
  replyArg?: string;
  capturedAtArg?: string;
  sourceArg?: string;
  idempotencyArg?: string;
}

export interface McpMemoryForgetConfig {
  tool: string;
  receiptTool: string;
  auth: McpMemoryAuthConfig;
  idArg: string;
  requestIdArg: string;
}

interface McpMemoryProviderConfig {
  id: string;
  type: "mcp";
  url: string;
  read: McpMemoryOperationConfig;
  write?: McpMemoryOperationConfig;
  forget?: McpMemoryForgetConfig;
  timeoutMs: number;
  attestActor: boolean;
}

type AnyMemoryProviderConfig = McpMemoryProviderConfig | MemorableMemoryProviderConfig;

function capturePoliciesOf(provider: AnyMemoryProviderConfig): ReadonlySet<MemoryCapturePolicy> {
  if (provider.type === "mcp") return new Set(provider.write ? ["off", "explicit", "automatic"] : ["off"]);
  return provider.capturePolicies;
}

export interface MemoryProviderConfig {
  providers: AnyMemoryProviderConfig[];
  routes: MemoryProviderRoute[];
}

function timeout(value: unknown, at: string, fallback: number, max: number): number {
  const ms = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(ms) || Number(ms) <= 0 || Number(ms) > max)
    throw new Error(`${at} must be an integer from 1 to ${max}`);
  return Number(ms);
}

function object(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${at} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, at: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${at} must be a non-empty string`);
  return value;
}

const PRIVATE_HOSTS = ["localhost", "127.0.0.1"];
const PRIVATE_SUFFIXES = [".internal", ".flycast", ".local"];
const ACCEPTED_HOSTS = [...PRIVATE_HOSTS, ...PRIVATE_SUFFIXES.map((suffix) => `*${suffix}`)];
const URL_HELP = `Accepted: https://<host>, http:// on ${ACCEPTED_HOSTS.slice(0, -1).join(", ")} or ${ACCEPTED_HOSTS.at(-1)}, or http:// on an origin listed in PRIVATE_NETWORK_ALLOWED_ORIGINS; see docs/memory-providers.md#troubleshooting.`;

const namedPrivateHost = (hostname: string): boolean =>
  PRIVATE_HOSTS.includes(hostname) || PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix));

const trimTrailing = (value: string, char: string): string => {
  let end = value.length;
  while (value[end - 1] === char) end--;
  return value.slice(0, end);
};

export const isPrivateHost = (hostname: string): boolean =>
  namedPrivateHost(trimTrailing(hostname, ".")) || isPrivateNetworkIp(hostname);

function privateMcpUrl(value: unknown, at: string, allowedOrigins: ReadonlySet<string>): string {
  const raw = string(value, at);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${at} is not a valid URL (value not shown). ${URL_HELP}`);
  }
  const shown = `${url.protocol}//${url.hostname}`;
  const privateHttp = url.protocol === "http:" && (namedPrivateHost(url.hostname) || allowedOrigins.has(url.origin));
  if (url.username || url.password || url.hash)
    throw new Error(`${at} (${shown}) must not carry credentials or a #fragment. ${URL_HELP}`);
  if (url.protocol !== "https:" && !privateHttp)
    throw new Error(`${at} (${shown}) must use HTTPS or a recognized private HTTP host. ${URL_HELP}`);
  return trimTrailingSlashes(raw);
}

function operation(value: unknown, at: string, env: NodeJS.ProcessEnv): McpMemoryOperationConfig {
  const raw = object(value, at);
  const clientIdEnv = string(raw.clientIdEnv, `${at}.clientIdEnv`);
  const clientSecretEnv = string(raw.clientSecretEnv, `${at}.clientSecretEnv`);
  if (!ENV.test(clientIdEnv) || !ENV.test(clientSecretEnv)) throw new Error(`${at} credential env names are invalid`);
  const clientId = env[clientIdEnv];
  const clientSecret = env[clientSecretEnv];
  if (!clientId || !clientSecret) throw new Error(`${at} requires ${clientIdEnv} and ${clientSecretEnv}`);
  const out: McpMemoryOperationConfig = {
    tool: string(raw.tool, `${at}.tool`),
    auth: { clientId, clientSecret },
  };
  for (const key of [
    "queryArg",
    "contentArg",
    "factsArg",
    "actorArg",
    "scopeArg",
    "maxCharsArg",
    "inputArg",
    "replyArg",
    "capturedAtArg",
    "sourceArg",
    "idempotencyArg",
  ] as const) {
    if (raw[key] === undefined) continue;
    const name = string(raw[key], `${at}.${key}`);
    if (!ARG.test(name)) throw new Error(`${at}.${key} is invalid`);
    out[key] = name;
  }
  if (out.factsArg && out.contentArg) throw new Error(`${at} sets both factsArg and contentArg; keep one`);
  return out;
}

function scope(value: unknown, at: string): ScopeKind | ScopeId {
  const raw = string(value, at);
  if (KINDS.has(raw as ScopeKind)) return raw as ScopeKind;
  if (!parseScopeId(raw).kind) throw new Error(`${at} must be a scope kind or scope id`);
  return raw;
}

export function parseMemoryProviderConfig(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
): MemoryProviderConfig | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("MEMORY_PROVIDER_CONFIG must be valid JSON");
  }
  const root = object(parsed, "MEMORY_PROVIDER_CONFIG");
  const allowedOrigins = parsePrivateNetworkOrigins(env.PRIVATE_NETWORK_ALLOWED_ORIGINS);
  if (!Array.isArray(root.providers) || !Array.isArray(root.routes))
    throw new Error("MEMORY_PROVIDER_CONFIG requires providers and routes arrays");
  const providers = root.providers.map((value, i) => {
    const raw = object(value, `MEMORY_PROVIDER_CONFIG.providers[${i}]`);
    const id = string(raw.id, `MEMORY_PROVIDER_CONFIG.providers[${i}].id`);
    if (!MEMORY_PROVIDER_ID.test(id) || id === "default") throw new Error(`invalid memory provider id: ${id}`);
    if (raw.attestActor !== undefined && (raw.type !== "mcp" || typeof raw.attestActor !== "boolean"))
      throw new Error(`memory provider ${id}.attestActor must be true or false on an mcp provider`);
    if (raw.type === "memorable") return parseMemorableProvider(raw, id, env);
    if (raw.type !== "mcp") throw new Error(`memory provider ${id} has unsupported type; use "mcp" or "memorable"`);
    const timeoutMs = timeout(raw.timeoutMs, `memory provider ${id}.timeoutMs`, 3_000, MAX_PROVIDER_TIMEOUT_MS);
    return {
      id,
      type: "mcp" as const,
      url: privateMcpUrl(raw.url, `memory provider ${id}.url`, allowedOrigins),
      timeoutMs,
      attestActor: raw.attestActor === true,
      read: operation(raw.read, `memory provider ${id}.read`, env),
      ...(raw.write ? { write: operation(raw.write, `memory provider ${id}.write`, env) } : {}),
    } satisfies McpMemoryProviderConfig;
  });
  const ids = new Set(["default", ...providers.map(({ id }) => id)]);
  if (ids.size !== providers.length + 1) throw new Error("memory provider ids must be unique");
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const routes = root.routes.map((value, i): MemoryProviderRoute => {
    const raw = object(value, `MEMORY_PROVIDER_CONFIG.routes[${i}]`);
    const provider = string(raw.provider, `MEMORY_PROVIDER_CONFIG.routes[${i}].provider`);
    if (!ids.has(provider)) throw new Error(`unknown memory provider in route: ${provider}`);
    if (!Array.isArray(raw.scopes) || !raw.scopes.length) throw new Error(`memory route ${i} requires scopes`);
    const capture = raw.capture ?? "off";
    if (!(["off", "explicit", "automatic"] as unknown[]).includes(capture))
      throw new Error(`memory route ${i} has invalid capture policy`);
    const target = providerById.get(provider);
    if (target && !capturePoliciesOf(target).has(capture as MemoryCapturePolicy))
      throw new Error(
        `memory route ${i}: provider ${provider} does not support capture "${String(capture)}" (allowed: ${[...capturePoliciesOf(target)].join(", ")})`,
      );
    const manage = typeof raw.manage === "boolean" ? raw.manage : provider === "default";
    if (manage && target?.type === "mcp" && target.attestActor)
      throw new Error(
        `memory route ${i}: provider ${provider} sets attestActor, so it cannot manage a notebook; set "manage": false (docs/memory-providers.md#troubleshooting)`,
      );
    return {
      provider,
      scopes: raw.scopes.map((value, j) => scope(value, `memory route ${i}.scopes[${j}]`)),
      capture: capture as MemoryCapturePolicy,
      ...(typeof raw.recall === "boolean" ? { recall: raw.recall } : {}),
      manage,
      ...(typeof raw.label === "string" && raw.label ? { label: raw.label } : {}),
      failOpen: provider !== "default",
      ...(typeof raw.failOpen === "boolean" ? { failOpen: raw.failOpen } : {}),
    };
  });
  for (const [i, route] of routes.entries()) {
    const target = providerById.get(route.provider);
    const shared = route.scopes.filter((scope) => scope !== "personal" && parseScopeId(scope).kind !== "personal");
    if (target?.type === "mcp" && target.attestActor && shared.length)
      throw new Error(
        `memory route ${i}: provider ${route.provider} sets attestActor, so it may serve only personal scopes, not ${shared.join(", ")}; an attested read returns that member's private memory, which a shared conversation would show to everyone in it (docs/memory-providers.md#attesting-the-member-attestactor)`,
      );
  }
  const servers = new Map<string, { ids: Set<string>; names: string[] }>();
  for (const provider of providers) {
    if (provider.type !== "mcp") continue;
    for (const op of ["read", "write"] as const) {
      const operation = provider[op];
      if (!operation || operation.scopeArg) continue;
      const key = JSON.stringify([provider.url, operation.tool]);
      const server = servers.get(key) ?? { ids: new Set<string>(), names: [] };
      server.ids.add(provider.id);
      server.names.push(`${provider.id}.${op}`);
      servers.set(key, server);
    }
  }
  for (const { ids, names } of servers.values()) {
    const served = routes.filter((route) => ids.has(route.provider));
    const scopes = [...new Set(served.flatMap((route) => route.scopes))];
    const kinds = new Set(scopes.map((scope) => parseScopeId(scope).kind ?? scope));
    const apart =
      (scopes.length === 1 && parseScopeId(scopes[0]!).kind !== null) ||
      (kinds.size === 1 && kinds.has("org")) ||
      (kinds.size === 1 && kinds.has("personal") && served.every((route) => !route.manage));
    if (scopes.length && !apart)
      throw new Error(
        `memory provider ${names.join(" and ")}: no scopeArg, so the server cannot tell apart the scopes it serves (${scopes.join(", ")}); operations without scopeArg that call one server tool may serve only one scope, the org scope, or personal scopes on routes that do not manage a notebook, whose reads carry no member, so set scopeArg on read and write (docs/memory-providers.md#troubleshooting)`,
      );
  }
  return { providers, routes };
}
