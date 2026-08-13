import { randomBytes } from "node:crypto";
import { open as openFile } from "node:fs/promises";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { compactVerify, createRemoteJWKSet, jwtVerify } from "jose";
import { swallow } from "../util/errors.ts";

export type CodexOAuthAuth = Record<string, unknown>;
type JsonObject = CodexOAuthAuth;

const CODEX_OAUTH_MODES = new Set(["chatgpt", "chatgptAuthTokens"]);
const heldOAuthLockPaths = new Set<string>();
const CODEX_OAUTH_ISSUER = "https://auth.openai.com";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_API_AUDIENCE = "https://api.openai.com/v1";
const CODEX_OAUTH_JWKS = createRemoteJWKSet(new URL(`${CODEX_OAUTH_ISSUER}/.well-known/jwks.json`));
export type CodexOAuthTokenKind = "access" | "id";
export type CodexOAuthTokenVerifier = (token: string, kind: CodexOAuthTokenKind) => Promise<string | undefined>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function codexOAuthJwtAccountIdFromToken(value: unknown): string | undefined {
  if (typeof value !== "string" || value.split(".").length !== 3) return undefined;
  try {
    const payload = asObject(JSON.parse(Buffer.from(value.split(".")[1] ?? "", "base64url").toString("utf8")));
    const claims = payload ? asObject(payload["https://api.openai.com/auth"]) : null;
    return typeof claims?.chatgpt_account_id === "string" && claims.chatgpt_account_id
      ? claims.chatgpt_account_id
      : undefined;
  } catch {
    return undefined;
  }
}

function isCodexOAuthJwt(value: unknown): boolean {
  if (typeof value !== "string" || value.split(".").length !== 3) return false;
  try {
    const header = asObject(JSON.parse(Buffer.from(value.split(".")[0] ?? "", "base64url").toString("utf8")));
    const payload = asObject(JSON.parse(Buffer.from(value.split(".")[1] ?? "", "base64url").toString("utf8")));
    return header?.alg === "RS256" && payload?.iss === CODEX_OAUTH_ISSUER;
  } catch {
    return false;
  }
}

export function codexOAuthAccountId(value: unknown): string | undefined {
  const auth = asObject(value);
  const tokens = auth ? asObject(auth.tokens) : null;
  return codexOAuthJwtAccountIdFromToken(tokens?.id_token);
}

function hasAudience(payload: JsonObject, audience: string): boolean {
  return payload.aud === audience || (Array.isArray(payload.aud) && payload.aud.includes(audience));
}

async function verifiedCodexOAuthJwtAccountId(token: string, kind: CodexOAuthTokenKind): Promise<string | undefined> {
  try {
    const payload =
      kind === "access"
        ? (
            await jwtVerify(token, CODEX_OAUTH_JWKS, {
              issuer: CODEX_OAUTH_ISSUER,
              algorithms: ["RS256"],
              audience: CODEX_OAUTH_API_AUDIENCE,
            })
          ).payload
        : await (async () => {
            const verified = await compactVerify(token, CODEX_OAUTH_JWKS);
            if (verified.protectedHeader.alg !== "RS256") return null;
            const decoded = asObject(JSON.parse(Buffer.from(verified.payload).toString("utf8")));
            return decoded?.iss === CODEX_OAUTH_ISSUER ? decoded : null;
          })();
    if (!payload) return undefined;
    if (kind === "id" && !hasAudience(payload, CODEX_OAUTH_CLIENT_ID)) return undefined;
    if (kind === "id" && payload.azp !== undefined && payload.azp !== CODEX_OAUTH_CLIENT_ID) return undefined;
    if (kind === "id" && Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== CODEX_OAUTH_CLIENT_ID)
      return undefined;
    if (kind === "access" && payload.client_id !== CODEX_OAUTH_CLIENT_ID) return undefined;
    const claims = payload ? asObject(payload["https://api.openai.com/auth"]) : null;
    return typeof claims?.chatgpt_account_id === "string" && claims.chatgpt_account_id
      ? claims.chatgpt_account_id
      : undefined;
  } catch {
    return undefined;
  }
}

