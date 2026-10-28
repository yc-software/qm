import type { ConnectorTokenStore, OAuthTokenStatus } from "./keychain.ts";
import {
  ACCOUNT_TYPES,
  oauthProviderEntries,
  PROVIDERS,
  type OAuthClientResolver,
  type OAuthProviderConfig,
} from "../connectors/oauth.ts";

function bestOAuthTokenStatus(statuses: readonly OAuthTokenStatus[]): OAuthTokenStatus {
  return (
    statuses.find((s) => s.connected && !s.needsReconnect) ??
    statuses.find((s) => s.connected) ??
    statuses[0] ?? { connected: false }
  );
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
