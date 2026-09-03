import type { DerivedOAuthAuth, Keychain } from "../credentials/keychain.ts";
import type { ModelProvider } from "./pi-models.ts";

type UserCredentialKind = "apikey" | "oauth";

export interface UserOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accountId?: string;
  expiresAt?: number;
}

/** Connection summary. Never carries token material. */
export interface UserModelCredential {
  provider: ModelProvider;
  kind: UserCredentialKind;
  apiKey?: string;
  oauth?: { accountId?: string; expiresAt?: number; needsReconnect?: boolean };
  updatedAt: number;
}

interface UserCredentialConnection {
  provider: ModelProvider;
  kind: UserCredentialKind;
}

export interface UserModelCredentialStore {
  get(userId: string, provider: ModelProvider): Promise<UserModelCredential | null>;
  connections(userId: string): Promise<UserCredentialConnection[]>;
  setApiKey(userId: string, provider: ModelProvider, apiKey: string): Promise<void>;
  setOAuth(userId: string, provider: ModelProvider, tokens: UserOAuthTokens): Promise<void>;
  beginOAuth(userId: string, provider: ModelProvider, updateId: string): Promise<void>;
  setOAuthIfPending(
    userId: string,
    provider: ModelProvider,
    tokens: UserOAuthTokens,
    updateId: string,
  ): Promise<boolean>;
  cancelOAuthUpdate(userId: string, provider: ModelProvider, updateId: string): Promise<void>;
  /**
   * Fresh derived material for the user's subscription login (access + id
   * token + account id) — refreshed inside the keychain (single-flight, CAS)
   * when stale. The refresh token never leaves the keychain record.
   */
  derivedOAuth(userId: string, provider: ModelProvider): Promise<DerivedOAuthAuth | null>;
  delete(userId: string, provider: ModelProvider): Promise<void>;
}

const PROVIDERS = ["anthropic", "openai", "xai"] as const satisfies readonly ModelProvider[];
const ORIGIN = "individual-model-auth";
/**
 * OAuth logins are keyed by the provider's auth host, so the keychain's own
 * connector-token machinery (encryption, expiry margin, single-flight refresh
 * via the wired refresh dispatch) covers them with no parallel implementation.
 */
const AI_OAUTH_HOSTS: Record<(typeof PROVIDERS)[number], string> = {
  anthropic: "claude.ai",
  openai: "auth.openai.com",
  xai: "auth.x.ai",
};
/** Segregates AI subscription logins from any other connector use of the same host. */
const AI_ACCOUNT_TYPE = "individual-model";

function serviceFor(provider: ModelProvider): string {
  return `model-${provider}`;
}

function oauthHostFor(provider: ModelProvider): string | null {
  return provider === "anthropic" || provider === "openai" || provider === "xai" ? AI_OAUTH_HOSTS[provider] : null;
}

function keychainOAuthToken(provider: ModelProvider, tokens: UserOAuthTokens) {
  if (!tokens.accessToken?.trim()) throw new Error("access token is required");
  return {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(provider !== "xai" && tokens.idToken ? { idToken: tokens.idToken } : {}),
    ...(provider !== "xai" && tokens.accountId ? { accountId: tokens.accountId } : {}),
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
  };
}

/**
 * Per-user AI-account custody, backed by the org keychain — NOT a parallel
 * secret store.
 *
 * - Subscription (OAuth) logins are keychain connector tokens: the keychain
 *   encrypts them, tracks expiry, and refreshes them centrally; callers only
 *   ever receive derived material without the refresh token.
 * - API keys are ordinary keychain credentials owned by the user (service
 *   `model-<provider>`, origin `individual-model-auth`), so admin visibility
 *   and "remove my credentials" apply.
 */
