import { test } from "node:test";
import assert from "node:assert/strict";
import { connectorLabel, providerTokenStatuses } from "../src/credentials/connector-status.ts";
import type { ConnectorTokenStore, OAuthTokenStatus } from "../src/credentials/keychain.ts";
import { setPublicOAuthClients } from "../src/connectors/oauth.ts";

function fakeTokens(status: (host: string, accountType?: string) => OAuthTokenStatus): ConnectorTokenStore {
  return {
    connectorTokenStatus: async (host: string, _principalId: string, accountType?: string) => status(host, accountType),
  } as unknown as ConnectorTokenStore;
}

const hostStatus = async (tokens: ConnectorTokenStore, provider: string, host: string) =>
  (await providerTokenStatuses(tokens, "U1")).find((p) => p.name === provider)?.hosts.find((h) => h.host === host);

test("provider statuses choose a usable account over a lapsed account for the same host", async () => {
  const tokens = fakeTokens((host, accountType) => {
    if (host !== "gmail.googleapis.com") return { connected: false };
    if (accountType === "personal") return { connected: true, expiresAt: 5000, accountType: "personal" };
    return { connected: true, expiresAt: 100, needsReconnect: true, refreshFailedAt: 300 };
  });
  const status = await hostStatus(tokens, "google", "gmail.googleapis.com");
  assert.equal(status?.connected, true);
  assert.equal(status?.expiresAt, 5000);
  assert.equal(status?.needsReconnect, undefined);
});

test("labels: known providers get friendly names; unknown is capitalized", () => {
  assert.equal(connectorLabel("google"), "Google");
  assert.equal(connectorLabel("github"), "GitHub");
  assert.equal(connectorLabel("acme"), "Acme");
});

test("provider statuses include linked per-user MCP sign-ins and skip unlinked ones", async (t) => {
  t.after(() => setPublicOAuthClients([]));
  const client = (name: string, label: string) => ({
    name,
    host: `api.${name}.example`,
    authUrl: `https://id.${name}.example/authorize`,
    tokenUrl: `https://id.${name}.example/token`,
    scopes: [`${name}:write`],
    clientId: "public-client",
    label,
  });
  setPublicOAuthClients([client("orders", "Orders"), client("other", "Other")]);
  const tokens = fakeTokens((host) => (host === "api.orders.example" ? { connected: true } : { connected: false }));
  const names = (await providerTokenStatuses(tokens, "U1")).map((p) => p.name);
  assert.ok(names.includes("orders"));
  assert.ok(!names.includes("other"));
});
