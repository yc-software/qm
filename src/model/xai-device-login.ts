import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret, type SecretKey } from "../connectors/connector-client-store.ts";
import { GROK_VERSION } from "../grok-build.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { UserOAuthTokens } from "./user-model-credential-store.ts";

const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const XAI_SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write";
const SLOW_DOWN_MS = 5_000;
const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_DEVICE_TTL_MS = 60 * 60 * 1_000;
const MAX_POLL_INTERVAL_MS = 60_000;
const MAX_TOKEN_TTL_MS = DEFAULT_TOKEN_TTL_MS;
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1_024;
const XAI_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
  "x-grok-client-version": GROK_VERSION,
  "x-grok-client-surface": "ui",
} as const;

interface XaiDevicePrompt {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresAt: number;
}

type XaiDevicePollResult =
  | { status: "pending" | "slow_down"; intervalMs: number }
  | { status: "denied" | "expired" }
  | { status: "connected"; tokens: UserOAuthTokens };

export interface StoredXaiDeviceLogin {
  deviceAuthId: string;
  deviceCodeEnc: string;
  expiresAt: number;
  intervalMs: number;
  nextPollAt: number;
}

export interface XaiDeviceLoginStore {
  start(principalId: string): Promise<XaiDevicePrompt>;
  poll(principalId: string, deviceAuthId: string): Promise<XaiDevicePollResult>;
  cancel(principalId: string, deviceAuthId?: string): Promise<void>;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number | string;
  error?: string;
}

function form(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values);
}

function boundedSeconds(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
}

function absoluteExpiry(value: number | string | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0)
    return value < 10_000_000_000 ? value * 1_000 : value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function oauthExpiry(raw: TokenResponse, now: number): number {
  const max = now + MAX_TOKEN_TTL_MS;
  const expiresIn = boundedSeconds(raw.expires_in, 0, MAX_TOKEN_TTL_MS / 1_000);
  if (expiresIn) return now + expiresIn * 1_000;
  return Math.min(absoluteExpiry(raw.expires_at) ?? max, max);
}

function verificationUrl(raw: {
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
}): string {
  const value = raw.verification_uri_complete ?? raw.verification_uri ?? "";
  try {
    const url = new URL(value);
    const query = [...url.searchParams.entries()];
    if (
      url.origin !== "https://accounts.x.ai" ||
      url.pathname !== "/oauth2/device" ||
      url.username ||
      url.password ||
      url.hash ||
      query.length > 1 ||
      (query.length === 1 && (query[0]![0] !== "user_code" || query[0]![1] !== raw.user_code))
    )
      throw new Error("origin");
    return url.href;
  } catch {
    throw new Error("xAI device authorization returned an invalid verification URL");
  }
}

async function oauthJson<T>(response: Response, invalidMessage: string): Promise<T> {
  if (!response.body) throw new Error(invalidMessage);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_OAUTH_RESPONSE_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw new Error(`xAI OAuth response exceeds ${MAX_OAUTH_RESPONSE_BYTES} bytes`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_OAUTH_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`xAI OAuth response exceeds ${MAX_OAUTH_RESPONSE_BYTES} bytes`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(invalidMessage);
  }
}

function tokenJson(response: Response): Promise<TokenResponse> {
  return oauthJson(response, `xAI OAuth returned an invalid response (${response.status})`);
}

