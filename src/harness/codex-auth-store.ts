import { CODEX_OAUTH_ISSUER, asObject, codexOAuthJwtAccountId, type JsonObject } from "./codex-auth-file.ts";
import { codexOAuthRefreshToken, readCodexOAuthAuthFile, sanitizedCodexOAuthAuth } from "./codex-auth-file.ts";
import type { CredentialFile, Keychain } from "../credentials/keychain.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import { createMemoryAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
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
  load(options?: { forceRefresh?: boolean }): Promise<JsonObject | null>;
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
      refresh_token: "",
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
    sanitized.tokens = { ...rest, refresh_token: "" };
  }
  return sanitized;
}

async function refreshCodexOAuth(auth: JsonObject, fetchImpl: typeof fetch): Promise<JsonObject | null> {
  const refreshToken = codexOAuthRefreshToken(auth);
  if (!refreshToken) return null;
  const response = await fetchImpl(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    signal: AbortSignal.timeout(8_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email",
    }),
  });
  if (!response.ok) {
    const body = asObject(await response.json().catch(() => null));
    const code = asObject(body?.error)?.code;
    const known = ["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated", "invalid_grant"];
    const detail = typeof code === "string" && known.includes(code) ? ` (${code})` : "";
    const message = `ChatGPT credential renewal failed: HTTP ${response.status}${detail}`;
    if (response.status === 400 || response.status === 401)
      throw new NonRetryableTurnError(`${message}. Reconnect the credential's owning ChatGPT account.`);
    throw new Error(message);
  }
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
  if (!codexOAuthAuthFromValue(next) || codexOAuthJwtAccountId(next) !== codexOAuthJwtAccountId(auth))
    throw new NonRetryableTurnError("ChatGPT credential renewal returned a different account or invalid credentials");
  return next;
}

function authNeedsRefresh(auth: JsonObject, now: number): boolean {
  const expiresAt = codexOAuthAccessTokenExpiresAt(auth);
  return typeof expiresAt === "number" && expiresAt - now < REFRESH_SKEW_MS;
}

interface KeychainCodexAuthStoreDeps {
  keychain: Keychain;
  /** Keychain credential id of the user's Codex ChatGPT login (a file credential holding auth.json). */
  credentialId: string;
  advisoryLock?: AdvisoryLock;
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
  const lock = deps.advisoryLock ?? createMemoryAdvisoryLock();

  const readCurrent = async () => {
    const meta = await deps.keychain.getCredential(deps.credentialId);
    if (!meta || meta.kind !== "file") return null;
    const bundles = await deps.keychain.materializeOwnFiles(meta.ownerId);
    const bundle = bundles.find((candidate) => candidate.credentialId === deps.credentialId);
    if (!bundle) return null;
    const found = codexAuthFromFiles(bundle.files);
    return found ? { meta: bundle.metadata, files: bundle.files, ...found } : null;
  };

  return {
    description: `keychain credential ${deps.credentialId}`,
    async load(options): Promise<JsonObject | null> {
      const observed = await readCurrent();
      if (!observed) return null;
      if (!options?.forceRefresh && !authNeedsRefresh(observed.auth, now())) return observed.auth;
      return lock.withLock(`credential-refresh:${deps.credentialId}`, async () => {
        const current = await readCurrent();
        if (!current) return null;
        if (
          codexOAuthRefreshToken(current.auth) !== codexOAuthRefreshToken(observed.auth) &&
          !authNeedsRefresh(current.auth, now())
        ) return current.auth;
        if (!options?.forceRefresh && !authNeedsRefresh(current.auth, now())) return current.auth;
        const next = await refreshCodexOAuth(current.auth, fetchImpl);
        if (!next) return null;
        try {
          await deps.keychain.save({
            ownerId: current.meta.ownerId,
            service: current.meta.service,
            host: current.meta.host,
            accountLabel: current.meta.accountLabel,
            origin: current.meta.origin,
            expectedFingerprint: current.meta.fingerprint,
            files: current.files.map((file) =>
              file.path === current.path
                ? { ...file, contentBase64: Buffer.from(JSON.stringify(next), "utf8").toString("base64") }
                : file,
            ),
            expiresAt: codexOAuthAccessTokenExpiresAt(next),
          });
        } catch (error) {
          if ((error as { status?: number }).status !== 409) throw error;
          const replacement = await readCurrent();
          if (!replacement) return null;
          if (authNeedsRefresh(replacement.auth, now()))
            throw new Error("Codex credential changed and needs renewal", { cause: error });
          return replacement.auth;
        }
        return next;
      });
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
  return {
    description: `auth file ${path}`,
    async load(options): Promise<JsonObject | null> {
      const observed = readCodexOAuthAuthFile(path);
      if (!observed) return null;
      if (!options?.forceRefresh && !authNeedsRefresh(observed, now())) return observed;
      const lock = await acquireCodexOAuthAuthLock(path, undefined, 10_000, 25);
      try {
        const current = readCodexOAuthAuthFile(path);
        if (!current) return null;
        if (
          codexOAuthRefreshToken(current) !== codexOAuthRefreshToken(observed) &&
          !authNeedsRefresh(current, now())
        ) return current;
        if (!options?.forceRefresh && !authNeedsRefresh(current, now())) return current;
        const next = await refreshCodexOAuth(current, fetchImpl);
        if (!next) return null;
        writeCodexOAuthAuthFile(path, next);
        return next;
      } finally {
        await lock.release();
      }
    },
  };
}
