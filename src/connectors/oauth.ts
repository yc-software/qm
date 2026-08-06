import type { OAuthToken, OAuthRefresh } from "../credentials/keychain.ts";
import { createEnvSecretSource, type SecretSource } from "../credentials/secret-source.ts";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { mintSignedPayload, verifySignedPayload } from "../auth/signed-token.ts";
import { swallow } from "../util/errors.ts";

export type AccountType = "default" | "personal" | "company";

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
  hosts: string[];
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
  redirectPath: string;
  consentMode: ConsentMode;
  egressRule: string[];
  setupGuide: OAuthSetupGuide;
  scopeParam?: string;
  authParams?: Record<string, string>;
  exchange?: OAuthExchangeAdapter;
  refresh?: OAuthRefreshAdapter | null;
  pkce?: boolean;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
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

function makeTokenAdapters(opts: {
  acceptJson?: boolean;
  rejectErrorBody?: boolean;
  label?: string;
  clientAuth?: "body" | "basic";
}): {
  exchange: (
    args: OAuthAdapterArgs & { code: string },
  ) => Promise<{ hosts: string[]; token: OAuthToken; raw: Record<string, unknown> }>;
  refresh: OAuthRefreshAdapter;
} {
  const prefix = opts.label ? `${opts.label} ` : "";
  const basic = opts.clientAuth === "basic";
  const headers = (client: ResolvedClient) => ({
    "content-type": "application/x-www-form-urlencoded",
    ...(opts.acceptJson ? { accept: "application/json" } : {}),
    ...(basic ? { authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}` } : {}),
  });
  const clientBody = (client: ResolvedClient): Record<string, string> =>
    basic ? { client_id: client.id } : { client_id: client.id, client_secret: client.secret };
  const checkErrorBody = (raw: Record<string, unknown>): void => {
    if (opts.rejectErrorBody && raw.error)
      throw new Error(`${prefix}oauth error: ${String(raw.error_description ?? raw.error)}`);
  };
  return {
    async exchange({ provider, client, code, redirectUri, fetchImpl, now, codeVerifier }) {
      const res = await fetchImpl(provider.tokenUrl, {
        method: "POST",
        headers: headers(client),
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          ...clientBody(client),
          ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
        }).toString(),
      });
      if (!res.ok) throw new Error(`${prefix}token exchange failed (${res.status})`);
      const raw = (await res.json()) as Record<string, unknown>;
      checkErrorBody(raw);
      return { hosts: provider.hosts, token: toToken(raw, undefined, now), raw };
    },
    async refresh({ provider, client, token, fetchImpl, now }) {
      const res = await fetchImpl(provider.tokenUrl, {
        method: "POST",
        headers: headers(client),
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: token.refreshToken ?? "",
          ...clientBody(client),
        }).toString(),
      });
      if (!res.ok) throw new Error(`${prefix}token refresh failed (${res.status})`);
      const raw = (await res.json()) as Record<string, unknown>;
      checkErrorBody(raw);
      return toToken(raw, token.refreshToken, now, token.grantedScopes);
    },
  };
}

const { exchange: defaultExchange, refresh: defaultRefresh } = makeTokenAdapters({});

const googleExchange: OAuthExchangeAdapter = async (args) => {
  const { client, accountType } = args;
  const { hosts, token, raw } = await defaultExchange(args);
  if (accountType === "company" && client.hostedDomain) {
    const idToken = typeof raw?.id_token === "string" ? raw.id_token : "";
    let claims: Record<string, unknown> | undefined;
    try {
      if (idToken) claims = decodeJwt(idToken);
    } catch (e) {
      swallow("google id_token decode", e);
    }
    const hd = typeof claims?.hd === "string" ? claims.hd : "";
    if (hd.toLowerCase() !== client.hostedDomain.toLowerCase()) {
      throw new Error(
        `connected account is not in the ${client.hostedDomain} workspace — pick your company Google account`,
      );
    }
  }
  return { hosts, token };
};

const github = makeTokenAdapters({ acceptJson: true, rejectErrorBody: true, label: "github" });

const x = makeTokenAdapters({ acceptJson: true, rejectErrorBody: true, label: "x", clientAuth: "basic" });

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
  if (!res.ok) throw new Error(`slack token exchange failed (${res.status})`);
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
  if (!res.ok) throw new Error(`notion token exchange failed (${res.status})`);
  const raw = (await res.json()) as Record<string, unknown>;
  const access = String(raw.access_token ?? "");
  if (!access) throw new Error("notion token exchange returned no access_token");
  return { hosts: provider.hosts, token: { accessToken: access } };
};
const ATLASSIAN_ACCESSIBLE_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";

async function assertSingleAtlassianSite(fetchImpl: FetchLike, accessToken: string): Promise<void> {
  const res = await fetchImpl(ATLASSIAN_ACCESSIBLE_RESOURCES_URL, {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`atlassian accessible-resources check failed (${res.status})`);
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error("atlassian accessible-resources returned an invalid response");
  const sites = new Set<string>();
  for (const value of raw) {
    const resource = value as Record<string, unknown>;
    if (typeof resource.id !== "string" || !resource.id || typeof resource.url !== "string" || !resource.url) {
      throw new Error("atlassian accessible-resources returned an invalid site");
    }
    let origin: string;
    try {
      origin = new URL(resource.url).origin.toLowerCase();
    } catch {
      throw new Error("atlassian accessible-resources returned an invalid site");
    }
    sites.add(`${resource.id}\n${origin}`);
  }
  if (sites.size !== 1) {
    throw new Error(
      `atlassian connection must grant exactly one site; the token currently grants ${sites.size}. Reconnect and select only the intended site`,
    );
  }
}

async function atlassianTokenRequest(
  args: OAuthAdapterArgs,
  body: Record<string, string>,
  fallbackRefresh?: string,
  grantedScopes?: string[],
): Promise<OAuthToken> {
  const res = await args.fetchImpl(args.provider.tokenUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = (await res.json()) as Record<string, unknown>;
  if (!res.ok || raw.error) {
    throw new Error(
      `atlassian token request failed (${res.status}): ${String(raw.error_description ?? raw.error ?? "unknown")}`,
    );
  }
  const token = toToken(raw, fallbackRefresh, args.now, grantedScopes);
  if (!token.accessToken) throw new Error("atlassian token request returned no access_token");
  return token;
}

const atlassianExchange: OAuthExchangeAdapter = async (args) => {
  const token = await atlassianTokenRequest(args, {
    grant_type: "authorization_code",
    client_id: args.client.id,
    client_secret: args.client.secret,
    code: args.code,
    redirect_uri: args.redirectUri,
  });
  await assertSingleAtlassianSite(args.fetchImpl, token.accessToken);
  return { hosts: args.provider.hosts, token };
};

const atlassianRefresh: OAuthRefreshAdapter = async (args) =>
  atlassianTokenRequest(
    args,
    {
      grant_type: "refresh_token",
      client_id: args.client.id,
      client_secret: args.client.secret,
      refresh_token: args.token.refreshToken ?? "",
    },
    args.token.refreshToken,
    args.token.grantedScopes,
  );

async function readAiTokenRequest(
  args: OAuthAdapterArgs,
  body: Record<string, string>,
  fallbackRefresh?: string,
  grantedScopes?: string[],
): Promise<OAuthToken> {
  const basic = Buffer.from(`${args.client.id}:${args.client.secret}`).toString("base64");
  const res = await args.fetchImpl(args.provider.tokenUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams(body).toString(),
  });
  const raw = (await res.json()) as Record<string, unknown>;
  if (!res.ok || raw.error) {
    throw new Error(
      `read ai token request failed (${res.status}): ${String(raw.error_description ?? raw.error ?? "unknown")}`,
    );
  }
  const token = toToken(raw, fallbackRefresh, args.now, grantedScopes);
  if (!token.accessToken) throw new Error("read ai token request returned no access_token");
  return token;
}

const readAiExchange: OAuthExchangeAdapter = async (args) => {
  if (!args.codeVerifier) throw new Error("read ai token exchange requires a PKCE verifier");
  const token = await readAiTokenRequest(args, {
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
  });
  return { hosts: args.provider.hosts, token };
};

const readAiRefresh: OAuthRefreshAdapter = async (args) =>
  readAiTokenRequest(
    args,
    {
      grant_type: "refresh_token",
      refresh_token: args.token.refreshToken ?? "",
    },
    args.token.refreshToken,
    args.token.grantedScopes,
  );

export const PROVIDERS: Record<string, OAuthProviderConfig> = {
  google: {
    hosts: [
      "gmail.googleapis.com",
      "www.googleapis.com",
      "sheets.googleapis.com",
      "docs.googleapis.com",
      "slides.googleapis.com",
    ],
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/tasks",
      "openid",
      "email",
    ],
    clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
    clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
    redirectPath: "google/callback",
    consentMode: "standard",
    egressRule: [
      "gmail.googleapis.com",
      "www.googleapis.com",
      "sheets.googleapis.com",
      "docs.googleapis.com",
      "slides.googleapis.com",
      "oauth2.googleapis.com",
      "accounts.google.com",
    ],
    authParams: { access_type: "offline", prompt: "consent" },
    exchange: googleExchange,
    setupGuide: {
      console: "Google Cloud Console → APIs & Services → Credentials",
      url: "https://console.cloud.google.com/auth/clients",
      steps: [
        "Create an OAuth 2.0 Client ID (type: Web application).",
        "Add the redirect URI shown below to 'Authorized redirect URIs' on YOUR client.",
        "Enable the Gmail, Calendar, Drive, Sheets, Docs, Slides, and Tasks APIs for the project.",
        "Choose admin-consent (domain-wide) vs per-user consent on the OAuth consent screen.",
        "Paste the Client ID + Client secret below; we validate by dry-running the consent URL.",
      ],
      scopesRationale:
        "gmail.modify/calendar/drive/spreadsheets/tasks back the Google Workspace skills; openid+email identify the account.",
    },
  },

  atlassian: {
    hosts: ["api.atlassian.com"],
    authUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    scopes: ["read:jira-work", "search:confluence", "read:confluence-content.all", "offline_access"],
    clientIdEnv: "ATLASSIAN_OAUTH_CLIENT_ID",
    clientSecretEnv: "ATLASSIAN_OAUTH_CLIENT_SECRET",
    redirectPath: "atlassian/callback",
    consentMode: "standard",
    egressRule: ["api.atlassian.com", "auth.atlassian.com"],
    authParams: { audience: "api.atlassian.com", prompt: "consent" },
    exchange: atlassianExchange,
    refresh: atlassianRefresh,
    setupGuide: {
      console: "Atlassian Developer Console → My apps",
      url: "https://developer.atlassian.com/console/myapps/",
      steps: [
        "Create an OAuth 2.0 (3LO) integration and use a resource-level grant.",
        "Add the Jira and Confluence APIs, then grant only the requested read scopes and offline_access.",
        "Add the redirect URI shown below as the app's callback URL.",
        "During consent, select exactly one Jira/Confluence site; connections granting zero or multiple sites are rejected.",
        "Paste the Client ID + Client secret below.",
      ],
      scopesRationale:
        "Jira and Confluence read/search scopes back read-only issue and page retrieval; offline_access enables rotating refresh tokens. No write scopes are requested.",
    },
  },

  "read-ai": {
    hosts: ["api.read.ai"],
    authUrl: "https://authn.read.ai/oauth2/auth",
    tokenUrl: "https://authn.read.ai/oauth2/token",
    scopes: ["openid", "email", "offline_access", "profile", "meeting:read"],
    clientIdEnv: "READ_AI_OAUTH_CLIENT_ID",
    clientSecretEnv: "READ_AI_OAUTH_CLIENT_SECRET",
    redirectPath: "read-ai/callback",
    consentMode: "standard",
    egressRule: ["api.read.ai", "authn.read.ai"],
    exchange: readAiExchange,
    refresh: readAiRefresh,
    pkce: true,
    setupGuide: {
      console: "Read AI API → Dynamic OAuth client registration",
      url: "https://support.read.ai/hc/en-us/articles/49380809380371-API-Keys-Authentication",
      steps: [
        "Ensure Downloads is enabled under Read AI Workspace Settings → Reports & Sharing.",
        "POST a dynamic OAuth client registration to https://api.read.ai/oauth/register using the redirect URI shown below.",
        "Request only openid, email, offline_access, profile, and meeting:read with Authorization Code + refresh_token grants and client_secret_basic authentication.",
        "Save the returned Client ID and Client secret immediately; Read AI does not show the secret again.",
        "Paste the Client ID + Client secret below.",
      ],
      scopesRationale:
        "meeting:read provides read-only access to meeting reports, summaries, action items, and transcripts; identity scopes bind the account; offline_access enables rotating refresh tokens.",
    },
  },

  slack: {
    hosts: ["slack.com"],
    authUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes: [
      "users:read",
      "channels:read",
      "channels:history",
      "groups:read",
      "groups:history",
      "im:read",
      "im:history",
      "mpim:read",
      "mpim:history",
      "chat:write",
      "canvases:read",
      "canvases:write",
      "search:read",
      "search:read.im",
      "search:read.mpim",
    ],
    clientIdEnv: "SLACK_OAUTH_CLIENT_ID",
    clientSecretEnv: "SLACK_OAUTH_CLIENT_SECRET",
    redirectPath: "slack/callback",
    consentMode: "standard",
    egressRule: ["slack.com"],
    scopeParam: "user_scope",
    exchange: slackExchange,
    refresh: null,
    setupGuide: {
      console: "Slack API → Your Apps → OAuth & Permissions",
      url: "https://api.slack.com/apps",
      steps: [
        "Create a Slack app (from scratch) in your workspace.",
        "Under OAuth & Permissions, add the redirect URL shown below.",
        "Add the requested USER token scopes under 'User Token Scopes'.",
        "Install the app to the workspace.",
        "Paste the Client ID + Client secret below.",
      ],
      scopesRationale:
        "User-token scopes let the agent read/post, search, and edit canvases as the connecting user, not a bot.",
    },
  },

  notion: {
    hosts: ["api.notion.com"],
    authUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: [],
    clientIdEnv: "NOTION_OAUTH_CLIENT_ID",
    clientSecretEnv: "NOTION_OAUTH_CLIENT_SECRET",
    redirectPath: "notion/callback",
    consentMode: "standard",
    egressRule: ["api.notion.com"],
    authParams: { owner: "user" },
    exchange: notionExchange,
    refresh: null,
    setupGuide: {
      console: "Notion → My integrations → New integration (Public)",
      url: "https://www.notion.so/profile/integrations",
      steps: [
        "Create a public OAuth integration.",
        "Add the redirect URI shown below to the integration's redirect URIs.",
        "Configure the capabilities the integration needs.",
        "Paste the Client ID (OAuth client ID) + the OAuth client secret below.",
      ],
      scopesRationale: "Notion grants access per selected pages at consent time (no OAuth scope list).",
    },
  },

  linear: {
    hosts: ["api.linear.app"],
    authUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    scopes: ["read", "write"],
    clientIdEnv: "LINEAR_OAUTH_CLIENT_ID",
    clientSecretEnv: "LINEAR_OAUTH_CLIENT_SECRET",
    redirectPath: "linear/callback",
    consentMode: "standard",
    egressRule: ["api.linear.app"],
    refresh: null,
    setupGuide: {
      console: "Linear → Settings → API → OAuth applications",
      url: "https://linear.app/settings/api/applications",
      steps: [
        "Create an OAuth application.",
        "Add the redirect URI shown below as a callback URL.",
        "Select the read/write scopes.",
        "Paste the Client ID + Client secret below.",
      ],
      scopesRationale: "read/write let the agent query and update issues, projects, and comments.",
    },
  },

  dropbox: {
    hosts: ["api.dropboxapi.com", "content.dropboxapi.com"],
    authUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    scopes: [
      "account_info.read",
      "files.metadata.read",
      "files.content.read",
      "files.content.write",
      "sharing.read",
      "sharing.write",
    ],
    clientIdEnv: "DROPBOX_OAUTH_CLIENT_ID",
    clientSecretEnv: "DROPBOX_OAUTH_CLIENT_SECRET",
    redirectPath: "dropbox/callback",
    consentMode: "standard",
    egressRule: ["api.dropboxapi.com", "content.dropboxapi.com", "www.dropbox.com"],
    authParams: { token_access_type: "offline" },
    setupGuide: {
      console: "Dropbox App Console → Create app",
      url: "https://www.dropbox.com/developers/apps/create",
      steps: [
        "Create an app: Scoped access, Full Dropbox access.",
        "On the app's OAuth 2 section, add the redirect URI shown below.",
        "On the Permissions tab, enable account_info.read, files.metadata.read, files.content.read, files.content.write, sharing.read, sharing.write — then Submit.",
        "Paste the App key (Client ID) + App secret (Client secret) below.",
      ],
      scopesRationale:
        "files.content/metadata read+write back browse/download/upload; sharing.read/write let the agent manage shared links; account_info.read identifies the account.",
    },
  },

  github: {
    hosts: ["api.github.com"],
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["repo", "read:org"],
    clientIdEnv: "GITHUB_OAUTH_CLIENT_ID",
    clientSecretEnv: "GITHUB_OAUTH_CLIENT_SECRET",
    redirectPath: "github/callback",
    consentMode: "github_app",
    egressRule: ["api.github.com", "github.com"],
    exchange: github.exchange,
    refresh: github.refresh,
    setupGuide: {
      console: "GitHub → Settings → Developer settings → OAuth Apps (or GitHub App)",
      url: "https://github.com/settings/applications/new",
      steps: [
        "Register a new OAuth App (or a GitHub App for installation tokens).",
        "Set the Authorization callback URL to the redirect URI shown below.",
        "Select the repo/org scopes the agent needs.",
        "Paste the Client ID + Client secret below.",
      ],
      scopesRationale: "repo/read:org back the GitHub skills (PRs, issues, org-visible repos) as the connecting user.",
    },
  },

  x: {
    hosts: ["api.x.com"],
    authUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    clientIdEnv: "X_OAUTH_CLIENT_ID",
    clientSecretEnv: "X_OAUTH_CLIENT_SECRET",
    redirectPath: "x/callback",
    consentMode: "standard",
    egressRule: ["api.x.com"],
    pkce: true,
    exchange: x.exchange,
    refresh: x.refresh,
    setupGuide: {
      console: "X Developer Portal → Projects & Apps → your app → User authentication settings",
      url: "https://developer.x.com/en/portal/projects-and-apps",
      steps: [
        "Set up User authentication: OAuth 2.0, type Confidential client, App permissions Read and write.",
        "Add the Callback URI shown below to the app's Callback URLs.",
        "Under Keys and tokens, generate the OAuth 2.0 Client ID and Client Secret.",
        "Paste the Client ID + Client secret below.",
      ],
      scopesRationale:
        "tweet.read/users.read back reads; tweet.write lets the connecting user post as themselves; offline.access issues a refresh token so the 2-hour access token renews.",
    },
  },
};

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
    const p = PROVIDERS[providerName];
    if (!p) throw new Error(`unknown OAuth provider: ${providerName}`);
    const id = await secrets.get(p.clientIdEnv);
    const secret = await secrets.get(p.clientSecretEnv);
    if (!id || !secret) throw new Error(`provider not configured — set ${p.clientIdEnv} and ${p.clientSecretEnv}`);
    const hostedDomain = await secrets.get("GOOGLE_WORKSPACE_DOMAIN");
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

const ACCOUNT_TYPES: readonly AccountType[] = ["default", "personal", "company"];

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
    (s.accountType === undefined || (typeof s.accountType === "string" && ACCOUNT_TYPES.includes(s.accountType))) &&
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
  const p = PROVIDERS[provider];
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
  q.set(p.scopeParam ?? "scope", scopes.join(" "));
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
  const p = PROVIDERS[provider];
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

function providerForHost(host: string): { name: string; config: OAuthProviderConfig } | null {
  for (const [name, config] of Object.entries(PROVIDERS)) {
    if (config.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return { name, config };
  }
  return null;
}

export function makeRefresh(opts: {
  resolveClient: OAuthClientResolver;
  fetchImpl?: FetchLike;
  now?: () => number;
}): OAuthRefresh {
  return async (host, token, ctx) => {
    const match = providerForHost(host);
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
