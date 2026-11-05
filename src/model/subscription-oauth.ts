import { codeChallengeS256, generateCodeVerifier, oauthFailure } from "../connectors/oauth.ts";
import { chatgptAccountIdFromToken, tokenExpiry } from "./chatgpt-auth-file.ts";
import type { UserOAuthTokens } from "./user-model-credential-store.ts";

const CHATGPT_ISSUER = "https://auth.openai.com";
const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_SCOPE = "openid profile email offline_access";

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_AUTHORIZE = "https://claude.ai/oauth/authorize";
const CLAUDE_TOKEN = "https://console.anthropic.com/v1/oauth/token";
const CLAUDE_REDIRECT = "https://platform.claude.com/oauth/code/callback";
const CLAUDE_SCOPE = "org:create_api_key user:profile user:inference";

export interface ChatGPTDevicePrompt {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

async function postToken(
  url: string,
  action: string,
  body: Record<string, string | undefined>,
): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw await oauthFailure(action, res);
  const raw = (await res.json()) as Partial<TokenResponse>;
  if (!raw.access_token) throw new Error(`${action} response missing access_token`);
  return { ...raw, access_token: raw.access_token };
}

export async function refreshChatGPTTokens(refreshToken: string): Promise<UserOAuthTokens> {
  const raw = await postToken(`${CHATGPT_ISSUER}/oauth/token`, "chatgpt refresh", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CHATGPT_CLIENT_ID,
    scope: CHATGPT_SCOPE,
  });
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? refreshToken,
    idToken: raw.id_token,
    accountId: chatgptAccountIdFromToken(raw.id_token) ?? chatgptAccountIdFromToken(raw.access_token),
    expiresAt: tokenExpiry(raw),
  };
}

export function startClaudeLogin(): { authorizeUrl: string; verifier: string } {
  const verifier = generateCodeVerifier();
  const url = new URL(CLAUDE_AUTHORIZE);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", CLAUDE_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CLAUDE_REDIRECT);
  url.searchParams.set("scope", CLAUDE_SCOPE);
  url.searchParams.set("code_challenge", codeChallengeS256(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", verifier);
  return { authorizeUrl: url.toString(), verifier };
}

export async function completeClaudeLogin(pastedCode: string, verifier: string): Promise<UserOAuthTokens> {
  const [code, state] = pastedCode.trim().split("#");
  const raw = await postToken(CLAUDE_TOKEN, "claude token exchange", {
    grant_type: "authorization_code",
    client_id: CLAUDE_CLIENT_ID,
    code,
    state: state ?? verifier,
    code_verifier: verifier,
    redirect_uri: CLAUDE_REDIRECT,
  });
  return { accessToken: raw.access_token, refreshToken: raw.refresh_token, expiresAt: tokenExpiry(raw) };
}

export async function refreshClaudeTokens(refreshToken: string): Promise<UserOAuthTokens> {
  const raw = await postToken(CLAUDE_TOKEN, "claude refresh", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLAUDE_CLIENT_ID,
  });
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? refreshToken,
    expiresAt: tokenExpiry(raw),
  };
}
