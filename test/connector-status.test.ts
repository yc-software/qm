import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  connectorLabel,
  connectorStatusIsStale,
  createConnectorStatusCache,
  refreshConnectorStatus,
  type ConnectorStatusRecord,
} from "../src/credentials/connector-status.ts";
import type { ConnectorTokenStore, OAuthTokenStatus } from "../src/credentials/keychain.ts";

function fakeTokens(status: (host: string, accountType?: string) => OAuthTokenStatus): ConnectorTokenStore {
  return {
    connectorTokenStatus: async (host: string, _principalId: string, accountType?: string) => status(host, accountType),
  } as unknown as ConnectorTokenStore;
}

test("connector status cache: put/get round-trips per principal", async () => {
  const cache = createConnectorStatusCache(createMemoryMap<ConnectorStatusRecord>());
  assert.equal(await cache.get("U1"), null);
  const rec: ConnectorStatusRecord = { principalId: "U1", checkedAt: 1, providers: { slack: { connected: true } } };
  await cache.put(rec);
  assert.deepEqual(await cache.get("U1"), rec);
  assert.equal(await cache.get("U2"), null);
});

test("staleness: null/over-floor/past-expiry are stale; fresh+unexpired is not", () => {
  const now = 1_000_000;
  assert.equal(connectorStatusIsStale(null, now), true);
  const overFloor: ConnectorStatusRecord = { principalId: "U1", checkedAt: now - 20 * 60_000, providers: {} };
  assert.equal(connectorStatusIsStale(overFloor, now), true);
  const expired: ConnectorStatusRecord = {
    principalId: "U1",
    checkedAt: now - 1000,
    providers: { google: { connected: true, expiresAt: now - 1 } },
  };
  assert.equal(connectorStatusIsStale(expired, now), true);
  const fresh: ConnectorStatusRecord = {
    principalId: "U1",
    checkedAt: now - 1000,
    providers: { google: { connected: true, expiresAt: now + 60_000 }, slack: { connected: false } },
  };
  assert.equal(connectorStatusIsStale(fresh, now), false);
});

test("staleness: a token already expired AT refresh time does not make every check stale (no refresh loop)", () => {
  const now = 1_000_000;
  const refreshedAfterExpiry: ConnectorStatusRecord = {
    principalId: "U1",
    checkedAt: now - 1000,
    providers: { google: { connected: true, expiresAt: now - 5000 } },
  };
  assert.equal(
    connectorStatusIsStale(refreshedAfterExpiry, now),
    false,
    "expiry before checkedAt means another refresh learns nothing — wait for the TTL instead",
  );
  assert.equal(
    connectorStatusIsStale(refreshedAfterExpiry, now + 20 * 60_000),
    true,
    "the TTL floor still forces an eventual re-check",
  );
});

test("refresh: marks a provider connected from the token store and records the soonest expiry", async () => {
  const now = 500;
  const tokens = fakeTokens((host) =>
    host === "slack.com" ? { connected: true, expiresAt: 9999 } : { connected: false },
  );
  const rec = await refreshConnectorStatus(tokens, "U1", now);
  assert.equal(rec.checkedAt, now);
  assert.equal(rec.providers.slack?.connected, true);
  assert.equal(rec.providers.slack?.expiresAt, 9999);
  assert.equal(rec.providers.google?.connected, false);
});

test("refresh: a provider with multiple hosts uses the soonest connected expiry", async () => {
  const tokens = fakeTokens((host) => {
    if (host === "gmail.googleapis.com") return { connected: true, expiresAt: 5000 };
    if (host === "sheets.googleapis.com") return { connected: true, expiresAt: 3000 };
    return { connected: false };
  });
  const rec = await refreshConnectorStatus(tokens, "U1", 1);
  assert.equal(rec.providers.google?.connected, true);
  assert.equal(rec.providers.google?.expiresAt, 3000);
});

test("refresh: carries reconnect-needed and refresh failure metadata", async () => {
  const tokens = fakeTokens((host) =>
    host === "api.github.com"
      ? {
          connected: true,
          expiresAt: 100,
          hasRefreshToken: true,
          needsReconnect: true,
          refreshFailedAt: 600,
          refreshError: "revoked by provider",
        }
      : { connected: false },
  );

  const rec = await refreshConnectorStatus(tokens, "U1", 1_000);
  assert.deepEqual(rec.providers.github, {
    connected: true,
    expiresAt: 100,
    needsReconnect: true,
    refreshFailedAt: 600,
    refreshError: "revoked by provider",
  });
});

test("refresh: chooses a usable account status over a lapsed account for the same host", async () => {
  const tokens = fakeTokens((host, accountType) => {
    if (host !== "gmail.googleapis.com") return { connected: false };
    if (accountType === "personal") return { connected: true, expiresAt: 5000, accountType: "personal" };
    return {
      connected: true,
      expiresAt: 100,
      needsReconnect: true,
      refreshFailedAt: 300,
      refreshError: "default token revoked",
    };
  });

  const rec = await refreshConnectorStatus(tokens, "U1", 1_000);
  assert.equal(rec.providers.google?.connected, true);
  assert.equal(rec.providers.google?.expiresAt, 5000);
  assert.equal(rec.providers.google?.needsReconnect, undefined);
  assert.equal(rec.providers.google?.refreshFailedAt, undefined);
});

test("labels: known providers get friendly names; unknown is capitalized", () => {
  assert.equal(connectorLabel("google"), "Google");
  assert.equal(connectorLabel("github"), "GitHub");
  assert.equal(connectorLabel("acme"), "Acme");
});
