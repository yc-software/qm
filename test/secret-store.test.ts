import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import {
  createEncryptedSecretStore,
  deleteReplacedSecrets,
  type SecretStore,
} from "../src/credentials/secret-store.ts";
import { createKeychain } from "../src/credentials/keychain.ts";
import type { KeychainCredential } from "../src/credentials/keychain.ts";
import { createModelCredentialStore, type StoredModelCredential } from "../src/model/model-credential-store.ts";
import { testAdvisoryLock, testMap } from "./support/test-database.ts";

function memorySecretStore(): SecretStore & { values: Map<string, string>; names: string[] } {
  const values = new Map<string, string>();
  const names: string[] = [];
  return {
    values,
    names,
    async put(name, value) {
      names.push(name);
      const ref = `memory:${names.length}`;
      values.set(ref, value);
      return ref;
    },
    async get(ref) {
      const value = values.get(ref);
      if (value === undefined) throw new Error(`no secret ${ref}`);
      return value;
    },
    async delete(ref) {
      values.delete(ref);
    },
  };
}

const key = deriveConnectorKey("secret-store-test-key", "keychain");

test("encrypted store: the ref is the ciphertext, and it reads back", async () => {
  const store = createEncryptedSecretStore(key);
  const ref = await store.put("ignored", "value");
  assert.notEqual(ref, "value");
  assert.equal(await store.get(ref), "value");
});

test("keychain: the record keeps the store's ref, and deleting the credential deletes its secret", async () => {
  const secrets = memorySecretStore();
  const creds = testMap<KeychainCredential>();
  const keychain = createKeychain({
    creds,
    grants: testMap(),
    asks: testMap(),
    key,
    lock: testAdvisoryLock(),
    secrets: () => secrets,
  });
  const meta = await keychain.save({ ownerId: "U1", service: "github", secret: "ghp_test" });
  const [stored] = await creds.all();
  assert.ok(stored);
  assert.match(stored.secretEnc, /^memory:/);
  assert.equal(await keychain.readOwnSecret("U1", meta.id), "ghp_test");
  assert.equal(secrets.values.size, 1);
  assert.equal(await keychain.remove("U1", meta.id), true);
  assert.equal(secrets.values.size, 0);
});

test("model keys: rotation deletes the old secret, and deleting the key deletes the new one", async () => {
  const secrets = memorySecretStore();
  const store = createModelCredentialStore({
    backing: testMap<StoredModelCredential>(),
    keyMaterial: "secret-store-test-key",
    secrets: () => secrets,
  });
  await store.set("anthropic", "sk-one", "admin");
  await store.set("anthropic", "sk-two", "admin");
  assert.equal(await store.resolve("anthropic"), "sk-two");
  assert.deepEqual([...secrets.values.values()], ["sk-two"]);
  await store.delete("anthropic", "admin");
  assert.equal(await store.resolve("anthropic"), null);
  assert.equal(secrets.values.size, 0);
});

test("deleteReplacedSecrets: logs and continues when a delete fails", async () => {
  const deleted: string[] = [];
  const store: SecretStore = {
    put: async () => "",
    get: async () => "",
    async delete(ref) {
      if (ref === "bad") throw new Error("vault unavailable");
      deleted.push(ref);
    },
  };
  await deleteReplacedSecrets(store, ["keep", "bad", "old"], ["keep"]);
  assert.deepEqual(deleted, ["old"]);
});
