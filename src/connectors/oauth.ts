import type { OAuthToken, OAuthRefresh } from "../credentials/keychain.ts";
import {
  parseOAuthProviderPreset,
  type CustomOAuthProvider,
  type OAuthProviderPresetFields,
} from "./custom-provider.ts";
import { createEnvSecretSource, type SecretSource } from "../credentials/secret-source.ts";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { z } from "zod";
import presets from "./oauth-providers.json" with { type: "json" };
import { mintSignedPayload, verifySignedPayload } from "../auth/signed-token.ts";
import { swallow } from "../util/errors.ts";
import { isObj } from "../util/objects.ts";

export type AccountType = string;
export const MODEL_LOGIN_ACCOUNT_TYPE = "individual-model";
const accountName = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]([a-z0-9._@+-]*[a-z0-9])?$/)
  .refine((name) => name !== MODEL_LOGIN_ACCOUNT_TYPE);
export const accountNameRule = (field = "accountType"): string =>
  `${field} must be 1-64 characters of lowercase letters, digits, and . _ @ + -, starting and ending with a letter or digit`;

export const isAccountType = (value: unknown): value is AccountType => accountName.safeParse(value).success;

export function parseAccountName(value: unknown): AccountType | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  return isAccountType(name) ? name : null;
}

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}
export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export type ConsentMode = "standard" | "admin" | "github_app";

interface OAuthSetupGuide {
  console: string;
  url: string;
  steps: string[];
  scopesRationale?: string;
}

interface OAuthAdapterArgs {
  provider: OAuthProviderConfig;
  client: ResolvedClient;
  redirectUri: string;
  fetchImpl: FetchLike;
  now: number;
  accountType?: AccountType;
  codeVerifier?: string;
}
type OAuthExchangeAdapter = (
  args: OAuthAdapterArgs & { code: string },
) => Promise<{ hosts: string[]; token: OAuthToken }>;
type OAuthRefreshAdapter = (args: OAuthAdapterArgs & { token: OAuthToken }) => Promise<OAuthToken>;

