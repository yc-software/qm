import assert from "node:assert/strict";
import test from "node:test";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresMapFactory, createMemoryMap } from "../src/persistence/durable-map.ts";
import { createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import {
  createKeychain,
  type KeychainCredential,
  type KeychainGrant,
  type KeychainAsk,
} from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";

const url = process.env.DATABASE_URL;
test(
  "credential renewal saturates the lock pool without starving durable credential reads and writes",
  { skip: !url, timeout: 15_000 },
  async (t) => {
    const storage = createPostgresMapFactory(url!);
    const locks = createPgPool(url!);
    t.after(async () => {
      await locks.close();
      await storage.pool.close();
    });
    const creds = storage.map<KeychainCredential>("test_auth_pool_creds");
    const owners = Array.from({ length: 16 }, (_, i) => `test-auth-pool-${i}`);
    let calls = 0;
    let active = 0;
    let peak = 0;
    const options = {
      creds,
      grants: createMemoryMap<KeychainGrant>(),
      asks: createMemoryMap<KeychainAsk>(),
      key: deriveConnectorKey("test-pg-auth"),
      advisoryLock: createPostgresAdvisoryLock(locks, { pollMs: 10 }),
      refreshConnector: async () => {
        calls++;
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 50));
        active--;
        return { accessToken: "fresh", refreshToken: "rotated", expiresAt: Date.now() + 3_600_000 };
      },
    };
    const keychain = createKeychain(options);
    for (const owner of owners)
      await keychain.setConnectorToken("auth.openai.com", owner, {
        accessToken: "expired",
        refreshToken: "old",
        expiresAt: Date.now() - 1000,
      });
    const results = await Promise.all(owners.map((owner) => keychain.connectorDerivedAuth("auth.openai.com", owner)));
    assert.equal(calls, 16);
    assert.equal(peak, 10);
    assert.ok(results.every((result) => result?.accessToken === "fresh"));
    const reload = createKeychain(options);
    for (const owner of owners)
      assert.equal((await reload.connectorDerivedAuth("auth.openai.com", owner))?.accessToken, "fresh");
    assert.equal(calls, 16);
    for (const owner of owners) await keychain.deleteConnectorToken("auth.openai.com", owner);
  },
);
