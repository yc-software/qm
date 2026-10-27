import type { DurableMap } from "../persistence/durable-map.ts";
import type { ConnectorTokenStore, OAuthTokenStatus } from "./keychain.ts";
import {
  ACCOUNT_TYPES,
  oauthProviderEntries,
  PROVIDERS,
  type OAuthClientResolver,
  type OAuthProviderConfig,
} from "../connectors/oauth.ts";

interface ConnectorStatusEntry {
  connected: boolean;
  mcpLabel?: string;
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

function bestOAuthTokenStatus(statuses: readonly OAuthTokenStatus[]): OAuthTokenStatus {
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

export type HostTokenStatus = OAuthTokenStatus & { host: string };

export async function providerTokenStatuses(
  tokens: ConnectorTokenStore,
  principalId: string,
): Promise<Array<{ name: string; provider: OAuthProviderConfig; hosts: HostTokenStatus[] }>> {
  const all = await Promise.all(
    oauthProviderEntries().map(async ([name, provider]) => {
      const hosts = await Promise.all(
        provider.hosts.map(async (host) => {
          const statuses = await Promise.all(
            ACCOUNT_TYPES.map((accountType) => tokens.connectorTokenStatus(host, principalId, accountType)),
          );
          return { host, ...bestOAuthTokenStatus(statuses) };
        }),
      );
      return { name, provider, hosts };
    }),
  );
  return all.filter(({ provider, hosts }) => !provider.mcpLabel || hosts.some((h) => h.connected));
}

export async function refreshConnectorStatus(
  tokens: ConnectorTokenStore,
  principalId: string,
  now: number,
): Promise<ConnectorStatusRecord> {
  const providers: Record<string, ConnectorStatusEntry> = {};
  for (const { name, provider, hosts } of await providerTokenStatuses(tokens, principalId)) {
    const entry = hosts.reduce<ConnectorStatusEntry>((acc, status) => mergeStatus(acc, status), { connected: false });
    providers[name] = provider.mcpLabel ? { ...entry, mcpLabel: provider.mcpLabel } : entry;
  }
  return { principalId, checkedAt: now, providers };
}

export async function currentConnectorStatus(
  cache: ConnectorStatusCache,
  tokens: ConnectorTokenStore | undefined,
  principalId: string,
  now: number,
): Promise<ConnectorStatusRecord | null> {
  const cached = await cache.get(principalId);
  if (!tokens || !connectorStatusIsStale(cached, now)) return cached;
  const fresh = await refreshConnectorStatus(tokens, principalId, now);
  await cache.put(fresh);
  return fresh;
}

export async function linkedConnectors(
  resolveClient: OAuthClientResolver,
  cache: ConnectorStatusCache,
  tokens: ConnectorTokenStore,
  principalId: string,
): Promise<Record<string, boolean>> {
  const [configured, status] = await Promise.all([
    configuredConnectorProviders(resolveClient),
    currentConnectorStatus(cache, tokens, principalId, Date.now()),
  ]);
  return Object.fromEntries(
    configured.map((name) => [name, !!status?.providers[name]?.connected && !status.providers[name].needsReconnect]),
  );
}

export function connectorLabel(name: string): string {
  return PROVIDERS[name]?.label ?? name.charAt(0).toUpperCase() + name.slice(1);
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