export interface OAuthProviderConfig {
  label: string;
  description?: string;
  hosts: string[];
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdEnv?: string;
  clientSecretEnv?: string;
  hostedDomainEnv?: string;
  redirectPath: string;
  consentMode: ConsentMode;
  setupGuide: OAuthSetupGuide;
  scopeParam?: string;
  authParams?: Record<string, string>;
  exchange?: OAuthExchangeAdapter;
  refresh?: OAuthRefreshAdapter | null;
  pkce?: boolean;
  mcpLabel?: string;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const realFetch: FetchLike = (url, init) => fetch(url, init);

function parseScopes(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string" && raw.trim()) return raw.trim().split(/\s+/);
  return undefined;
}

function toToken(
  raw: Record<string, unknown>,
  fallbackRefresh: string | undefined,
  now: number,
  grantedScopes?: string[],
): OAuthToken {
  const access = String(raw.access_token ?? "");
  const refresh = raw.refresh_token ? String(raw.refresh_token) : fallbackRefresh;
  const expiresIn = typeof raw.expires_in === "number" ? raw.expires_in : undefined;
  const scopes = grantedScopes ?? parseScopes(raw.scope);
  return {
    accessToken: access,
    ...(refresh ? { refreshToken: refresh } : {}),
    ...(expiresIn ? { expiresAt: now + expiresIn * 1000 } : {}),
    ...(scopes ? { grantedScopes: scopes } : {}),
  };
}

function oauthErrorDetail(body: unknown): string {
  if (!isObj(body)) return "";
  const nested = isObj(body.error) ? body.error : undefined;
  const code = nested ? (nested.code ?? nested.type) : body.error;
  const description = nested ? nested.message : (body.error_description ?? body.reason);
  return [code, description].filter((part): part is string => typeof part === "string" && part.length > 0).join(": ");
}

export async function oauthFailure(action: string, res: { status: number; json(): Promise<unknown> }): Promise<Error> {
  const detail = oauthErrorDetail(await res.json().catch(() => undefined));
  return new Error(`${action} failed (${res.status})${detail ? `: ${detail}` : ""}`);
}

const resourceBody = (p: OAuthProviderConfig): Record<string, string> =>
  p.authParams?.resource ? { resource: p.authParams.resource } : {};

function checkHostedDomain(provider: OAuthProviderConfig, domain: string, raw: Record<string, unknown>): void {
  const idToken = typeof raw.id_token === "string" ? raw.id_token : "";
  let claims: Record<string, unknown> | undefined;
  try {
    if (idToken) claims = decodeJwt(idToken);
  } catch (e) {
    swallow(`${provider.label} id_token decode`, e);
  }
  const hd = typeof claims?.hd === "string" ? claims.hd : "";
  if (hd.toLowerCase() !== domain.toLowerCase())
    throw new Error(
      `connected account is not in the ${domain} workspace — pick your company ${provider.label} account`,
    );
}

function makeTokenAdapters(opts: {
  acceptJson?: boolean;
  rejectErrorBody?: boolean;
  label?: string;
  clientAuth?: "body" | "basic";
}): { exchange: OAuthExchangeAdapter; refresh: OAuthRefreshAdapter } {
  const prefix = opts.label ? `${opts.label} ` : "";
  const basic = opts.clientAuth === "basic";
  const headers = (client: ResolvedClient) => ({
    "content-type": "application/x-www-form-urlencoded",
    ...(opts.acceptJson ? { accept: "application/json" } : {}),
    ...(basic ? { authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}` } : {}),
  });
  const clientBody = (client: ResolvedClient): Record<string, string> =>
    basic || !client.secret ? { client_id: client.id } : { client_id: client.id, client_secret: client.secret };
  const checkErrorBody = (raw: Record<string, unknown>): void => {
    if (opts.rejectErrorBody && raw.error)
      throw new Error(`${prefix}oauth error: ${oauthErrorDetail(raw) || String(raw.error)}`);
  };
  return {
    async exchange({ provider, client, code, redirectUri, fetchImpl, now, codeVerifier, accountType }) {
      const res = await fetchImpl(provider.tokenUrl, {
        method: "POST",
        headers: headers(client),
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          ...clientBody(client),
          ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
          ...resourceBody(provider),
        }).toString(),
      });
      if (!res.ok) throw await oauthFailure(`${prefix}token exchange`, res);
      const raw = (await res.json()) as Record<string, unknown>;
      checkErrorBody(raw);
      if (provider.hostedDomainEnv && accountType === "company" && client.hostedDomain)
        checkHostedDomain(provider, client.hostedDomain, raw);
      return { hosts: provider.hosts, token: toToken(raw, undefined, now) };
    },
    async refresh({ provider, client, token, fetchImpl, now }) {
      const res = await fetchImpl(provider.tokenUrl, {
        method: "POST",
        headers: headers(client),
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: token.refreshToken ?? "",
          ...clientBody(client),
          ...resourceBody(provider),
        }).toString(),
      });
      if (!res.ok) throw await oauthFailure(`${prefix}token refresh`, res);
      const raw = (await res.json()) as Record<string, unknown>;
      checkErrorBody(raw);
      return toToken(raw, token.refreshToken, now, token.grantedScopes);
    },
  };
}

const { exchange: defaultExchange, refresh: defaultRefresh } = makeTokenAdapters({});

const slackExchange: OAuthExchangeAdapter = async ({ provider, client, code, redirectUri, fetchImpl }) => {
  const res = await fetchImpl(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      redirect_uri: redirectUri,
      client_id: client.id,
      client_secret: client.secret,
    }).toString(),
  });
  if (!res.ok) throw await oauthFailure("slack token exchange", res);
  const raw = (await res.json()) as Record<string, unknown>;
  if (raw.ok !== true) throw new Error(`slack oauth error: ${String(raw.error ?? "unknown")}`);
  const authedUser = (raw.authed_user ?? {}) as Record<string, unknown>;
  const access = String(authedUser.access_token ?? raw.access_token ?? "");
  if (!access) throw new Error("slack oauth returned no usable token (no user or bot token granted)");
  const grantedScopes = parseScopes(authedUser.scope) ?? parseScopes(raw.scope);
  return { hosts: provider.hosts, token: { accessToken: access, ...(grantedScopes ? { grantedScopes } : {}) } };
};

const notionExchange: OAuthExchangeAdapter = async ({ provider, client, code, redirectUri, fetchImpl }) => {
  const basic = Buffer.from(`${client.id}:${client.secret}`).toString("base64");
  const res = await fetchImpl(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${basic}` },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  if (!res.ok) throw await oauthFailure("notion token exchange", res);
  const raw = (await res.json()) as Record<string, unknown>;
  const access = String(raw.access_token ?? "");
  if (!access) throw new Error("notion token exchange returned no access_token");
  return { hosts: provider.hosts, token: { accessToken: access } };
};

export interface PublicOAuthClient {
  name: string;
  host: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: string;
  resource?: string;
  label: string;
}

const publicClients = new Map<string, PublicOAuthClient>();
const publicProviders = new Map<string, OAuthProviderConfig>();
let reloadStoredProviders: (() => Promise<void>) | undefined;

export function setStoredOAuthProviderReload(reload: (() => Promise<void>) | undefined): void {
  reloadStoredProviders = reload;
}

async function lookupWithReload<T>(lookup: () => T | undefined): Promise<T | undefined> {
  const cached = lookup();
  if (cached !== undefined || !reloadStoredProviders) return cached;
  await reloadStoredProviders();
  return lookup();
}

type ProviderRecord = CustomOAuthProvider & Partial<OAuthProviderPresetFields>;

const TOKEN_ADAPTERS = { slack: slackExchange, notion: notionExchange };

export const OAUTH_PROVIDER_PRESETS = presets.map((p) => parseOAuthProviderPreset(p));

function providerConfig(p: ProviderRecord): OAuthProviderConfig {
  const generic = makeTokenAdapters({
    acceptJson: p.acceptJson ?? true,
    rejectErrorBody: p.rejectErrorBody ?? true,
    label: p.provider,
    clientAuth: p.clientAuth,
  });
  const custom = p.tokenAdapter ? TOKEN_ADAPTERS[p.tokenAdapter] : undefined;
  return {
    label: p.label,
    ...(p.description ? { description: p.description } : {}),
    hosts: p.hosts,
    authUrl: p.authUrl,
    tokenUrl: p.tokenUrl,
    scopes: p.scopes,
    ...(p.clientIdEnv && p.clientSecretEnv ? { clientIdEnv: p.clientIdEnv, clientSecretEnv: p.clientSecretEnv } : {}),
    ...(p.hostedDomainEnv ? { hostedDomainEnv: p.hostedDomainEnv } : {}),
    redirectPath: `${p.provider}/callback`,
    consentMode: p.consentMode ?? "standard",
    ...(p.scopeParam ? { scopeParam: p.scopeParam } : {}),
    ...(p.authParams ? { authParams: p.authParams } : {}),
    ...(p.pkce ? { pkce: true } : {}),
    exchange: custom ?? generic.exchange,
    refresh: custom ? null : generic.refresh,
    setupGuide: {
      console: p.setupConsole ?? p.label,
      url: p.docsUrl ?? "",
      steps: p.setupSteps ?? [],
      ...(p.scopesRationale ? { scopesRationale: p.scopesRationale } : {}),
    },
  };
}

const builtInProviders = new Map(OAUTH_PROVIDER_PRESETS.map((p) => [p.provider, providerConfig(p)]));
let connectorProviders = builtInProviders;

export function setStoredOAuthProviders(providers: CustomOAuthProvider[]): void {
  connectorProviders = new Map(builtInProviders);
  for (const p of providers)
    if (!builtInProviders.has(p.provider)) connectorProviders.set(p.provider, providerConfig(p));
}

export function setPublicOAuthClients(clients: PublicOAuthClient[]): void {
  publicClients.clear();
  publicProviders.clear();
  for (const c of clients) {
    if (connectorProvider(c.name)) continue;
    publicClients.set(c.name, c);
    publicProviders.set(c.name, {
      label: c.label,
      hosts: [c.host],
      authUrl: c.authUrl,
      tokenUrl: c.tokenUrl,
      scopes: c.scopes,
      redirectPath: `${c.name}/callback`,
      consentMode: "standard",
      pkce: true,
      mcpLabel: c.label,
      ...(c.resource ? { authParams: { resource: c.resource } } : {}),
      setupGuide: { console: "Admin → MCP servers", url: "", steps: [] },
    });
  }
}

export function hostsOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`)));
}

export function isBuiltInProvider(name: string): boolean {
  return builtInProviders.has(name);
}

export function connectorProvider(name: string): OAuthProviderConfig | undefined {
  return connectorProviders.get(name);
}

export function connectorProviderEntries(): Array<[string, OAuthProviderConfig]> {
  return [...connectorProviders];
}

export function oauthProviderEntries(): Array<[string, OAuthProviderConfig]> {
  return [...connectorProviderEntries(), ...publicProviders.entries()];
}

export function oauthProvider(name: string): OAuthProviderConfig | undefined {
  return connectorProvider(name) ?? publicProviders.get(name);
}

export function resolveConnectorProvider(name: string): Promise<OAuthProviderConfig | undefined> {
  return lookupWithReload(() => connectorProvider(name));
}

export function resolveOAuthProvider(name: string): Promise<OAuthProviderConfig | undefined> {
  return lookupWithReload(() => oauthProvider(name));
}

export function withPublicOAuthClients(resolve: OAuthClientResolver): OAuthClientResolver {
  return async (provider, ctx) => {
    const c = connectorProvider(provider) ? undefined : publicClients.get(provider);
    return c ? { id: c.clientId, secret: "", clientRef: `public:${provider}` } : resolve(provider, ctx);
  };
}

export interface ResolvedClient {
  id: string;
  secret: string;
  scopes?: string[];
  redirectAllowlist?: string[];
  hostedDomain?: string;
  clientRef: string;
}

export type OAuthClientResolver = (provider: string, ctx: { accountType?: AccountType }) => Promise<ResolvedClient>;

export function createSecretClientResolver(secrets: SecretSource = createEnvSecretSource()): OAuthClientResolver {
  return async (providerName) => {
    const p = connectorProvider(providerName);
    if (!p) throw new Error(`unknown OAuth provider: ${providerName}`);
    if (!p.clientIdEnv || !p.clientSecretEnv)
      throw new Error("provider not configured — add its OAuth app under Admin → Connectors");
    const [id, secret, hostedDomain] = await Promise.all([
      secrets.get(p.clientIdEnv),
      secrets.get(p.clientSecretEnv),
      p.hostedDomainEnv ? secrets.get(p.hostedDomainEnv) : undefined,
    ]);
    if (!id || !secret) throw new Error(`provider not configured — set ${p.clientIdEnv} and ${p.clientSecretEnv}`);
    return { id, secret, clientRef: `env:${providerName}`, ...(hostedDomain ? { hostedDomain } : {}) };
  };
}

export interface OAuthState {
  provider: string;
  principalId: string;
  redirectUri: string;
  issuedAt: number;
  nonce: string;
  returnTo?: string;
  orgId?: string;
  accountType?: AccountType;
  clientRef?: string;
  codeVerifier?: string;
  consentLinkId?: string;
}

function isOAuthState(v: unknown): v is OAuthState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as OAuthState;
  return (
    typeof s.provider === "string" &&
    typeof s.principalId === "string" &&
    typeof s.redirectUri === "string" &&
    typeof s.issuedAt === "number" &&
    typeof s.nonce === "string" &&
    (s.returnTo === undefined || typeof s.returnTo === "string") &&
    (s.orgId === undefined || typeof s.orgId === "string") &&
    (s.accountType === undefined || isAccountType(s.accountType)) &&
    (s.clientRef === undefined || typeof s.clientRef === "string") &&
    (s.codeVerifier === undefined || typeof s.codeVerifier === "string") &&
    (s.consentLinkId === undefined || typeof s.consentLinkId === "string")
  );
}

export function sealOAuthState(
  state: Omit<OAuthState, "issuedAt" | "nonce"> & { issuedAt?: number; nonce?: string },
  opts: { secret: string; now?: () => number } = { secret: "" },
): Promise<string> {
  if (!opts.secret) throw new Error("OAuth state secret required");
  return mintSignedPayload(
    {
      ...state,
      issuedAt: state.issuedAt ?? (opts.now ?? Date.now)(),
      nonce: state.nonce ?? randomUUID(),
    },
    opts.secret,
  );
}

export async function openOAuthState(
  sealed: string,
  opts: { secret: string; now?: () => number; maxAgeMs?: number },
): Promise<OAuthState> {
  if (!opts.secret) throw new Error("OAuth state secret required");
  const parsed = await verifySignedPayload(sealed, opts.secret);
  if (!isOAuthState(parsed)) throw new Error("invalid OAuth state");
  const now = (opts.now ?? Date.now)();
  const maxAgeMs = opts.maxAgeMs ?? 10 * 60_000;
  if (parsed.issuedAt > now + 60_000 || now - parsed.issuedAt > maxAgeMs) {
    throw new Error("expired OAuth state");
  }
  return parsed;
}

export function scopesFor(p: OAuthProviderConfig, client: ResolvedClient): string[] {
  return client.scopes ?? p.scopes;
}

export function authorizeUrl(
  provider: string,
  opts: {
    redirectUri: string;
    state: string;
    client: ResolvedClient;
    accountType?: AccountType;
    codeChallenge?: string;
  },
): string {
  const p = oauthProvider(provider);
  if (!p) throw new Error(`unknown OAuth provider: ${provider}`);
  const accountType = opts.accountType ?? "default";
  const scopes = scopesFor(p, opts.client);
  const q = new URLSearchParams({
    client_id: opts.client.id,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    state: opts.state,
  });
  if (opts.codeChallenge) {
    q.set("code_challenge", opts.codeChallenge);
    q.set("code_challenge_method", "S256");
  }
  if (scopes.length) q.set(p.scopeParam ?? "scope", scopes.join(" "));
  for (const [k, v] of Object.entries(p.authParams ?? {})) q.set(k, v);
  if (accountType === "company" && opts.client.hostedDomain) q.set("hd", opts.client.hostedDomain);
  return `${p.authUrl}?${q.toString()}`;
}

export async function exchangeCode(
  provider: string,
  code: string,
  redirectUri: string,
  opts: {
    client: ResolvedClient;
    fetchImpl?: FetchLike;
    now?: number;
    accountType?: AccountType;
    codeVerifier?: string;
  },
): Promise<{ hosts: string[]; token: OAuthToken }> {
  const p = oauthProvider(provider);
  if (!p) throw new Error(`unknown OAuth provider: ${provider}`);
  const adapter = p.exchange ?? defaultExchange;
  return adapter({
    provider: p,
    client: opts.client,
    code,
    redirectUri,
    fetchImpl: opts.fetchImpl ?? realFetch,
    now: opts.now ?? Date.now(),
    ...(opts.accountType ? { accountType: opts.accountType } : {}),
    ...(opts.codeVerifier ? { codeVerifier: opts.codeVerifier } : {}),
  });
}

function providerForHost(host: string): { name: string; config: OAuthProviderConfig } | undefined {
  for (const [name, config] of oauthProviderEntries()) {
    if (config.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return { name, config };
  }
  return undefined;
}

export function makeRefresh(opts: {
  resolveClient: OAuthClientResolver;
  fetchImpl?: FetchLike;
  now?: () => number;
}): OAuthRefresh {
  return async (host, token, ctx) => {
    const match = await lookupWithReload(() => providerForHost(host));
    if (!match) throw new Error(`cannot refresh ${host} (unknown provider)`);
    if (match.config.refresh === null) throw new Error(`${match.name} tokens do not refresh — reconnect`);
    if (!token.refreshToken) throw new Error(`cannot refresh ${host} (no refresh token)`);
    const accountType = (ctx?.accountType ?? token.accountType) as AccountType | undefined;
    const client = await opts.resolveClient(match.name, accountType ? { accountType } : {});
    const adapter = match.config.refresh ?? defaultRefresh;
    const fresh = await adapter({
      provider: match.config,
      client,
      token,
      redirectUri: "",
      fetchImpl: opts.fetchImpl ?? realFetch,
      now: (opts.now ?? Date.now)(),
      ...(accountType ? { accountType } : {}),
    });
    if (!fresh.accessToken) throw new Error(`${match.name} token refresh returned an empty access token`);
    return fresh;
  };
}
