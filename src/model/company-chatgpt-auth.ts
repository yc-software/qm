import type { CredentialFile, Keychain, KeychainCredentialMeta } from "../credentials/keychain.ts";
import { swallow } from "../util/errors.ts";
import {
  accessExpiresAt,
  asObject,
  authAccountId,
  authTokens,
  chatgptAuthFromValue,
  type JsonObject,
} from "./chatgpt-auth-file.ts";
import { refreshChatGPTTokens } from "./subscription-oauth.ts";
import type { UserOAuthTokens } from "./user-model-credential-store.ts";

export interface CompanyChatGPTAuth {
  readonly description: string;
  accessToken(): Promise<string | undefined>;
}

interface StoredAuth {
  auth: JsonObject;
  write(next: JsonObject): Promise<void>;
}

interface RefreshDeps {
  refresh?: (refreshToken: string) => Promise<UserOAuthTokens>;
  now?: () => number;
}

const REFRESH_SKEW_MS = 5 * 60_000;
const AUTH_FILE_PATHS = [".codex/auth.json", "codex/auth.json"];

function rotated(auth: JsonObject, next: UserOAuthTokens): JsonObject | null {
  const refreshed: JsonObject = {
    ...auth,
    last_refresh: new Date().toISOString(),
    tokens: {
      ...asObject(auth.tokens),
      access_token: next.accessToken,
      ...(next.idToken ? { id_token: next.idToken } : {}),
      ...(next.refreshToken ? { refresh_token: next.refreshToken } : {}),
    },
  };
  return chatgptAuthFromValue(refreshed) && authAccountId(refreshed) === authAccountId(auth) ? refreshed : null;
}

function refreshingAuth(
  description: string,
  read: () => Promise<StoredAuth | null>,
  deps: RefreshDeps,
): CompanyChatGPTAuth {
  const refresh = deps.refresh ?? refreshChatGPTTokens;
  const now = deps.now ?? Date.now;
  let refreshing: Promise<JsonObject | null> | null = null;

  const fresh = (auth: JsonObject): boolean => {
    const expiresAt = accessExpiresAt(auth);
    return expiresAt === undefined || expiresAt - now() >= REFRESH_SKEW_MS;
  };

  const load = async (): Promise<JsonObject | null> => {
    const current = await read();
    if (!current) return null;
    if (fresh(current.auth)) return current.auth;
    refreshing ??= (async () => {
      const locked = await read();
      if (!locked || fresh(locked.auth)) return locked?.auth ?? null;
      const replaced = authTokens(locked.auth)?.refresh;
      const next = replaced ? rotated(locked.auth, await refresh(replaced)) : null;
      if (!next) return null;
      const latest = await read();
      if (!latest || authTokens(latest.auth)?.refresh !== replaced) return latest?.auth ?? null;
      await latest.write(next);
      return next;
    })().finally(() => {
      refreshing = null;
    });
    try {
      const refreshed = await refreshing;
      if (refreshed) return refreshed;
    } catch (error) {
      swallow("chatgpt: company oauth refresh", error);
    }
    return (await read())?.auth ?? current.auth;
  };

  return {
    description,
    async accessToken() {
      const auth = await load();
      return auth ? authTokens(auth)?.access : undefined;
    },
  };
}

function authFromFiles(files: CredentialFile[]): { path: string; auth: JsonObject } | null {
  for (const file of files) {
    const normalized = file.path.replace(/^\.\//, "");
    if (!AUTH_FILE_PATHS.includes(normalized) && !normalized.endsWith("/auth.json")) continue;
    try {
      const auth = chatgptAuthFromValue(JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8")));
      if (auth) return { path: file.path, auth };
    } catch {
      continue;
    }
  }
  return null;
}

function credentialRevision(meta: KeychainCredentialMeta): string {
  return `${meta.ownerId}:${meta.fingerprint}:${meta.updatedAt}`;
}

export function keychainCompanyChatGPTAuth(
  deps: RefreshDeps & { keychain: Keychain; credentialId: string },
): CompanyChatGPTAuth {
  let cached: { revision: string; found: { path: string; auth: JsonObject } | null } | undefined;
  return refreshingAuth(
    `keychain credential ${deps.credentialId}`,
    async () => {
      const meta = await deps.keychain.getCredential(deps.credentialId);
      if (!meta || meta.kind !== "file") return null;
      const revision = credentialRevision(meta);
      if (cached?.revision !== revision) {
        const bundle = (await deps.keychain.materializeOwnFiles(meta.ownerId)).find(
          (b) => b.credentialId === deps.credentialId,
        );
        cached = { revision, found: bundle ? authFromFiles(bundle.files) : null };
      }
      const found = cached.found;
      if (!found) return null;
      return {
        auth: found.auth,
        async write(next) {
          const expiresAt = accessExpiresAt(next);
          const saved = await deps.keychain.save({
            ownerId: meta.ownerId,
            service: meta.service,
            files: [{ path: found.path, contentBase64: Buffer.from(JSON.stringify(next), "utf8").toString("base64") }],
            ...(expiresAt !== undefined ? { expiresAt } : {}),
          });
          cached = {
            revision: credentialRevision(saved),
            found: { path: found.path, auth: next },
          };
        },
      };
    },
    deps,
  );
}
