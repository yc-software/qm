import type { DurableMap } from "../persistence/durable-map.ts";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import { scopeStorageKey } from "../util/scope-storage-key.ts";
import { hashId } from "../util/crypto.ts";
import { parseScopeId, type ScopeId } from "../types.ts";

export const DEFAULT_MEMORABLE_API_URL = "https://memorable-extraction-api.memorable.workers.dev";

const START_TIMEOUT_MS = 10_000;
const POLL_TIMEOUT_MS = 10_000;
const MIN_POLL_INTERVAL_MS = 2_000;
const MAX_FIELD_CHARS = 200;
const MAX_API_KEY_CHARS = 512;

export interface MemorableAccount {
  scopeId: ScopeId;
  apiKeyEnc: string;
  keyId: string;
  orgId: string;
  orgName: string;
  connectedAt: number;
}

export interface PendingConnect {
  scopeId: ScopeId;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  intervalMs: number;
  expiresAt: number;
}

type StartResult =
  | { status: "started"; userCode: string; verificationUri: string; verificationUriComplete: string; expiresAt: number }
  | { status: "already_connected"; orgName: string }
  | { status: "unavailable"; detail: string };

type PollResult =
  | { status: "pending"; userCode: string; verificationUriComplete: string }
  | { status: "connected"; orgId: string; orgName: string; keyId: string }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "none" }
  | { status: "unavailable"; detail: string };

export interface MemorableAccounts {
  start(scope: ScopeId, opts?: { force?: boolean }): Promise<StartResult>;
  poll(scope: ScopeId): Promise<PollResult>;
  keyFor(scope: ScopeId): Promise<string | null>;
  disconnect(scope: ScopeId): Promise<boolean>;
  connected(): Promise<Array<Omit<MemorableAccount, "apiKeyEnc">>>;
}

interface DeviceStartBody {
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  verification_uri_complete?: unknown;
  expires_in?: unknown;
  interval?: unknown;
  error?: unknown;
  detail?: unknown;
}

interface DevicePollBody {
  status?: unknown;
  api_key?: unknown;
  key_id?: unknown;
  org_id?: unknown;
  org_name?: unknown;
}

