import { hashId } from "../util/crypto.ts";
import { createEnvSecretSource, type SecretSource } from "./secret-source.ts";
import type { ConnectorTokenStore } from "./keychain.ts";

export function envKey(host: string, principalId?: string): string {
  const normalizedHost = host.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  if (!principalId) return `VAULT_TOKEN_${normalizedHost}`;
  const normalizedPrincipal = principalId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const tag = hashId([principalId], 8).toUpperCase();
  return `VAULT_TOKEN_${normalizedHost}__${normalizedPrincipal}_${tag}`;
}

export function withOperatorTokenFallback(
  store: ConnectorTokenStore,
  serviceHosts: string[],
  secrets: SecretSource = createEnvSecretSource(),
): ConnectorTokenStore {
  return {
    setConnectorToken: (host, principalId, token, accountType) =>
      store.setConnectorToken(host, principalId, token, accountType),
    deleteConnectorToken: (host, principalId, accountType) =>
      store.deleteConnectorToken(host, principalId, accountType),
    connectorTokenStatus: (host, principalId, accountType) =>
      store.connectorTokenStatus(host, principalId, accountType),
    connectorDerivedAuth: (host, principalId, accountType) =>
      store.connectorDerivedAuth(host, principalId, accountType),
    async connectorAccessToken(host, principalId, accountType) {
      const token = await store.connectorAccessToken(host, principalId, accountType);
      if (token !== null) return token;
      if (!serviceHosts.some((s) => host === s || host.endsWith(`.${s}`))) return null;
      const perUser = principalId ? await secrets.get(envKey(host, principalId)) : undefined;
      if (perUser) return perUser;
      return (await secrets.get(envKey(host))) || null;
    },
  };
}
