import assert from "node:assert/strict";
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  createConnectorClientResolver,
  encryptSecret,
  decryptSecret,
  deriveConnectorKey,
  type SecretKey,
} from "../../src/connectors/connector-client-store.ts";
import { createKeychain } from "../../src/credentials/create-keychain.ts";
import { createKeychainStore } from "../../src/credentials/keychain-store.ts";
import { createEnvSecretSource } from "../../src/credentials/secret-source.ts";
import { scopeId } from "../../src/types.ts";
import { testConfigStore, testAdvisoryLock, testDatabaseUrl } from "../support/test-database.ts";

const orgScope = (o: string) => scopeId("org", o);
const envWithSlack = {
  SLACK_OAUTH_CLIENT_ID: "env-sid",
  SLACK_OAUTH_CLIENT_SECRET: "env-ssecret",
} as NodeJS.ProcessEnv;

test("AES-GCM secret round-trips and ciphertext differs from plaintext", () => {
  const key = deriveConnectorKey("a-persistent-key");
  const enc = encryptSecret("super-secret", key);
  assert.doesNotMatch(enc, /super-secret/);
  assert.equal(decryptSecret(enc, key), "super-secret");
  assert.throws(() => decryptSecret(enc, deriveConnectorKey("other-key")));
});

test("new ciphertexts are v2 (HKDF) and legacy sha256-key ciphertexts still decrypt", () => {
  const material = "a-persistent-key";
  const key = deriveConnectorKey(material);

  const enc = encryptSecret("fresh", key);
  assert.match(enc, /^v2:/);
  assert.equal(decryptSecret(enc, key), "fresh");

  const legacyKey = createHash("sha256").update(material).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", legacyKey, iv);
  const ct = Buffer.concat([cipher.update("old-secret", "utf8"), cipher.final()]);
  const legacyEnc = `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
  assert.equal(decryptSecret(legacyEnc, key), "old-secret");

  const raw = randomBytes(32);
  const bufKey = deriveConnectorKey(raw);
  assert.equal(bufKey.v1, raw);
  assert.equal(decryptSecret(encryptSecret("buf", bufKey), bufKey), "buf");

  assert.notDeepEqual(
    deriveConnectorKey(material, "keychain").current,
    deriveConnectorKey(material, "connector-clients").current,
  );
  assert.throws(() => decryptSecret("v2:not-enough", key), /malformed/);
  assert.throws(() => decryptSecret("just-one-part", key), /malformed/);
});

test("BYO record wins over env; the secret is encrypted at rest and never echoed", async () => {
  const store = testConfigStore({ connectorSecretKey: "persistent-key" });
  await store.setConnectorClient(orgScope("default-org"), "google", {
    clientId: "org-cid",
    clientSecret: "org-secret",
    scopes: ["custom.scope"],
    redirectAllowlist: ["https://app/cb"],
    updatedBy: "admin-alice",
  });

  const pub = await store.listConnectorClients(orgScope("default-org"));
  assert.equal(pub.length, 1);
  assert.equal(pub[0]!.provider, "google");
  assert.equal(pub[0]!.clientId, "org-cid");
  assert.equal(pub[0]!.hasSecret, true);
  assert.equal((pub[0] as unknown as Record<string, unknown>).clientSecret, undefined);
  assert.equal((pub[0] as unknown as Record<string, unknown>).secretEnc, undefined);
  assert.doesNotMatch(JSON.stringify(pub), /org-secret/);

  const resolve = createConnectorClientResolver({
    reader: store,
    orgScopeId: orgScope,
    secrets: createEnvSecretSource(envWithSlack),
  });
  const c = await resolve("google", {});
  assert.equal(c.id, "org-cid");
  assert.equal(c.secret, "org-secret");
  assert.deepEqual(c.scopes, ["custom.scope"]);
  assert.deepEqual(c.redirectAllowlist, ["https://app/cb"]);
  assert.equal(c.clientRef, "org:default-org:google");
});

test("a provider with no org record falls back to env", async () => {
  const store = testConfigStore({ connectorSecretKey: "k" });
  const resolve = createConnectorClientResolver({
    reader: store,
    orgScopeId: orgScope,
    secrets: createEnvSecretSource(envWithSlack),
  });
  const c = await resolve("slack", {});
  assert.equal(c.id, "env-sid");
  assert.equal(c.clientRef, "env:slack");
  await assert.rejects(resolve("google", {}), /GOOGLE_OAUTH_CLIENT_ID/);
});

test("a disabled org connector is refused (grays out the app grid)", async () => {
  const store = testConfigStore({ connectorSecretKey: "k" });
  await store.setConnectorClient(orgScope("default-org"), "google", {
    clientId: "c",
    clientSecret: "s",
    enabled: false,
  });
  const resolve = createConnectorClientResolver({ reader: store, orgScopeId: orgScope });
  await assert.rejects(resolve("google", {}), /disabled/);
});

test("deleting a connector record falls back to env / unconfigured", async () => {
  const store = testConfigStore({ connectorSecretKey: "k" });
  await store.setConnectorClient(orgScope("default-org"), "google", { clientId: "c", clientSecret: "s" });
  assert.equal((await store.listConnectorClients(orgScope("default-org"))).length, 1);
  await store.deleteConnectorClient(orgScope("default-org"), "google");
  assert.equal((await store.listConnectorClients(orgScope("default-org"))).length, 0);
  assert.equal(await store.getConnectorClientSecret(orgScope("default-org"), "google"), null);
});

const KEY = deriveConnectorKey("test-connector-key-aaaaaaaaaaaaaaaa");

function makeKeychain() {
  return createKeychain({
    lock: testAdvisoryLock(),
    store: createKeychainStore(testDatabaseUrl()),
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

const SIGNING = "old-shared-signing-secret-0123456789ab";
const CONNECTOR = "new-distinct-connector-key-0123456789";

test("rows encrypted under the pre-split signing-secret key still decrypt after CONNECTOR_SECRET_KEY lands", () => {
  const oldKey = deriveConnectorKey(SIGNING, "keychain");
  const stored = encryptSecret("xoxp-legacy-token", oldKey);

  const newKey: SecretKey = { ...deriveConnectorKey(CONNECTOR, "keychain"), fallbacks: [oldKey] };
  assert.equal(decryptSecret(stored, newKey), "xoxp-legacy-token");

  const rewritten = encryptSecret("xoxp-legacy-token", newKey);
  assert.equal(
    decryptSecret(rewritten, { ...deriveConnectorKey(CONNECTOR, "keychain") }),
    "xoxp-legacy-token",
    "writes use only the new key",
  );
});

test("without the fallback, an old row throws — and a wrong fallback rethrows the primary failure", () => {
  const oldKey = deriveConnectorKey(SIGNING, "keychain");
  const stored = encryptSecret("s", oldKey);
  const bare = deriveConnectorKey(CONNECTOR, "keychain");
  assert.throws(() => decryptSecret(stored, bare));
  const wrongFallback: SecretKey = {
    ...bare,
    fallbacks: [deriveConnectorKey("some-other-material-0123456789abcdef", "keychain")],
  };
  assert.throws(() => decryptSecret(stored, wrongFallback));
});
