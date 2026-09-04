import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type JsonObject = Record<string, unknown>;

const CODEX_OAUTH_MODES = new Set(["chatgpt", "chatgptAuthTokens"]);
export const CODEX_OAUTH_ISSUER = "https://auth.openai.com";

export function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

export function codexOAuthJwtAccountIdFromToken(value: unknown): string | undefined {
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

export function codexOAuthJwtAccountId(value: unknown): string | undefined {
  const auth = asObject(value);
  const tokens = auth ? asObject(auth.tokens) : null;
  return codexOAuthJwtAccountIdFromToken(tokens?.id_token);
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
    codexOAuthJwtAccountId(auth),
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
