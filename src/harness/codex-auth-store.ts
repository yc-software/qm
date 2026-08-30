import { CODEX_OAUTH_ISSUER, asObject, codexOAuthJwtAccountId, type JsonObject } from "./codex-auth-file.ts";
import { codexOAuthRefreshToken, readCodexOAuthAuthFile, sanitizedCodexOAuthAuth } from "./codex-auth-file.ts";
import type { CredentialFile, Keychain } from "../credentials/keychain.ts";
import { swallow } from "../util/errors.ts";
import { acquireCodexOAuthAuthLock, writeCodexOAuthAuthFile } from "./codex-auth.ts";

/**
 * A CodexAuthStore is the custodian of a ChatGPT-subscription Codex login.
 *
 * The store — not the harness, and never the child process — owns the
 * refresh token and the refresh loop. `load()` returns auth that is fresh
 * enough to hand to a child; the store refreshes centrally (and persists the
 * rotated tokens back to its backing storage) before returning when the
 * access token is near expiry. Children receive derived, ephemeral material
 * only (see `childCodexOAuthAuth`), so nothing a child does can rotate or
 * leak the long-lived credential.
 */
export interface CodexAuthStore {
  /** Where the credential lives, for logs and errors. Never includes secrets. */
  readonly description: string;
  /** Current auth, centrally refreshed when the access token is stale. Null when unavailable. */
  load(): Promise<JsonObject | null>;
}

/** The Codex CLI's public OAuth client id (auth.openai.com device/PKCE client). */
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Refresh when the access token has less than this long to live. */
const REFRESH_SKEW_MS = 5 * 60_000;

const CODEX_AUTH_FILE_PATHS = [".codex/auth.json", "codex/auth.json"];

function jwtExpiryMs(token: unknown): number | undefined {
  if (typeof token !== "string" || token.split(".").length !== 3) return undefined;
  try {
    const payload = asObject(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
    return typeof payload?.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Epoch ms when this auth's access token expires, if it carries an exp claim. */
export function codexOAuthAccessTokenExpiresAt(auth: JsonObject | null): number | undefined {
  return jwtExpiryMs(asObject(auth?.tokens)?.access_token);
}

/** Validate an already-parsed auth.json value the same way readCodexOAuthAuthFile validates a file. */
export function codexOAuthAuthFromValue(value: unknown): JsonObject | null {
  const auth = asObject(value);
  if (!auth) return null;
  const tokens = asObject(auth.tokens);
  const mode = typeof auth.auth_mode === "string" ? auth.auth_mode : "";
  if (!["chatgpt", "chatgptAuthTokens"].includes(mode)) return null;
  if (
    !tokens ||
    typeof tokens.access_token !== "string" ||
    !tokens.access_token ||
    typeof tokens.refresh_token !== "string" ||
    !tokens.refresh_token ||
    !codexOAuthJwtAccountId(auth)
  )
    return null;
  return auth;
}

/**
 * The material a Codex child process receives: the sanitized auth WITHOUT the
 * refresh token. The child can use the access token until it expires; only the
 * store may refresh. The next turn's `load()` re-materializes fresh tokens.
 */
/**
 * Child auth.json built straight from derived per-turn material (no refresh
 * token ever existed in this shape). Returns null unless the id/access token
 * carries a trusted ChatGPT account claim.
 */
export function childCodexAuthFromDerived(derived: {
  accessToken: string;
  idToken: string;
  accountId?: string;
}): JsonObject | null {
  const auth: JsonObject = {
    auth_mode: "chatgpt",
    tokens: {
      access_token: derived.accessToken,
      id_token: derived.idToken,
      ...(derived.accountId ? { account_id: derived.accountId } : {}),
    },
  };
  if (!derived.accessToken || !codexOAuthJwtAccountId(auth)) return null;
  return auth;
}

export function childCodexOAuthAuth(auth: JsonObject): JsonObject {
  const sanitized = sanitizedCodexOAuthAuth(auth);
  const tokens = asObject(sanitized.tokens);
  if (tokens) {
    const { refresh_token: _refresh, ...rest } = tokens;
    sanitized.tokens = rest;
  }
  return sanitized;
}

async function refreshCodexOAuth(auth: JsonObject, fetchImpl: typeof fetch): Promise<JsonObject | null> {
  const refreshToken = codexOAuthRefreshToken(auth);
  if (!refreshToken) return null;
  const response = await fetchImpl(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email",
    }),
  });
  if (!response.ok) throw new Error(`Codex OAuth refresh failed: HTTP ${response.status}`);
  const body = asObject(await response.json().catch(() => null));
  if (!body || typeof body.access_token !== "string" || !body.access_token) {
    throw new Error("Codex OAuth refresh returned no access token");
  }
  const tokens = asObject(auth.tokens) ?? {};
  const next: JsonObject = {
    ...auth,
    last_refresh: new Date().toISOString(),
    tokens: {
      ...tokens,
      access_token: body.access_token,
      ...(typeof body.id_token === "string" && body.id_token ? { id_token: body.id_token } : {}),
      ...(typeof body.refresh_token === "string" && body.refresh_token ? { refresh_token: body.refresh_token } : {}),
    },
  };
  // The refreshed identity must stay on the same ChatGPT account.
  return codexOAuthAuthFromValue(next) && codexOAuthJwtAccountId(next) === codexOAuthJwtAccountId(auth) ? next : null;
}

