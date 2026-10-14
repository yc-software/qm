import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CredentialFile, Keychain, KeychainCredentialMeta } from "../credentials/keychain.ts";
import { swallow } from "../util/errors.ts";
import { chatgptAccountIdFromToken, refreshChatGPTTokens, tokenExpiry } from "./subscription-oauth.ts";
import type { UserOAuthTokens } from "./user-model-credential-store.ts";

type JsonObject = Record<string, unknown>;

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
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_STALE_MS = 60_000;
const AUTH_FILE_PATHS = [".codex/auth.json", "codex/auth.json"];

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function authTokens(auth: JsonObject): { access: string; refresh: string; id?: string } | null {
  const tokens = asObject(auth.tokens);
  if (!tokens || typeof tokens.access_token !== "string" || !tokens.access_token) return null;
  if (typeof tokens.refresh_token !== "string" || !tokens.refresh_token) return null;
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    ...(typeof tokens.id_token === "string" && tokens.id_token ? { id: tokens.id_token } : {}),
  };
}

function authAccountId(auth: JsonObject): string | undefined {
  const tokens = authTokens(auth);
  return tokens ? (chatgptAccountIdFromToken(tokens.id) ?? chatgptAccountIdFromToken(tokens.access)) : undefined;
}

function accessExpiresAt(auth: JsonObject): number | undefined {
  return tokenExpiry({ access_token: authTokens(auth)?.access });
}

export function chatgptAuthFromValue(value: unknown): JsonObject | null {
  const auth = asObject(value);
  if (!auth || (auth.auth_mode !== "chatgpt" && auth.auth_mode !== "chatgptAuthTokens")) return null;
  return authTokens(auth) && authAccountId(auth) ? auth : null;
}

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
  exclusive: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
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
    refreshing ??= exclusive(async () => {
      const locked = await read();
      if (!locked || fresh(locked.auth)) return locked?.auth ?? null;
      const replaced = authTokens(locked.auth)?.refresh;
      const next = replaced ? rotated(locked.auth, await refresh(replaced)) : null;
      if (!next) return null;
      const latest = await read();
      if (!latest || authTokens(latest.auth)?.refresh !== replaced) return latest?.auth ?? null;
      await latest.write(next);
      return next;
    }).finally(() => {
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

function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

export function codexAuthFileForEnv(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.CODEX_AUTH_FILE?.trim();
  return explicit ? expandPath(explicit) : undefined;
}

export function readCodexOAuthAuthFile(path: string): JsonObject | null {
  try {
    if (statSync(path).mode & 0o077) return null;
    return chatgptAuthFromValue(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function writeAuthFile(path: string, auth: JsonObject): void {
  const temporary = join(dirname(path), `.qm-chatgpt-auth-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(auth), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await (await open(lock, "wx", 0o600)).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`, { cause: error });
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

export function fileCompanyChatGPTAuth(path: string, deps: RefreshDeps = {}): CompanyChatGPTAuth {
  return refreshingAuth(
    `auth file ${path}`,
    async () => {
      const auth = readCodexOAuthAuthFile(path);
      return auth ? { auth, write: async (next) => writeAuthFile(path, next) } : null;
    },
    deps,
    (fn) => withFileLock(path, fn),
  );
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