function str(value: unknown, max = MAX_FIELD_CHARS): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function createMemorableAccounts(
  accounts: DurableMap<MemorableAccount>,
  pending: DurableMap<PendingConnect>,
  opts: { apiUrl?: string; keyMaterial: string | Buffer; now?: () => number; fetchImpl?: typeof fetch },
): MemorableAccounts {
  const apiUrl = (opts.apiUrl || DEFAULT_MEMORABLE_API_URL).replace(/\/$/, "");
  const clock = opts.now ?? (() => Date.now());
  const http = opts.fetchImpl ?? fetch;
  const secretKey = deriveConnectorKey(opts.keyMaterial, "memorable-accounts");
  const key = (scope: ScopeId) => scopeStorageKey(scope);
  const label = (scope: ScopeId) => `qm ${parseScopeId(scope).kind ?? "scope"} ${hashId([scope], 8)}`;
  const claim = async (scope: ScopeId): Promise<boolean> => (await pending.take(key(scope))) !== null;
  const settledElsewhere = async (scope: ScopeId): Promise<PollResult> => {
    const existing = await accounts.get(key(scope));
    return existing
      ? { status: "connected", orgId: existing.orgId, orgName: existing.orgName, keyId: existing.keyId }
      : { status: "expired" };
  };
  const readKey = (account: MemorableAccount): string | null => {
    try {
      return decryptSecret(account.apiKeyEnc, secretKey);
    } catch {
      return null;
    }
  };

  return {
    async start(scope, startOpts = {}) {
      const existing = await accounts.get(key(scope));
      if (existing && !startOpts.force) return { status: "already_connected", orgName: existing.orgName };

      const live = await pending.get(key(scope));
      if (live && clock() < live.expiresAt && !startOpts.force) {
        return {
          status: "started",
          userCode: live.userCode,
          verificationUri: live.verificationUri,
          verificationUriComplete: live.verificationUriComplete,
          intervalMs: live.intervalMs,
          expiresAt: live.expiresAt,
        };
      }

      let body: DeviceStartBody;
      try {
        const response = await http(`${apiUrl}/v1/device/code`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-memorable-client": "qm" },
          body: JSON.stringify({ hostname: label(scope) }),
          signal: AbortSignal.timeout(START_TIMEOUT_MS),
        });
        body = (await response.json()) as DeviceStartBody;
        if (!response.ok) {
          return { status: "unavailable", detail: str(body.detail) || str(body.error) || `http ${response.status}` };
        }
      } catch (e) {
        return { status: "unavailable", detail: (e as Error).message.slice(0, 200) };
      }

      const deviceCode = str(body.device_code, 128);
      const userCode = str(body.user_code, 32);
      const verificationUriComplete = str(body.verification_uri_complete, 500);
      if (!deviceCode || !userCode || !verificationUriComplete) {
        return { status: "unavailable", detail: "the sign-in service returned an unusable response" };
      }
      const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 600;
      const interval = typeof body.interval === "number" ? body.interval : 5;
      const record: PendingConnect = {
        scopeId: scope,
        deviceCode,
        userCode,
        verificationUri: str(body.verification_uri, 500) || verificationUriComplete,
        verificationUriComplete,
        intervalMs: Math.max(MIN_POLL_INTERVAL_MS, interval * 1000),
        expiresAt: clock() + expiresIn * 1000,
      };
      await pending.put(key(scope), record);
      return {
        status: "started",
        userCode,
        verificationUri: record.verificationUri,
        verificationUriComplete,
        intervalMs: record.intervalMs,
        expiresAt: record.expiresAt,
      };
    },

    async poll(scope) {
      const record = await pending.get(key(scope));
      if (!record) return { status: "none" };
      if (clock() >= record.expiresAt) {
        await pending.delete(key(scope));
        return { status: "expired" };
      }

      let body: DevicePollBody;
      try {
        const response = await http(`${apiUrl}/v1/device/token`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-memorable-client": "qm" },
          body: JSON.stringify({ device_code: record.deviceCode }),
          signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
        });
        if (response.status >= 500 || response.status === 429) {
          return { status: "unavailable", detail: `the sign-in service answered ${response.status}` };
        }
        if (!response.ok) {
          await pending.delete(key(scope));
          return { status: "expired" };
        }
        body = (await response.json()) as DevicePollBody;
      } catch (e) {
        return { status: "unavailable", detail: (e as Error).message.slice(0, 200) };
      }

      const status = str(body.status, 32);
      if (status === "pending") {
        return {
          status: "pending",
          userCode: record.userCode,
          verificationUriComplete: record.verificationUriComplete,
        };
      }
      if (status === "denied") {
        await pending.delete(key(scope));
        return { status: "denied" };
      }
      if (status !== "approved") {
        return (await claim(scope)) ? { status: "expired" } : await settledElsewhere(scope);
      }

      const apiKey = typeof body.api_key === "string" ? body.api_key : "";
      if (!apiKey || apiKey.length > MAX_API_KEY_CHARS) {
        await pending.delete(key(scope));
        return { status: "unavailable", detail: "the sign-in was approved but the key it returned is unusable" };
      }
      if (!(await claim(scope))) return await settledElsewhere(scope);
      const account: MemorableAccount = {
        scopeId: scope,
        apiKeyEnc: encryptSecret(apiKey, secretKey),
        keyId: str(body.key_id, 64),
        orgId: str(body.org_id, 64),
        orgName: str(body.org_name, 120) || "your organisation",
        connectedAt: clock(),
      };
      await accounts.put(key(scope), account);
      return { status: "connected", orgId: account.orgId, orgName: account.orgName, keyId: account.keyId };
    },

    async keyFor(scope) {
      const exact = await accounts.get(key(scope));
      return exact ? readKey(exact) : null;
    },

    async disconnect(scope) {
      await pending.delete(key(scope));
      const had = await accounts.get(key(scope));
      if (!had) return false;
      await accounts.delete(key(scope));
      return true;
    },

    async connected() {
      const all = await accounts.all();
      return all.map(({ apiKeyEnc: _apiKeyEnc, ...rest }) => rest);
    },
  };
}
