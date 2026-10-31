import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import {
  createConnectorClientResolver,
  encryptSecret,
  decryptSecret,
  deriveConnectorKey,
} from "../src/connectors/connector-client-store.ts";
import { TEST_ROOT_SCOPE, bindTestTenant } from "./support/tenant.ts";

bindTestTenant();

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
  assert.equal(bufKey.legacy, raw);
  assert.equal(decryptSecret(encryptSecret("buf", bufKey), bufKey), "buf");

  assert.notDeepEqual(
    deriveConnectorKey(material, "keychain").current,
    deriveConnectorKey(material, "connector-clients").current,
  );
  assert.throws(() => decryptSecret("v2:not-enough", key), /malformed/);
  assert.throws(() => decryptSecret("just-one-part", key), /malformed/);
});

test("BYO record resolves; the secret is encrypted at rest and never echoed", async () => {
  const store = createMemoryConfigStore({ connectorSecretKey: "persistent-key" });
  await store.setConnectorClient(TEST_ROOT_SCOPE, "google", {
    clientId: "org-cid",
    clientSecret: "org-secret",
    scopes: ["custom.scope"],
    redirectAllowlist: ["https://app/cb"],
    updatedBy: "admin-alice",
  });

  const pub = await store.listConnectorClients(TEST_ROOT_SCOPE);
  assert.equal(pub.length, 1);
  assert.equal(pub[0]!.provider, "google");
  assert.equal(pub[0]!.clientId, "org-cid");
  assert.equal(pub[0]!.hasSecret, true);
  assert.equal((pub[0] as unknown as Record<string, unknown>).clientSecret, undefined);
  assert.equal((pub[0] as unknown as Record<string, unknown>).secretEnc, undefined);
  assert.doesNotMatch(JSON.stringify(pub), /org-secret/);

  const resolve = createConnectorClientResolver({ reader: store });
  const c = await resolve("google", {});
  assert.equal(c.id, "org-cid");
  assert.equal(c.secret, "org-secret");
  assert.deepEqual(c.scopes, ["custom.scope"]);
  assert.deepEqual(c.redirectAllowlist, ["https://app/cb"]);
  assert.equal(c.clientRef, `${TEST_ROOT_SCOPE}:google`);
});

test("a provider with no org record is unconfigured even when its OAuth env vars are set", async () => {
  const store = createMemoryConfigStore({ connectorSecretKey: "k" });
  const resolve = createConnectorClientResolver({ reader: store });
  const prior = { id: process.env.SLACK_OAUTH_CLIENT_ID, secret: process.env.SLACK_OAUTH_CLIENT_SECRET };
  process.env.SLACK_OAUTH_CLIENT_ID = "env-sid";
  process.env.SLACK_OAUTH_CLIENT_SECRET = "env-ssecret";
  try {
    await assert.rejects(resolve("slack", {}), /admin must add the slack OAuth client/);
    await assert.rejects(resolve("google", {}), /not configured/);
  } finally {
    if (prior.id === undefined) delete process.env.SLACK_OAUTH_CLIENT_ID;
    else process.env.SLACK_OAUTH_CLIENT_ID = prior.id;
    if (prior.secret === undefined) delete process.env.SLACK_OAUTH_CLIENT_SECRET;
    else process.env.SLACK_OAUTH_CLIENT_SECRET = prior.secret;
  }
});

test("a disabled org connector is refused (grays out the app grid)", async () => {
  const store = createMemoryConfigStore({ connectorSecretKey: "k" });
  await store.setConnectorClient(TEST_ROOT_SCOPE, "google", {
    clientId: "c",
    clientSecret: "s",
    enabled: false,
  });
  const resolve = createConnectorClientResolver({ reader: store });
  await assert.rejects(resolve("google", {}), /disabled/);
});

test("deleting a connector record leaves it unconfigured", async () => {
  const store = createMemoryConfigStore({ connectorSecretKey: "k" });
  await store.setConnectorClient(TEST_ROOT_SCOPE, "google", { clientId: "c", clientSecret: "s" });
  assert.equal((await store.listConnectorClients(TEST_ROOT_SCOPE)).length, 1);
  await store.deleteConnectorClient(TEST_ROOT_SCOPE, "google");
  assert.equal((await store.listConnectorClients(TEST_ROOT_SCOPE)).length, 0);
  assert.equal(await store.getConnectorClientSecret(TEST_ROOT_SCOPE, "google"), null);
});
