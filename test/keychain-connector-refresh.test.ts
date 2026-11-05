import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeychain, type KeychainCredential, type OAuthRefresh } from "../src/credentials/keychain.ts";
import type { DurableMap } from "../src/persistence/durable-map.ts";
import type { AdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { testAdvisoryLock, testMap } from "./support/test-database.ts";
import { decryptSecret, deriveConnectorKey } from "../src/connectors/connector-client-store.ts";

const KEY = deriveConnectorKey("keychain-refresh-test-key");
const HOST = "gmail.googleapis.com";

function keychain(creds: DurableMap<KeychainCredential>, lock: AdvisoryLock, refreshConnector: OAuthRefresh) {
  return createKeychain({
    creds,
    grants: testMap(),
    asks: testMap(),
    key: KEY,
    lock,
    refreshConnector,
  });
}

function rotatingProvider() {
  const state = { valid: "rt-0", issued: 0, calls: 0, inFlight: 0, maxInFlight: 0 };
  const refresh: OAuthRefresh = async (_host, token) => {
    state.calls++;
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await new Promise((r) => setTimeout(r, 20));
    state.inFlight--;
    if (token.refreshToken !== state.valid) throw new Error("invalid_grant");
    state.issued++;
    state.valid = `rt-${state.issued}`;
    return { accessToken: `at-${state.issued}`, refreshToken: state.valid, expiresAt: Date.now() + 3_600_000 };
  };
  return { state, refresh };
}

const storedRefreshToken = async (creds: DurableMap<KeychainCredential>) => {
  const rec = (await creds.all())[0]!;
  return decryptSecret(rec.refresh!.refreshTokenEnc!, KEY);
};

test("processes sharing a store refresh a rotating token once and keep the live refresh token", async () => {
  const creds = testMap<KeychainCredential>();
  const lock = testAdvisoryLock();
  const provider = rotatingProvider();
  const a = keychain(creds, lock, provider.refresh);
  const b = keychain(creds, lock, provider.refresh);
  await a.setConnectorToken(HOST, "U1", { accessToken: "at-0", refreshToken: "rt-0", expiresAt: Date.now() - 1 });
  const tokens = await Promise.all([a.connectorAccessToken(HOST, "U1"), b.connectorAccessToken(HOST, "U1")]);
  assert.deepEqual(tokens, ["at-1", "at-1"]);
  assert.equal(provider.state.calls, 1);
  assert.equal(provider.state.maxInFlight, 1);
  assert.equal(await storedRefreshToken(creds), provider.state.valid);
});

test("a reconnect that lands during a refresh is not overwritten by the refreshed token", async () => {
  const creds = testMap<KeychainCredential>();
  const lock = testAdvisoryLock();
  const refresh: OAuthRefresh = async () => {
    await k.setConnectorToken(HOST, "U1", { accessToken: "reconnected", refreshToken: "rt-new" });
    return { accessToken: "refreshed", refreshToken: "rt-stale", expiresAt: Date.now() + 3_600_000 };
  };
  const k = keychain(creds, lock, refresh);
  await k.setConnectorToken(HOST, "U1", { accessToken: "old", refreshToken: "rt-old", expiresAt: Date.now() - 1 });
  assert.equal(await k.connectorAccessToken(HOST, "U1"), "reconnected");
  assert.equal(await storedRefreshToken(creds), "rt-new");
});

test("recording a refresh failure never overwrites a rotation that landed concurrently", async () => {
  const inner = testMap<KeychainCredential>();
  const lock = testAdvisoryLock();
  let rotateBeforeWrite = false;
  const rotate = async () => {
    if (!rotateBeforeWrite) return;
    rotateBeforeWrite = false;
    await other.setConnectorToken(HOST, "U1", {
      accessToken: "rotated",
      refreshToken: "rt-rotated",
      expiresAt: Date.now() + 3_600_000,
    });
  };
  const creds: DurableMap<KeychainCredential> = {
    ...inner,
    merge: async (id, patch) => (await rotate(), inner.merge(id, patch)),
    update: async (id, fn) => (await rotate(), inner.update!(id, fn)),
  };
  const failing: OAuthRefresh = async () => {
    rotateBeforeWrite = true;
    throw new Error("provider unavailable");
  };
  const other = keychain(inner, lock, failing);
  const k = keychain(creds, lock, failing);
  await k.setConnectorToken(HOST, "U1", { accessToken: "old", refreshToken: "rt-old", expiresAt: Date.now() - 1 });
  assert.equal(await k.connectorAccessToken(HOST, "U1"), null);
  assert.equal(await storedRefreshToken(inner), "rt-rotated");
  const status = await k.connectorTokenStatus(HOST, "U1");
  assert.equal(status.refreshFailedAt, undefined);
});

test("a failed refresh inside the margin falls back to the still-valid access token", async () => {
  const creds = testMap<KeychainCredential>();
  const k = keychain(creds, testAdvisoryLock(), async () => {
    throw new Error("provider unavailable");
  });
  await k.setConnectorToken(HOST, "U1", {
    accessToken: "still-valid",
    refreshToken: "rt",
    expiresAt: Date.now() + 5 * 60_000,
  });
  assert.equal(await k.connectorAccessToken(HOST, "U1"), "still-valid");
  const status = await k.connectorTokenStatus(HOST, "U1");
  assert.equal(typeof status.refreshFailedAt, "number");
  assert.equal(status.refreshError, "provider unavailable");
  await k.setConnectorToken(HOST, "U2", { accessToken: "expired", refreshToken: "rt", expiresAt: Date.now() - 1 });
  assert.equal(await k.connectorAccessToken(HOST, "U2"), null);
});

test("a refresh that cannot take its lock still serves the unexpired token", async () => {
  const lock: AdvisoryLock = {
    ...testAdvisoryLock(),
    withLock: async () => {
      throw new Error("timeout acquiring advisory lock");
    },
  };
  const k = keychain(testMap<KeychainCredential>(), lock, async () => ({ accessToken: "unused" }));
  await k.setConnectorToken(HOST, "U1", {
    accessToken: "still-valid",
    refreshToken: "rt",
    expiresAt: Date.now() + 60_000 * 5,
  });
  assert.equal(await k.connectorAccessToken(HOST, "U1"), "still-valid");
  await k.setConnectorToken(HOST, "U2", { accessToken: "expired", refreshToken: "rt", expiresAt: Date.now() - 1 });
  assert.equal(await k.connectorAccessToken(HOST, "U2"), null);
});
