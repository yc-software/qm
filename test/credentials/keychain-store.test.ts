import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { scopeId } from "../../src/types.ts";
import { KeychainError } from "../../src/credentials/keychain.ts";
import { createKeychain } from "../../src/credentials/create-keychain.ts";
import { createKeychainStore, KEYCHAIN_CREDENTIALS_MIGRATION } from "../../src/credentials/keychain-store.ts";
import { deriveConnectorKey, encryptSecret } from "../../src/connectors/connector-client-store.ts";
import { materializeGrant } from "../support/materialize-grant.ts";
import { testAdvisoryLock, testDatabaseUrl } from "../support/test-database.ts";

const KEY = deriveConnectorKey("postgres-keychain-test-key");
const keychainOn = (databaseUrl: string) =>
  createKeychain({ lock: testAdvisoryLock(), store: createKeychainStore(databaseUrl), key: KEY });

test("listByOwner folds owner case, including ids where SQL and JS folding diverge, and returns no secrets", async () => {
  const keychain = keychainOn(testDatabaseUrl());
  await keychain.save({ ownerId: "Owner-A@X.com", service: "github", secret: "ghp_a", envKey: "GITHUB_TOKEN" });
  await keychain.save({ ownerId: "U-other", service: "github", secret: "ghp_b", envKey: "GITHUB_TOKEN" });
  await keychain.save({ ownerId: "İstanbul@X.com", service: "gitlab", secret: "glpat_c", envKey: "GITLAB_TOKEN" });

  const turkish = await keychain.listByOwner("İstanbul@X.com");
  assert.equal(turkish.length, 1, "an owner id where SQL and JS case folding diverge still lists its credentials");
  assert.equal(turkish[0]!.service, "gitlab");

  const listed = await keychain.listByOwner("owner-a@x.COM");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.service, "github");
  assert.ok(!("secretEnc" in listed[0]!));
  assert.ok(!JSON.stringify(listed).includes("ghp_a"));

  const own = await keychain.materializeOwn("owner-a@x.com");
  assert.deepEqual(
    own.flatMap((m) => m.env),
    [{ key: "GITHUB_TOKEN", value: "ghp_a" }],
    "the owner's own materialization still decrypts the secret",
  );
});

test("concurrent keychain instances claim a once grant exactly once", async () => {
  const databaseUrl = testDatabaseUrl();
  const owner = keychainOn(databaseUrl);
  const peer = keychainOn(databaseUrl);
  const credential = await owner.save({
    ownerId: "U1",
    service: "github",
    secret: "ghp_secret",
    envKey: "GITHUB_TOKEN",
  });
  const grant = await owner.createGrant({
    credentialId: credential.id,
    ownerId: "U1",
    audienceScopeId: scopeId("channel", "C1"),
    mode: "once",
    purpose: "single use",
  });
  const results = await Promise.allSettled([
    materializeGrant(owner, grant.id, scopeId("channel", "C1"), "U2"),
    materializeGrant(peer, grant.id, scopeId("channel", "C1"), "U3"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" && result.reason instanceof KeychainError && result.reason.status === 410,
    ).length,
    1,
  );
});

test("a refresh failure is recorded only on the version it was read from", async () => {
  const store = createKeychainStore(testDatabaseUrl());
  const keychain = createKeychain({ lock: testAdvisoryLock(), store, key: KEY, now: () => 1_000 });
  await keychain.setConnectorToken("api.github.com", "U1", { accessToken: "tok", refreshToken: "rt" });
  const [rec] = await store.creds.byOwners(["u1"]);
  await store.creds.markRefreshFailure({ ...rec!, fingerprint: "stale" }, 2_000, "ignored");
  assert.equal((await store.creds.get(rec!.id))!.refresh?.refreshFailedAt, undefined);
  await store.creds.markRefreshFailure(rec!, 2_000, "bad\u0000token");
  const failed = (await store.creds.get(rec!.id))!;
  assert.equal(failed.updatedAt, 2_000);
  assert.equal(failed.refresh?.refreshFailedAt, 2_000);
  assert.equal(failed.refresh?.refreshError, "badtoken");
  assert.ok(failed.refresh?.refreshTokenEnc, "the stored refresh token survives");
});

test("a live-shaped map row with a legacy username converts in place", async () => {
  const databaseUrl = testDatabaseUrl();
  const raw = new pg.Pool({ connectionString: databaseUrl });
  const secretEnc = encryptSecret("hunter2", KEY);
  try {
    await raw.query(`DROP TABLE keychain_credentials`);
    await raw.query(`CREATE TABLE keychain_credentials (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
    await raw.query(`DELETE FROM qm_schema_migrations WHERE id = $1`, [KEYCHAIN_CREDENTIALS_MIGRATION.id]);
    const row = {
      id: "c1",
      ownerId: "U1",
      orgId: "org1",
      service: "acme",
      kind: "env",
      envKey: "ACME_PASSWORD",
      username: "alice@acme.co",
      broker: { name: "Acme", enabled: true, allowedMethods: ["GET"] },
      refresh: { accountType: "company", grantedScopes: ["a", "b"] },
      secretEnc,
      fingerprint: "fp",
      origin: "save-login",
      createdAt: 1_761_000_000_000,
      updatedAt: 1_761_000_000_001,
    };
    await raw.query(`INSERT INTO keychain_credentials VALUES ('c1', $1)`, [row]);
    const store = createKeychainStore(databaseUrl);
    assert.deepEqual(await store.creds.get("c1"), row);
  } finally {
    await raw.end();
  }
});
