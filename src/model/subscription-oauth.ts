import { codeChallengeS256, generateCodeVerifier } from "../connectors/oauth.ts";
import { CODEX_OAUTH_ISSUER, codexOAuthJwtAccountIdFromToken } from "../harness/codex-auth-file.ts";
import type { UserOAuthTokens } from "./user-model-credential-store.ts";

const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_SCOPE = "openid profile email offline_access";

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTHORIZE = "https://claude.ai/oauth/authorize";
const CLAUDE_TOKEN = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_REDIRECT = "https://platform.claude.com/oauth/code/callback";
const CLAUDE_SCOPE = "org:create_api_key user:profile user:inference";

function decodeJwtClaims(jwt: string | undefined): Record<string, unknown> | undefined {
  if (!jwt) return undefined;
  const part = jwt.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function chatgptAccountId(tokens: { idToken?: string; accessToken: string }): string | undefined {
  return codexOAuthJwtAccountIdFromToken(tokens.idToken) ?? codexOAuthJwtAccountIdFromToken(tokens.accessToken);
}

function tokenExpiry(raw: { expires_in?: number; access_token?: string }): number | undefined {
  if (typeof raw.expires_in === "number") return Date.now() + raw.expires_in * 1000;
  const claims = decodeJwtClaims(raw.access_token);
  const exp = claims?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

export interface ChatGPTDevicePrompt {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresAt: number;
}

export async function refreshChatGPTTokens(refreshToken: string): Promise<UserOAuthTokens> {
  const res = await fetch(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CHATGPT_CLIENT_ID,
      scope: CHATGPT_SCOPE,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`chatgpt refresh failed (${res.status})`);
  const raw = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };
  if (!raw.access_token) throw new Error("chatgpt refresh missing access_token");
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? refreshToken,
    idToken: raw.id_token,
    accountId: chatgptAccountId({ idToken: raw.id_token, accessToken: raw.access_token }),
    expiresAt: tokenExpiry(raw),
  };
}

export interface ClaudeAuthStart {
  authorizeUrl: string;
  verifier: string;
}

export function startClaudeLogin(): ClaudeAuthStart {
  const verifier = generateCodeVerifier();
  const challenge = codeChallengeS256(verifier);
  const url = new URL(CLAUDE_AUTHORIZE);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLAUDE_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CLAUDE_REDIRECT);
  url.searchParams.set("scope", CLAUDE_SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", verifier);
  return { authorizeUrl: url.toString(), verifier };
}

export async function completeClaudeLogin(pastedCode: string, verifier: string): Promise<UserOAuthTokens> {
  const [code, state] = pastedCode.trim().split("#");
  const res = await fetch(CLAUDE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLAUDE_CLIENT_ID,
      code,
      state: state ?? verifier,
      code_verifier: verifier,
      redirect_uri: CLAUDE_REDIRECT,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`claude token exchange failed (${res.status})`);
  const raw = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!raw.access_token) throw new Error("claude token response missing access_token");
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAt: tokenExpiry(raw),
  };
}

export async function refreshClaudeTokens(refreshToken: string): Promise<UserOAuthTokens> {
  const res = await fetch(CLAUDE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLAUDE_CLIENT_ID }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`claude refresh failed (${res.status})`);
  const raw = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!raw.access_token) throw new Error("claude refresh missing access_token");
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? refreshToken,
    expiresAt: tokenExpiry(raw),
  };
}
