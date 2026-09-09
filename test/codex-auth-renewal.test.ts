import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createKeychain,
  type KeychainCredential,
  type KeychainGrant,
  type KeychainAsk,
} from "../src/credentials/keychain.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { keychainCodexAuthStore, fileCodexAuthStore } from "../src/harness/codex-auth-store.ts";
import { acquireCodexOAuthAuthLock } from "../src/harness/codex-auth.ts";

const now = 1_900_000_000_000;
const jwt = (payload: object) => `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
const auth = (marker: string, exp = now / 1000 - 60) => ({
  auth_mode: "chatgpt",
  tokens: {
    access_token: jwt({ exp, marker }),
    refresh_token: `refresh-${marker}`,
    id_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }),
  },
});
const files = (value: object) => [
  { path: ".codex/auth.json", contentBase64: Buffer.from(JSON.stringify(value)).toString("base64"), mode: 0o600 },
];
const response = () => Response.json(auth("renewed", now / 1000 + 3600).tokens);
const createStore = () =>
  createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("test-key-for-renewal"),
  });

for (const fresh of [false, true]) {
  test(`central renewal rechecks a ${fresh ? "fresh" : "stale"} replacement after taking the lock`, async () => {
    const keychain = createStore();
    const input = { ownerId: "owner", service: "codex", files: files(auth("old")) };
    const meta = await keychain.save(input);
    let calls = 0;
    const store = keychainCodexAuthStore({
      keychain, credentialId: meta.id, now: () => now,
      advisoryLock: { async withLock(_key, fn) {
        await keychain.save({ ...input, files: files(auth("replacement", now / 1000 + (fresh ? 3600 : -60))) });
        return fn();
      } },
      fetchImpl: (async (_url, init) => {
        calls++;
        assert.equal(JSON.parse(String(init?.body)).refresh_token, "refresh-replacement");
        return response();
      }) as typeof fetch,
    });
    const value = await store.load({ forceRefresh: true });
    assert.equal(calls, fresh ? 0 : 1);
    assert.equal((value?.tokens as Record<string, unknown>).refresh_token, fresh ? "refresh-replacement" : "refresh-renewed");
  });

  test(`file renewal rechecks a ${fresh ? "fresh" : "stale"} replacement after taking the lock`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "qm-auth-replacement-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "auth.json");
    writeFileSync(path, JSON.stringify(auth("old")), { mode: 0o600 });
    const lock = await acquireCodexOAuthAuthLock(path);
    let calls = 0;
    const store = fileCodexAuthStore(path, (async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(String(init?.body)).refresh_token, "refresh-replacement");
      return response();
    }) as typeof fetch, () => now);
    const pending = store.load({ forceRefresh: true });
    writeFileSync(path, JSON.stringify(auth("replacement", now / 1000 + (fresh ? 3600 : -60))));
    await lock.release();
    const value = await pending;
    assert.equal(calls, fresh ? 0 : 1);
    assert.equal((value?.tokens as Record<string, unknown>).refresh_token, fresh ? "refresh-replacement" : "refresh-renewed");
  });
}

test("central renewal rejects an expired reconnect during its conditional save", async () => {
  const keychain = createStore();
  const input = { ownerId: "owner", service: "codex", files: files(auth("old")) };
  const meta = await keychain.save(input);
  const store = keychainCodexAuthStore({ keychain, credentialId: meta.id, now: () => now,
    fetchImpl: (async () => {
      await keychain.save({ ...input, files: files(auth("replacement")) });
      return response();
    }) as typeof fetch,
  });
  await assert.rejects(() => store.load(), /credential changed and needs renewal/);
});

test("independent core instances serialize rotation and reload the durable credential", async () => {
  const keychain = createStore();
  const meta = await keychain.save({
    ownerId: "owner",
    service: "codex",
    files: files(auth("old")),
    accountLabel: "Subscription",
    host: "example.com",
    origin: "operator",
  });
  const advisoryLock = createMemoryAdvisoryLock();
  let calls = 0;
  const options = {
    keychain,
    credentialId: meta.id,
    advisoryLock,
    now: () => now,
    fetchImpl: (async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return response();
    }) as typeof fetch,
  };
  const results = await Promise.all([keychainCodexAuthStore(options).load(), keychainCodexAuthStore(options).load()]);
  assert.equal(calls, 1);
  assert.deepEqual(results[0], results[1]);
  assert.equal((results[0]?.tokens as Record<string, unknown>).refresh_token, "refresh-renewed");
  assert.deepEqual(await keychainCodexAuthStore(options).load(), results[0]);
  assert.equal(calls, 1);
  const saved = await keychain.getCredential(meta.id);
  assert.equal(saved?.accountLabel, "Subscription");
  assert.equal(saved?.host, "example.com");
  assert.equal(saved?.origin, "operator");
});

for (const replacement of ["reconnect", "delete"] as const) {
  test(`a ${replacement} during refresh cannot be overwritten by the old credential`, async () => {
    const keychain = createStore();
    const input = { ownerId: "owner", service: "codex", files: files(auth("old")) };
    const meta = await keychain.save(input);
    const store = keychainCodexAuthStore({
      keychain,
      credentialId: meta.id,
      now: () => now,
      fetchImpl: (async () => {
        if (replacement === "delete") await keychain.remove("owner", meta.id);
        else await keychain.save({ ...input, files: files(auth("reconnected", now / 1000 + 3600)) });
        return response();
      }) as typeof fetch,
    });
    const result = await store.load();
    if (replacement === "delete") {
      assert.equal(result, null);
      assert.equal(await keychain.getCredential(meta.id), null);
    } else assert.equal((result?.tokens as Record<string, unknown>).refresh_token, "refresh-reconnected");
  });
}

test("separate file stores lock before spending a refresh token", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qm-auth-refresh-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify(auth("old")), { mode: 0o600 });
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return response();
  }) as typeof fetch;
  const values = await Promise.all([
    fileCodexAuthStore(path, fetchImpl, () => now).load(),
    fileCodexAuthStore(path, fetchImpl, () => now).load(),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(values[0], values[1]);
});

test("permanent renewal errors carry an allowlisted reason without provider payloads", async () => {
  const keychain = createStore();
  const meta = await keychain.save({ ownerId: "owner", service: "codex", files: files(auth("old")) });
  const store = keychainCodexAuthStore({
    keychain,
    credentialId: meta.id,
    now: () => now,
    fetchImpl: (async () =>
      Response.json(
        { error: { code: "refresh_token_reused", message: "private-provider-payload" } },
        { status: 401 },
      )) as typeof fetch,
  });
  await assert.rejects(
    () => store.load(),
    (error) => {
      assert.match(String(error), /refresh_token_reused/);
      assert.doesNotMatch(String(error), /private-provider-payload/);
      return true;
    },
  );
});

test("legacy subscription records without expiry still refresh before derived use", async () => {
  const creds = createMemoryMap<KeychainCredential>();
  let calls = 0;
  const keychain = createKeychain({
    creds,
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("test-legacy-expiry"),
    now: () => now,
    refreshConnector: async () => {
      calls++;
      return { accessToken: jwt({ exp: now / 1000 + 3600 }), refreshToken: "next", expiresAt: now + 3_600_000 };
    },
  });
  await keychain.setConnectorToken(
    "auth.openai.com",
    "owner",
    { accessToken: jwt({ exp: now / 1000 - 60 }), refreshToken: "old" },
    "individual-model",
  );
  const value = await keychain.connectorDerivedAuth("auth.openai.com", "owner", "individual-model");
  assert.equal(calls, 1);
  assert.equal(value?.expiresAt, now + 3_600_000);
  assert.equal(
    (await keychain.connectorTokenStatus("auth.openai.com", "owner", "individual-model")).expiresAt,
    now + 3_600_000,
  );
});

for (const replacement of ["none", "reconnect", "delete"] as const) {
  test(`connector refresh across two core instances preserves ${replacement} state`, async () => {
    const creds = createMemoryMap<KeychainCredential>();
    const grants = createMemoryMap<KeychainGrant>();
    const asks = createMemoryMap<KeychainAsk>();
    const advisoryLock = createMemoryAdvisoryLock();
    const key = deriveConnectorKey("test-connector-race");
    let calls = 0;
    const options = {
      creds,
      grants,
      asks,
      key,
      advisoryLock,
      now: () => now,
      refreshConnector: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (replacement === "reconnect")
          await owner.setConnectorToken("auth.openai.com", "owner", {
            accessToken: "reconnected",
            refreshToken: "reconnected-refresh",
            expiresAt: now + 3_600_000,
          });
        if (replacement === "delete") await owner.deleteConnectorToken("auth.openai.com", "owner");
        return { accessToken: "renewed", refreshToken: "next", expiresAt: now + 3_600_000 };
      },
    };
    const owner = createKeychain(options);
    const other = createKeychain(options);
    await owner.setConnectorToken("auth.openai.com", "owner", {
      accessToken: "old",
      refreshToken: "old-refresh",
      expiresAt: now - 1000,
    });
    const values = await Promise.all([
      owner.connectorDerivedAuth("auth.openai.com", "owner"),
      other.connectorDerivedAuth("auth.openai.com", "owner"),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(values[0], values[1]);
    assert.equal(
      values[0]?.accessToken ?? null,
      { delete: null, reconnect: "reconnected", none: "renewed" }[replacement],
    );
  });
}

test("waiting instances do not return expired tokens after refresh failure metadata changes", async () => {
  const creds = createMemoryMap<KeychainCredential>();
  let clock = now;
  let calls = 0;
  const options = {
    creds,
    grants: createMemoryMap<KeychainGrant>(),
    asks: createMemoryMap<KeychainAsk>(),
    key: deriveConnectorKey("test-refresh-failure"),
    advisoryLock: createMemoryAdvisoryLock(),
    now: () => clock,
    refreshConnector: async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      clock++;
      throw new Error("provider unavailable");
    },
  };
  const owner = createKeychain(options);
  const waiter = createKeychain(options);
  await owner.setConnectorToken("auth.openai.com", "owner", {
    accessToken: "expired",
    refreshToken: "old",
    expiresAt: now - 1000,
  });
  assert.deepEqual(
    await Promise.all([
      owner.connectorDerivedAuth("auth.openai.com", "owner"),
      waiter.connectorDerivedAuth("auth.openai.com", "owner"),
    ]),
    [null, null],
  );
  assert.equal(calls, 1);
});

test("handled lock rejection clears the local flight without an unhandled rejection", async () => {
  const keychain = createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("test-lock-failure"),
    now: () => now,
    advisoryLock: {
      async withLock() {
        throw new Error("lock unavailable");
      },
    },
    refreshConnector: async () => {
      throw new Error("must not refresh");
    },
  });
  await keychain.setConnectorToken("auth.openai.com", "owner", {
    accessToken: "expired",
    refreshToken: "old",
    expiresAt: now - 1000,
  });
  await assert.rejects(() => keychain.connectorDerivedAuth("auth.openai.com", "owner"), /lock unavailable/);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => keychain.connectorDerivedAuth("auth.openai.com", "owner"), /lock unavailable/);
});

test("deletion before the final derived-auth read releases no credential", async () => {
  const creds = createMemoryMap<KeychainCredential>();
  const get = creds.get.bind(creds);
  let reads = 0;
  creds.get = async (id) => {
    if (++reads === 2) await creds.delete(id);
    return get(id);
  };
  const keychain = createKeychain({
    creds,
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("test-final-delete"),
    now: () => now,
  });
  await keychain.setConnectorToken("auth.openai.com", "owner", { accessToken: "fresh", expiresAt: now + 3_600_000 });
  reads = 0;
  assert.equal(await keychain.connectorDerivedAuth("auth.openai.com", "owner"), null);
});

test("central refresh preserves the metadata of the same snapshot as its token bundle", async () => {
  const keychain = createStore();
  const input = { ownerId: "owner", service: "codex", files: files(auth("old")), accountLabel: "old label" };
  const meta = await keychain.save(input);
  const materialize = keychain.materializeOwnFiles.bind(keychain);
  let changed = false;
  keychain.materializeOwnFiles = async (owner) => {
    if (!changed) {
      changed = true;
      await keychain.save({ ...input, files: files(auth("new")), accountLabel: "new label" });
    }
    return materialize(owner);
  };
  const store = keychainCodexAuthStore({
    keychain,
    credentialId: meta.id,
    now: () => now,
    fetchImpl: (async () => response()) as typeof fetch,
  });
  await store.load();
  assert.equal((await keychain.getCredential(meta.id))?.accountLabel, "new label");
  assert.equal(((await store.load())?.tokens as Record<string, unknown>).refresh_token, "refresh-renewed");
});
