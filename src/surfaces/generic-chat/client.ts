import { trimTrailingSlashes } from "../../util/text.ts";
import { publicFetch } from "../../util/network.ts";
import { z } from "zod";
import {
  ACCOUNT_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  parseGenericChatAccount,
  signGenericChatRequest,
} from "./protocol.ts";

const REQUEST_TIMEOUT_MS = 15_000;
export const GENERIC_CHAT_CLAIM_MS = 4 * REQUEST_TIMEOUT_MS;

export const genericChatOriginOAuthSchema = z.object({
  tokenUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.search;
  }),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scope: z.string().min(1),
});

export type GenericChatOriginOAuth = z.infer<typeof genericChatOriginOAuthSchema>;

export class GenericChatHttpError extends Error {
  readonly status: number;
  constructor(status: number, reason: string) {
    super(`generic-chat ${status}: ${reason}`);
    this.status = status;
  }
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export type GenericChatClient = ReturnType<typeof createGenericChatClient>;

export function createGenericChatClient(deps: {
  url: string;
  secret: string;
  allowedOrigins?: readonly string[];
  originOAuth?: GenericChatOriginOAuth;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const base = trimTrailingSlashes(deps.url);
  const send = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let accessToken: { value: string; expiresAt: number } | undefined;
  let pendingToken: Promise<string> | undefined;

  async function originAccessToken(): Promise<string> {
    if (accessToken && accessToken.expiresAt > now() + REQUEST_TIMEOUT_MS) return accessToken.value;
    if (pendingToken) return pendingToken;
    const oauth = genericChatOriginOAuthSchema.parse(deps.originOAuth);
    const requestedAt = now();
    pendingToken = (async () => {
      const response = await (deps.fetch ?? publicFetch)(oauth.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: oauth.clientId,
          client_secret: oauth.clientSecret,
          scope: oauth.scope,
        }).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      if (!response.ok) {
        console.error(`generic-chat token endpoint returned ${response.status}: ${text}`);
        throw new Error(`generic-chat origin authentication failed (HTTP ${response.status})`);
      }
      const token = parseJson(text);
      if (
        typeof token.access_token !== "string" ||
        !token.access_token ||
        typeof token.token_type !== "string" ||
        token.token_type.toLowerCase() !== "bearer" ||
        typeof token.expires_in !== "number" ||
        !Number.isFinite(token.expires_in) ||
        requestedAt + token.expires_in * 1000 <= now() + REQUEST_TIMEOUT_MS
      ) {
        console.error("generic-chat token response failed validation", {
          hasAccessToken: typeof token.access_token === "string" && Boolean(token.access_token),
          hasBearerType: typeof token.token_type === "string" && token.token_type.toLowerCase() === "bearer",
          hasUsableLifetime:
            typeof token.expires_in === "number" &&
            Number.isFinite(token.expires_in) &&
            requestedAt + token.expires_in * 1000 > now() + REQUEST_TIMEOUT_MS,
        });
        throw new Error("generic-chat invalid origin access token response");
      }
      accessToken = { value: token.access_token, expiresAt: requestedAt + token.expires_in * 1000 };
      return accessToken.value;
    })();
    try {
      return await pendingToken;
    } finally {
      pendingToken = undefined;
    }
  }
  const allowedOrigins = (deps.allowedOrigins ?? []).map((origin) => {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.origin !== origin ||
      url.username ||
      url.password ||
      (url.hostname.includes("*") && (!url.hostname.startsWith("*.") || url.hostname.slice(2).includes("*")))
    )
      throw new Error(
        "Generic chat allowed origins must be HTTPS origins, with an optional leading wildcard subdomain",
      );
    return url;
  });

  function acceptsOrigin(origin: string): boolean {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) return false;
    return allowedOrigins.some((pattern) => {
      return (
        pattern.protocol === url.protocol &&
        pattern.port === url.port &&
        (pattern.origin === origin ||
          (pattern.hostname.startsWith("*.") && url.hostname.endsWith(pattern.hostname.slice(1))))
      );
    });
  }

  async function call(
    account: string,
    path: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const source = parseGenericChatAccount(account);
    if (!source || (source.origin && !acceptsOrigin(source.origin)))
      throw new GenericChatHttpError(403, "unsupported origin");
    const authorization = source.origin && deps.originOAuth ? `Bearer ${await originAccessToken()}` : undefined;
    const body = JSON.stringify({ ...payload, ...(source.origin ? { origin: source.origin } : {}) });
    const timestamp = String(Math.floor(now() / 1000));
    const request = source.origin ? (deps.fetch ?? publicFetch) : send;
    const res = await request(`${source.origin ?? base}${path}`, {
      method: "POST",
      headers: {
        ...(authorization ? { authorization } : {}),
        "content-type": "application/json",
        [ACCOUNT_HEADER]: source.id,
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: signGenericChatRequest(deps.secret, timestamp, source.id, path, body),
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(source.origin ? { redirect: "error" as const } : {}),
    });
    const reply = await res.text();
    const parsed = parseJson(reply);
    if (!res.ok)
      throw new GenericChatHttpError(
        res.status,
        typeof parsed.error === "string" ? parsed.error : reply.slice(0, 200) || res.statusText,
      );
    return parsed;
  }

  return { call, acceptsOrigin };
}