function authNeedsRefresh(auth: JsonObject, now: number): boolean {
  const expiresAt = codexOAuthAccessTokenExpiresAt(auth);
  return typeof expiresAt === "number" && expiresAt - now < REFRESH_SKEW_MS;
}

interface KeychainCodexAuthStoreDeps {
  keychain: Keychain;
  /** Keychain credential id of the user's Codex ChatGPT login (a file credential holding auth.json). */
  credentialId: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function codexAuthFromFiles(files: CredentialFile[]): { path: string; auth: JsonObject } | null {
  for (const file of files) {
    const normalized = file.path.replace(/^\.\//, "");
    if (!CODEX_AUTH_FILE_PATHS.includes(normalized) && !normalized.endsWith("/auth.json")) continue;
    try {
      const auth = codexOAuthAuthFromValue(JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8")));
      if (auth) return { path: file.path, auth };
    } catch {
      // fall through to the next candidate file
    }
  }
  return null;
}

/**
 * Keychain-backed Codex subscription auth. The credential (a file bundle
 * holding the Codex CLI's auth.json) lives encrypted in its owner's keychain;
 * core is the single writer. Refreshed tokens are persisted back to the
 * keychain with a compare-and-set against the refresh token they replaced, so
 * a concurrent rotation loses cleanly instead of clobbering.
 */
export function keychainCodexAuthStore(deps: KeychainCodexAuthStoreDeps): CodexAuthStore {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  let refreshing: Promise<JsonObject | null> | null = null;

  const readCurrent = async (): Promise<{
    ownerId: string;
    service: string;
    path: string;
    auth: JsonObject;
  } | null> => {
    const meta = await deps.keychain.getCredential(deps.credentialId);
    if (!meta || meta.kind !== "file") return null;
    const bundles = await deps.keychain.materializeOwnFiles(meta.ownerId);
    const bundle = bundles.find((b) => b.credentialId === deps.credentialId);
    if (!bundle) return null;
    const found = codexAuthFromFiles(bundle.files);
    return found ? { ownerId: meta.ownerId, service: meta.service, ...found } : null;
  };

  const persist = async (
    current: { ownerId: string; service: string; path: string },
    replacedRefreshToken: string | undefined,
    next: JsonObject,
  ): Promise<boolean> => {
    // Compare-and-set: re-read and refuse if someone else rotated first.
    const latest = await readCurrent();
    if (!latest || codexOAuthRefreshToken(latest.auth) !== replacedRefreshToken) return false;
    await deps.keychain.save({
      ownerId: current.ownerId,
      service: current.service,
      files: [{ path: current.path, contentBase64: Buffer.from(JSON.stringify(next), "utf8").toString("base64") }],
      ...(codexOAuthAccessTokenExpiresAt(next) !== undefined
        ? { expiresAt: codexOAuthAccessTokenExpiresAt(next) }
        : {}),
    });
    return true;
  };

  return {
    description: `keychain credential ${deps.credentialId}`,
    async load(): Promise<JsonObject | null> {
      const current = await readCurrent();
      if (!current) return null;
      if (!authNeedsRefresh(current.auth, now())) return current.auth;
      // Single refresh in flight per store; concurrent loads share it.
      refreshing ??= (async () => {
        try {
          const next = await refreshCodexOAuth(current.auth, fetchImpl);
          if (!next) return null;
          await persist(current, codexOAuthRefreshToken(current.auth), next);
          return next;
        } finally {
          refreshing = null;
        }
      })();
      try {
        const refreshed = await refreshing;
        if (refreshed) return refreshed;
      } catch (error) {
        swallow("codex: central oauth refresh", error);
      }
      // A stale access token is still worth handing out: the provider decides.
      return (await readCurrent())?.auth ?? current.auth;
    },
  };
}

/**
 * File-backed store for local development: the operator's own
 * ~/.codex/auth.json (or CODEX_AUTH_FILE). Core refreshes centrally and writes
 * the rotated tokens back atomically under the file lock; children never see
 * the refresh token, so no child state ever syncs back.
 */
export function fileCodexAuthStore(
  path: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): CodexAuthStore {
  let refreshing: Promise<JsonObject | null> | null = null;
  return {
    description: `auth file ${path}`,
    async load(): Promise<JsonObject | null> {
      const current = readCodexOAuthAuthFile(path);
      if (!current) return null;
      if (!authNeedsRefresh(current, now())) return current;
      refreshing ??= (async () => {
        try {
          const next = await refreshCodexOAuth(current, fetchImpl);
          if (!next) return null;
          const lock = await acquireCodexOAuthAuthLock(path, undefined, 10_000, 25);
          try {
            const latest = readCodexOAuthAuthFile(path);
            // Compare-and-set: refuse if another process rotated first.
            if (!latest || codexOAuthRefreshToken(latest) !== codexOAuthRefreshToken(current)) return latest;
            writeCodexOAuthAuthFile(path, next);
          } finally {
            await lock.release();
          }
          return next;
        } finally {
          refreshing = null;
        }
      })();
      try {
        const refreshed = await refreshing;
        if (refreshed) return refreshed;
      } catch (error) {
        swallow("codex: file oauth refresh", error);
      }
      return readCodexOAuthAuthFile(path) ?? current;
    },
  };
}