export async function refreshXaiTokens(
  refreshToken: string,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<UserOAuthTokens> {
  const response = await fetcher(XAI_TOKEN_URL, {
    method: "POST",
    headers: XAI_HEADERS,
    body: form({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: XAI_CLIENT_ID }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await tokenJson(response);
  if (!response.ok) throw new Error(`xAI refresh failed (${response.status}${raw.error ? `: ${raw.error}` : ""})`);
  if (!raw.access_token) throw new Error("xAI refresh missing access_token");
  const expiresAt = oauthExpiry(raw, now());
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? refreshToken,
    expiresAt,
  };
}

export function createXaiDeviceLoginStore(input: {
  backing: DurableMap<StoredXaiDeviceLogin>;
  key: SecretKey;
  fetcher?: typeof fetch;
  now?: () => number;
  id?: () => string;
}): XaiDeviceLoginStore {
  const backing = input.backing;
  const key = input.key;
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? Date.now;
  const id = input.id ?? randomUUID;
  const update = backing.update;
  const deleteIf = backing.deleteIf;
  if (!update || !deleteIf) throw new Error("xAI device login store requires atomic mutations");

  return {
    async start(principalId) {
      const response = await fetcher(XAI_DEVICE_URL, {
        method: "POST",
        headers: XAI_HEADERS,
        body: form({ client_id: XAI_CLIENT_ID, scope: XAI_SCOPE, referrer: "grok-build" }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      const raw = await oauthJson<{
        device_code?: string;
        user_code?: string;
        verification_uri?: string;
        verification_uri_complete?: string;
        expires_in?: number;
        interval?: number;
      }>(response, `xAI device authorization returned an invalid response (${response.status})`);
      if (!response.ok) throw new Error(`xAI device authorization failed (${response.status})`);
      if (!raw.device_code || !raw.user_code || !raw.verification_uri)
        throw new Error("xAI device authorization response is incomplete");
      if (!/^[A-Za-z0-9-]+$/.test(raw.user_code))
        throw new Error("xAI device authorization returned an invalid user code");
      const at = now();
      const intervalMs = Math.max(1_000, boundedSeconds(raw.interval, 5, MAX_POLL_INTERVAL_MS / 1_000) * 1_000);
      const expiresAt = at + boundedSeconds(raw.expires_in, 600, MAX_DEVICE_TTL_MS / 1_000) * 1_000;
      const deviceAuthId = id();
      await backing.put(principalId, {
        deviceAuthId,
        deviceCodeEnc: encryptSecret(raw.device_code, key),
        expiresAt,
        intervalMs,
        nextPollAt: at + intervalMs,
      });
      return {
        deviceAuthId,
        userCode: raw.user_code,
        verificationUrl: verificationUrl(raw),
        intervalMs,
        expiresAt,
      };
    },

    async poll(principalId, deviceAuthId) {
      const at = now();
      const login = await backing.get(principalId);
      if (!login || login.deviceAuthId !== deviceAuthId) return { status: "expired" };
      if (login.expiresAt <= at) {
        await deleteIf(principalId, (current) => current.deviceAuthId === deviceAuthId && current.expiresAt <= at);
        return { status: "expired" };
      }
      let claimed = false;
      const current = await update(principalId, (stored) => {
        if (stored.deviceAuthId !== deviceAuthId || stored.expiresAt <= at || stored.nextPollAt > at) return stored;
        claimed = true;
        return { ...stored, nextPollAt: at + stored.intervalMs };
      });
      if (!current || current.deviceAuthId !== deviceAuthId) return { status: "expired" };
      if (!claimed) return { status: "pending", intervalMs: Math.max(current.nextPollAt - at, current.intervalMs) };
      const response = await fetcher(XAI_TOKEN_URL, {
        method: "POST",
        headers: XAI_HEADERS,
        body: form({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: decryptSecret(current.deviceCodeEnc, key),
          client_id: XAI_CLIENT_ID,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      const raw = await tokenJson(response);
      if (response.ok) {
        if (!raw.access_token) throw new Error("xAI token response missing access_token");
        if (!(await deleteIf(principalId, (stored) => stored.deviceAuthId === deviceAuthId)))
          return { status: "expired" };
        const expiresAt = oauthExpiry(raw, now());
        return {
          status: "connected",
          tokens: {
            accessToken: raw.access_token,
            ...(raw.refresh_token ? { refreshToken: raw.refresh_token } : {}),
            expiresAt,
          },
        };
      }
      if (raw.error === "authorization_pending") {
        const latest = await backing.get(principalId);
        return latest?.deviceAuthId === deviceAuthId
          ? { status: "pending", intervalMs: latest.intervalMs }
          : { status: "expired" };
      }
      if (raw.error === "slow_down") {
        let intervalMs = current.intervalMs;
        let slowed = false;
        await update(principalId, (stored) => {
          if (stored.deviceAuthId !== deviceAuthId) return stored;
          intervalMs = Math.min(Math.max(stored.intervalMs, current.intervalMs) + SLOW_DOWN_MS, MAX_POLL_INTERVAL_MS);
          slowed = true;
          return { ...stored, intervalMs, nextPollAt: Math.max(stored.nextPollAt, now() + intervalMs) };
        });
        return slowed ? { status: "slow_down", intervalMs } : { status: "expired" };
      }
      if (raw.error === "access_denied") {
        return (await deleteIf(principalId, (stored) => stored.deviceAuthId === deviceAuthId))
          ? { status: "denied" }
          : { status: "expired" };
      }
      if (raw.error === "expired_token") {
        await deleteIf(principalId, (stored) => stored.deviceAuthId === deviceAuthId);
        return { status: "expired" };
      }
      if ((await backing.get(principalId))?.deviceAuthId !== deviceAuthId) return { status: "expired" };
      throw new Error(`xAI device token exchange failed (${response.status}${raw.error ? `: ${raw.error}` : ""})`);
    },

    async cancel(principalId, deviceAuthId) {
      await deleteIf(principalId, (stored) => deviceAuthId === undefined || stored.deviceAuthId === deviceAuthId);
    },
  };
}
