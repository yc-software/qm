import type { CustomOAuthConnector } from "../../src/connectors/custom-oauth.ts";
import { createKeychain } from "../../src/credentials/keychain.ts";
import { createMemoryMap } from "../../src/persistence/durable-map.ts";
import { deriveConnectorKey } from "../../src/connectors/connector-client-store.ts";
import { makeRefresh, type FetchLike } from "../../src/connectors/oauth.ts";
import { oauthProvidersFor } from "../../src/connectors/custom-oauth.ts";

export const descriptor: CustomOAuthConnector = {
  id: "ledger",
  label: "Ledger Accounting",
  description: "Invoices and payments",
  hosts: ["api.ledger.example"],
  authUrl: "https://login.ledger.example/authorize",
  tokenUrl: "https://login.ledger.example/token",
  scopes: ["offline_access", "accounting.read"],
  clientIdEnv: "LEDGER_CLIENT_ID",
  clientSecretEnv: "LEDGER_CLIENT_SECRET",
  clientAuth: "basic",
  pkce: true,
};
export const bundle = {
  contract: 1 as const,
  tools: [],
  skills: [],
  connectors: [{ path: "connectors/ledger.json", content: JSON.stringify(descriptor) }],
};
export const client = { id: "client-id", secret: "client-secret", clientRef: "test:ledger" };
export function customKeychain(fetchImpl: FetchLike, now: () => number = Date.now) {
  return createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("custom-oauth-test"),
    now,
    refreshConnector: makeRefresh({
      resolveClient: async () => client,
      providers: () => oauthProvidersFor([descriptor]),
      fetchImpl,
      now,
    }),
  });
}
