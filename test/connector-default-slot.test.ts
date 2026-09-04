import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeychain, type KeychainCredential } from "../src/credentials/keychain.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";

const KEY = deriveConnectorKey("test-connector-key-aaaaaaaaaaaaaaaa");

function makeKeychain() {
  return createKeychain({
    creds: createMemoryMap<KeychainCredential>(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: KEY,
  });
}

test("a connector token stored under accountType 'default' shares the canonical slot the read paths probe", async () => {
  const keychain = makeKeychain();
  const token = { accessToken: "live", refreshToken: "r", expiresAt: Date.now() + 3_600_000 };
  await keychain.setConnectorToken("www.googleapis.com", "carol@x.com", token, "default");
  assert.equal((await keychain.connectorTokenStatus("www.googleapis.com", "carol@x.com")).connected, true);
  assert.equal(await keychain.connectorAccessToken("www.googleapis.com", "carol@x.com"), "live");
  assert.equal(await keychain.connectorAccessToken("www.googleapis.com", "carol@x.com", "default"), "live");
});
