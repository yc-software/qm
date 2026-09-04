import type { DurableMap } from "../persistence/durable-map.ts";
import type { ConnectorTokenStore, OAuthTokenStatus } from "./keychain.ts";
import { PROVIDERS, type OAuthClientResolver } from "../connectors/oauth.ts";

interface ConnectorStatusEntry {
  connected: boolean;
  expiresAt?: number;
  needsReconnect?: boolean;
  refreshFailedAt?: number;
  refreshError?: string;
}

export interface ConnectorStatusRecord {
  principalId: string;
  checkedAt: number;
  providers: Record<string, ConnectorStatusEntry>;
}

export interface ConnectorStatusCache {
  get(principalId: string): Promise<ConnectorStatusRecord | null>;
  put(record: ConnectorStatusRecord): Promise<void>;
}

export function createConnectorStatusCache(map: DurableMap<ConnectorStatusRecord>): ConnectorStatusCache {
  return {
    get: (principalId) => map.get(principalId),
    put: (record) => map.put(record.principalId, record),
  };
}

export const CONNECTOR_STATUS_ACCOUNT_TYPES: ReadonlyArray<string | undefined> = [undefined, "personal", "company"];

const CONNECTOR_STATUS_MAX_TTL_MS = 15 * 60_000;

export function connectorStatusIsStale(
  record: ConnectorStatusRecord | null,
  now: number,
  maxTtlMs: number = CONNECTOR_STATUS_MAX_TTL_MS,
): boolean {
  if (!record) return true;
  if (now - record.checkedAt > maxTtlMs) return true;
  for (const entry of Object.values(record.providers)) {
    const expiredSinceChecked =
      entry.connected && entry.expiresAt !== undefined && now >= entry.expiresAt && entry.expiresAt > record.checkedAt;
    if (expiredSinceChecked) return true;
  }
  return false;
}

export function bestOAuthTokenStatus(statuses: readonly OAuthTokenStatus[]): OAuthTokenStatus {
  return (
    statuses.find((s) => s.connected && !s.needsReconnect) ??
    statuses.find((s) => s.connected) ??
    statuses[0] ?? { connected: false }
  );
}

function mergeStatus(entry: ConnectorStatusEntry, status: OAuthTokenStatus): ConnectorStatusEntry {
  if (!status.connected) return entry;
  const next: ConnectorStatusEntry = { ...entry, connected: true };
  if (status.expiresAt !== undefined) {
    next.expiresAt = next.expiresAt === undefined ? status.expiresAt : Math.min(next.expiresAt, status.expiresAt);
  }
  if (status.needsReconnect) next.needsReconnect = true;
  if (
    status.refreshFailedAt !== undefined &&
    (next.refreshFailedAt === undefined || status.refreshFailedAt > next.refreshFailedAt)
  ) {
    next.refreshFailedAt = status.refreshFailedAt;
    if (status.refreshError) next.refreshError = status.refreshError;
  }
  return next;
}

export async function refreshConnectorStatus(
  tokens: ConnectorTokenStore,
  principalId: string,
  now: number,
): Promise<ConnectorStatusRecord> {
  const providers: Record<string, ConnectorStatusEntry> = {};
  for (const [name, provider] of Object.entries(PROVIDERS)) {
    let entry: ConnectorStatusEntry = { connected: false };
    for (const host of provider.hosts) {
      const statuses = await Promise.all(
        CONNECTOR_STATUS_ACCOUNT_TYPES.map((accountType) =>
          tokens.connectorTokenStatus(host, principalId, accountType),
        ),
      );
      entry = mergeStatus(entry, bestOAuthTokenStatus(statuses));
    }
    providers[name] = entry;
  }
  return { principalId, checkedAt: now, providers };
}

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  slack: "Slack",
  notion: "Notion",
  linear: "Linear",
  github: "GitHub",
  dropbox: "Dropbox",
};

export function connectorLabel(name: string): string {
  return PROVIDER_LABELS[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

export async function configuredConnectorProviders(resolveClient: OAuthClientResolver): Promise<string[]> {
  const configured = await Promise.all(
    Object.keys(PROVIDERS).map(async (provider) => {
      try {
        await resolveClient(provider, {});
        return provider;
      } catch {
        return null;
      }
    }),
  );
  return configured.filter((provider): provider is string => provider !== null);
}