function readJsonFile(path: string): JsonObject | null {
  try {
    return asObject(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

export function codexAuthFileForEnv(env: NodeJS.ProcessEnv, includeDefault = false): string | undefined {
  const explicit = env.CODEX_AUTH_FILE?.trim();
  if (explicit) return expandPath(explicit);
  if (!includeDefault) return undefined;
  const codexHome = env.CODEX_HOME?.trim();
  if (codexHome) return join(expandPath(codexHome), "auth.json");
  const home = env.HOME?.trim();
  return home ? join(expandPath(home), ".codex", "auth.json") : undefined;
}

function isCodexOAuthAuth(value: unknown): value is JsonObject {
  const auth = asObject(value);
  if (!auth || typeof auth.auth_mode !== "string" || !CODEX_OAUTH_MODES.has(auth.auth_mode)) return false;
  const tokens = asObject(auth.tokens);
  return Boolean(
    tokens &&
    typeof tokens.access_token === "string" &&
    tokens.access_token &&
    typeof tokens.refresh_token === "string" &&
    tokens.refresh_token &&
    codexOAuthAccountId(auth),
  );
}

export function readCodexOAuthAuthFile(path: string): JsonObject | null {
  try {
    if (statSync(path).mode & 0o077) return null;
  } catch {
    return null;
  }
  const auth = readJsonFile(path);
  return isCodexOAuthAuth(auth) ? auth : null;
}

export function parseCodexOAuthAuth(value: unknown): CodexOAuthAuth | null {
  return isCodexOAuthAuth(value) ? sanitizedCodexOAuthAuth(value) : null;
}

export async function verifyCodexOAuthAuth(value: unknown): Promise<CodexOAuthAuth | null> {
  const auth = parseCodexOAuthAuth(value);
  if (!auth) return null;
  const tokens = asObject(auth.tokens);
  const idToken = typeof tokens?.id_token === "string" ? tokens.id_token : undefined;
  const accountId = codexOAuthAccountId(auth);
  if (!idToken || !accountId || (await verifiedCodexOAuthJwtAccountId(idToken, "id")) !== accountId) return null;
  const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : undefined;
  if (
    !accessToken ||
    !isCodexOAuthJwt(accessToken) ||
    (await verifiedCodexOAuthJwtAccountId(accessToken, "access")) !== accountId
  )
    return null;
  return auth;
}

export function sanitizedCodexOAuthAuth(auth: JsonObject): JsonObject {
  const copy: JsonObject = {};
  for (const key of ["auth_mode", "last_refresh", "tokens"] as const) {
    if (key === "tokens") {
      const tokens = asObject(auth.tokens);
      if (tokens) {
        copy.tokens = Object.fromEntries(
          ["access_token", "refresh_token", "id_token", "account_id"].flatMap((token) =>
            typeof tokens[token] === "string" ? [[token, tokens[token]]] : [],
          ),
        );
      }
    } else if (key in auth) copy[key] = auth[key];
  }
  return copy;
}

export function codexOAuthRefreshToken(value: unknown): string | undefined {
  const auth = asObject(value);
  const tokens = auth ? asObject(auth.tokens) : null;
  return typeof tokens?.refresh_token === "string" && tokens.refresh_token ? tokens.refresh_token : undefined;
}

export function codexOAuthAccessToken(value: unknown): string | undefined {
  const auth = asObject(value);
  const tokens = auth ? asObject(auth.tokens) : null;
  return typeof tokens?.access_token === "string" && tokens.access_token ? tokens.access_token : undefined;
}

function writeJsonAtomically(path: string, value: JsonObject): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.qm-codex-auth-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writeCodexOAuthAuthFile(path: string, value: CodexOAuthAuth): void {
  writeJsonAtomically(path, sanitizedCodexOAuthAuth(value));
}

function lockPath(sourcePath: string): string {
  return `${sourcePath}.lock`;
}

export interface CodexOAuthAuthLock {
  path: string;
  isHeld(): boolean;
  release(): Promise<void>;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code !== "ESRCH");
  }
}

function removeStaleLock(path: string): boolean {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
    const owner = Number(contents.trim().split(":", 1)[0]);
    if (Number.isInteger(owner) && owner > 0) {
      if (owner === process.pid && heldOAuthLockPaths.has(path)) return false;
      if (owner === process.pid) {
        if (Date.now() - statSync(path).mtimeMs <= 60_000) return false;
      } else if (processAlive(owner)) return false;
    } else if (Date.now() - statSync(path).mtimeMs <= 60_000) return false;
  } catch {
    return true;
  }
  const detached = `${path}.stale-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(path, detached);
  } catch {
    return true;
  }
  try {
    if (readFileSync(detached, "utf8") !== contents) {
      if (!existsSync(path)) renameSync(detached, path);
      return false;
    }
    unlinkSync(detached);
    return true;
  } catch {
    if (!existsSync(path)) {
      try {
        renameSync(detached, path);
      } catch (error) {
        swallow("codex: stale lock restore", error);
      }
    }
    return true;
  }
}

export async function acquireCodexOAuthAuthLock(
  sourcePath: string,
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<CodexOAuthAuthLock> {
  const path = lockPath(sourcePath);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Codex OAuth auth lock acquisition cancelled");
    try {
      const handle = await openFile(path, "wx", 0o600);
      const owner = `${process.pid}:${randomBytes(8).toString("hex")}`;
      try {
        await handle.writeFile(owner);
        heldOAuthLockPaths.add(path);
      } catch (error) {
        await handle.close().catch(() => undefined);
        try {
          unlinkSync(path);
        } catch (cleanupError) {
          swallow("codex: oauth lock creation cleanup", cleanupError);
        }
        throw error;
      }
      let released = false;
      return {
        path,
        isHeld() {
          if (released) return false;
          try {
            return readFileSync(path, "utf8") === owner;
          } catch {
            return false;
          }
        },
        async release() {
          if (released) return;
          released = true;
          await handle.close().catch(() => undefined);
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              if (readFileSync(path, "utf8") !== owner) {
                heldOAuthLockPaths.delete(path);
                return;
              }
              unlinkSync(path);
              heldOAuthLockPaths.delete(path);
              return;
            } catch (error) {
              if (attempt === 2) {
                heldOAuthLockPaths.delete(path);
                throw error;
              } else await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
            }
          }
        },
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw error;
      removeStaleLock(path);
      await new Promise<void>((resolveWait) => {
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolveWait();
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolveWait();
        }, 100);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
  throw new Error("timed out acquiring the Codex OAuth auth lock");
}

type SyncLock = { fd: number; owner: string };

function lockFile(sourcePath: string): SyncLock {
  const path = lockPath(sourcePath);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      const owner = `${process.pid}:${randomBytes(8).toString("hex")}`;
      try {
        writeSync(fd, owner);
        heldOAuthLockPaths.add(path);
      } catch (error) {
        closeSync(fd);
        try {
          unlinkSync(path);
        } catch (cleanupError) {
          swallow("codex: oauth lock creation cleanup", cleanupError);
        }
        throw error;
      }
      return { fd, owner };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw error;
      removeStaleLock(path);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  throw new Error("timed out acquiring the Codex OAuth auth lock");
}

export async function syncCodexOAuthAuthFile(
  sourcePath: string | undefined,
  childPath: string,
  heldLockPath?: string,
  expectedRefreshToken?: string,
  expectedAccessToken?: string,
  expectedSourceAuth?: JsonObject,
  verifyToken: CodexOAuthTokenVerifier = verifiedCodexOAuthJwtAccountId,
): Promise<boolean> {
  if (!sourcePath) return true;
  const child = readCodexOAuthAuthFile(childPath);
  if (!child) return false;
  const lock = heldLockPath ? undefined : lockFile(sourcePath);
  let result: boolean;
  let cleanupError: unknown;
  try {
    result = await (async () => {
      const source = readJsonFile(sourcePath);
      if (!source) return false;
      if (source.auth_mode !== child.auth_mode) return false;
      const sourceTokens = asObject(source.tokens);
      const childTokens = asObject(child.tokens);
      const sourceAccountId = codexOAuthAccountId(source);
      const childAccountId = codexOAuthAccountId(child);
      const sourceDeclaredAccountId =
        typeof sourceTokens?.account_id === "string" ? sourceTokens.account_id : undefined;
      const childDeclaredAccountId = typeof childTokens?.account_id === "string" ? childTokens.account_id : undefined;
      const sourceAccessToken = typeof sourceTokens?.access_token === "string" ? sourceTokens.access_token : undefined;
      const childAccessToken = typeof childTokens?.access_token === "string" ? childTokens.access_token : undefined;
      const sourceAccessAccountId = codexOAuthJwtAccountIdFromToken(sourceAccessToken);
      if (
        !sourceTokens ||
        !childTokens ||
        typeof sourceTokens.id_token !== "string" ||
        typeof childTokens.id_token !== "string" ||
        !sourceAccountId ||
        sourceAccountId !== childAccountId ||
        (sourceDeclaredAccountId && sourceDeclaredAccountId !== sourceAccountId) ||
        (childDeclaredAccountId && childDeclaredAccountId !== sourceAccountId) ||
        (isCodexOAuthJwt(sourceAccessToken) && sourceAccessAccountId !== sourceAccountId)
      )
        return false;
      if (expectedSourceAuth && JSON.stringify(source) !== JSON.stringify(expectedSourceAuth)) return false;
      if (expectedRefreshToken && codexOAuthRefreshToken(source) !== expectedRefreshToken) return false;
      if (expectedAccessToken && codexOAuthAccessToken(source) !== expectedAccessToken) return false;
      const sourceRefreshToken = codexOAuthRefreshToken(source);
      const childRefreshToken = codexOAuthRefreshToken(child);
      const tokensChanged =
        childRefreshToken !== sourceRefreshToken ||
        childTokens.id_token !== sourceTokens.id_token ||
        childAccessToken !== sourceAccessToken;
      if (tokensChanged) {
        if (!childAccessToken || !isCodexOAuthJwt(childAccessToken)) return false;
        const [verifiedIdAccount, verifiedAccessAccount] = await Promise.all([
          verifyToken(childTokens.id_token, "id"),
          verifyToken(childAccessToken, "access"),
        ]);
        if (verifiedIdAccount !== sourceAccountId || verifiedAccessAccount !== sourceAccountId) return false;
      }
      const sanitized = sanitizedCodexOAuthAuth(child);
      const next = {
        ...source,
        ...sanitized,
        ...(childTokens
          ? {
              tokens: {
                ...sourceTokens,
                ...childTokens,
                ...(typeof sourceTokens.account_id === "string" ? { account_id: sourceTokens.account_id } : {}),
              },
            }
          : {}),
      };
      if (JSON.stringify(next) === JSON.stringify(source)) return true;
      writeJsonAtomically(sourcePath, next);
      return true;
    })();
  } finally {
    if (lock !== undefined) {
      const path = lockPath(sourcePath);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          if (readFileSync(path, "utf8") !== lock.owner) break;
          unlinkSync(path);
          heldOAuthLockPaths.delete(path);
          break;
        } catch (error) {
          if (attempt === 2) cleanupError = error;
        }
      }
      try {
        closeSync(lock.fd);
      } catch (error) {
        cleanupError ??= error;
      }
      heldOAuthLockPaths.delete(path);
    }
  }
  if (cleanupError) throw cleanupError;
  return result;
}