export function createUserModelCredentialStore(input: { keychain: Keychain }): UserModelCredentialStore {
  const { keychain } = input;

  async function findApiKey(userId: string, provider: ModelProvider) {
    const all = await keychain.listByOwner(userId);
    return all.find((c) => c.service === serviceFor(provider) && c.origin === ORIGIN) ?? null;
  }

  async function oauthCredential(userId: string, provider: ModelProvider): Promise<UserModelCredential | null> {
    const host = oauthHostFor(provider);
    if (!host) return null;
    const status = await keychain.connectorTokenStatus(host, userId, AI_ACCOUNT_TYPE);
    if (!status.connected) return null;
    return {
      provider,
      kind: "oauth",
      oauth: {
        ...(status.expiresAt !== undefined ? { expiresAt: status.expiresAt } : {}),
        ...(status.needsReconnect ? { needsReconnect: true } : {}),
      },
      updatedAt: 0,
    };
  }

  async function apiKeyCredential(userId: string, provider: ModelProvider): Promise<UserModelCredential | null> {
    const meta = await findApiKey(userId, provider);
    if (!meta) return null;
    const apiKey = await keychain.readOwnSecret(userId, meta.id);
    if (!apiKey) return null;
    return { provider, kind: "apikey", apiKey, updatedAt: meta.updatedAt };
  }

  return {
    async get(userId, provider) {
      return (await oauthCredential(userId, provider)) ?? (await apiKeyCredential(userId, provider));
    },

    async connections(userId) {
      const found: UserCredentialConnection[] = [];
      for (const provider of PROVIDERS) {
        const cred = (await oauthCredential(userId, provider)) ?? (await apiKeyCredential(userId, provider));
        if (cred && !(cred.kind === "oauth" && cred.oauth?.needsReconnect)) found.push({ provider, kind: cred.kind });
      }
      return found;
    },

    async setApiKey(userId, provider, apiKey) {
      const secret = apiKey.trim();
      if (!secret) throw new Error("API key is required");
      // One connection per provider: an API key replaces a subscription login.
      const host = oauthHostFor(provider);
      if (host) await keychain.deleteConnectorToken(host, userId, AI_ACCOUNT_TYPE);
      await keychain.save({ ownerId: userId, service: serviceFor(provider), secret, origin: ORIGIN });
    },

    async setOAuth(userId, provider, tokens) {
      const host = oauthHostFor(provider);
      if (!host) throw new Error(`no subscription login host for provider ${provider}`);
      await keychain.setConnectorToken(host, userId, keychainOAuthToken(provider, tokens), AI_ACCOUNT_TYPE);
      const apiKeyMeta = await findApiKey(userId, provider);
      if (apiKeyMeta) await keychain.remove(userId, apiKeyMeta.id);
    },

    async beginOAuth(userId, provider, updateId) {
      const host = oauthHostFor(provider);
      if (!host) throw new Error(`no subscription login host for provider ${provider}`);
      await keychain.beginConnectorTokenUpdate(host, userId, updateId, AI_ACCOUNT_TYPE);
    },

    async setOAuthIfPending(userId, provider, tokens, updateId) {
      const host = oauthHostFor(provider);
      if (!host) throw new Error(`no subscription login host for provider ${provider}`);
      const stored = await keychain.setConnectorTokenIfPending(
        host,
        userId,
        keychainOAuthToken(provider, tokens),
        updateId,
        AI_ACCOUNT_TYPE,
      );
      const apiKeyMeta = stored ? await findApiKey(userId, provider) : null;
      if (apiKeyMeta) await keychain.remove(userId, apiKeyMeta.id);
      return stored;
    },

    async cancelOAuthUpdate(userId, provider, updateId) {
      const host = oauthHostFor(provider);
      if (!host) return;
      await keychain.cancelConnectorTokenUpdate(host, userId, updateId, AI_ACCOUNT_TYPE);
    },

    async derivedOAuth(userId, provider) {
      const host = oauthHostFor(provider);
      if (!host) return null;
      return keychain.connectorDerivedAuth(host, userId, AI_ACCOUNT_TYPE);
    },

    async delete(userId, provider) {
      const host = oauthHostFor(provider);
      if (host) await keychain.deleteConnectorToken(host, userId, AI_ACCOUNT_TYPE);
      const meta = await findApiKey(userId, provider);
      if (meta) await keychain.remove(userId, meta.id);
    },
  };
}
