import assert from "node:assert/strict";
import test from "node:test";
import { createKeychain, KeychainError, type OAuthToken } from "../src/credentials/keychain.ts";
import { createPostgresKeychainRows } from "../src/credentials/keychain-pg.ts";
import { deriveConnectorKey, encryptSecret } from "../src/connectors/connector-client-store.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { withTenant } from "../src/tenants/context.ts";
import { scopeId } from "../src/types.ts";
import { materializeGrant } from "./support/materialize-grant.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;
const KEY = deriveConnectorKey("postgres-keychain-test-key");

function keychain(rows: ReturnType<typeof createPostgresKeychainRows>, refresh?: () => Promise<OAuthToken>) {
  return createKeychain({
    ...rows,
    key: KEY,
    lock: createMemoryAdvisoryLock(),
    ...(refresh ? { refreshConnector: refresh, oauthSkewMs: 0 } : {}),
  });
}

test("owner listings are owner-scoped reads that fold email case and never return secrets", { skip }, async () => {
  await withTypedTableDb(createPostgresKeychainRows, async ({ store, tenant }) =>
    withTenant(tenant, async () => {
      const k = keychain(store);
      await k.save({ ownerId: "Owner-A@X.com", service: "github", secret: "ghp_a", envKey: "GITHUB_TOKEN" });
      await k.save({ ownerId: "U-other", service: "github", secret: "ghp_b", envKey: "GITHUB_TOKEN" });
      await k.save({ ownerId: "İstanbul@X.com", service: "gitlab", secret: "glpat_c", envKey: "GITLAB_TOKEN" });

      const turkish = await k.listByOwner("İstanbul@X.com");
      assert.deepEqual(
        turkish.map((c) => c.service),
        ["gitlab"],
      );
      const listed = await k.listByOwner("owner-a@x.COM");
      assert.deepEqual(
        listed.map((c) => c.service),
        ["github"],
      );
      assert.ok(!JSON.stringify(listed).includes("ghp_a"));
      assert.ok(listed.every((c) => !("secretEnc" in c)));
      assert.deepEqual(
        (await k.materializeOwn("owner-a@x.com")).flatMap((m) => m.env),
        [{ key: "GITHUB_TOKEN", value: "ghp_a" }],
      );
    }),
  );
});

test("concurrent keychain instances claim a once grant exactly once", { skip }, async () => {
  await withTypedTableDb(createPostgresKeychainRows, async ({ store, url, tenant }) => {
    const peerRows = createPostgresKeychainRows(url);
    try {
      await withTenant(tenant, async () => {
        const owner = keychain(store);
        const peer = keychain(peerRows);
        const credential = await owner.save({
          ownerId: "U1",
          service: "github",
          secret: "ghp_s",
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
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        assert.ok(rejected.reason instanceof KeychainError && rejected.reason.status === 410);
        assert.equal((await owner.getGrant(grant.id))?.status, "used");
      });
    } finally {
      await peerRows.close();
    }
  });
});

test("a refresh that lands while another writer holds the row keeps the newer token", { skip }, async () => {
  await withTypedTableDb(createPostgresKeychainRows, async ({ store, admin, tenant }) => {
    await withTenant(tenant, async () => {
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => (entered = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      const k = keychain(store, async () => {
        entered();
        await gate;
        return { accessToken: "refreshed", refreshToken: "rt-2", expiresAt: Date.now() + 3_600_000 };
      });
      await k.setConnectorToken("api.github.com", "U1", {
        accessToken: "stale",
        refreshToken: "rt-1",
        expiresAt: Date.now() - 1_000,
      });
      const pending = k.connectorAccessToken("api.github.com", "U1");
      await started;
      const writer = await admin.connect();
      try {
        await writer.query("BEGIN");
        await writer.query("SELECT 1 FROM keychain_credentials FOR UPDATE");
        release();
        for (let i = 0; i < 200; i++) {
          const { rows } = await admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted");
          if (rows[0].n > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await writer.query(
          "UPDATE keychain_credentials SET secret_enc = $1, fingerprint = 'reconnected', updated_at = updated_at + 1",
          [encryptSecret("reconnected", KEY)],
        );
        await writer.query("COMMIT");
      } finally {
        writer.release();
      }
      assert.equal(await pending, "reconnected");
      assert.equal((await store.creds.all())[0]!.fingerprint, "reconnected");
    });
  });
});

test("credentials, grants and asks stay inside their tenant", { skip }, async () => {
  await withTypedTableDb(createPostgresKeychainRows, async ({ store, admin, tenant, otherTenant }) => {
    const k = keychain(store);
    const { credential, grant, ask } = await withTenant(tenant, async () => {
      const credential = await k.save({ ownerId: "U1", service: "github", secret: "ghp_t", envKey: "GITHUB_TOKEN" });
      const grant = await k.createGrant({
        credentialId: credential.id,
        ownerId: "U1",
        audienceScopeId: scopeId("channel", "C1"),
        mode: "standing",
        purpose: "tenant check",
      });
      const { ask } = await k.createAsk({
        credentialId: credential.id,
        requesterId: "U1",
        requesterScopeId: scopeId("channel", "C2"),
        purpose: "tenant check",
      });
      return { credential, grant, ask };
    });
    await withTenant(otherTenant, async () => {
      assert.equal(await k.getCredential(credential.id), null);
      assert.deepEqual(await k.listByOwner("U1"), []);
      assert.deepEqual(await k.listAllMetadata(), []);
      assert.equal(await k.getGrant(grant.id), null);
      assert.deepEqual(await k.grantsForScope(scopeId("channel", "C1")), []);
      assert.equal(await k.getAsk(ask.id), null);
      assert.deepEqual(await k.listAsks({}), []);
      assert.equal(await k.remove("U1", credential.id), false);
      await k.save({ ownerId: "U1", service: "github", secret: "ghp_other", envKey: "GITHUB_TOKEN" });
    });
    await withTenant(tenant, async () => {
      assert.equal(await k.readOwnSecret("U1", credential.id), "ghp_t");
      assert.equal((await k.getGrant(grant.id))?.status, "active");
    });
    const { rows } = await admin.query(
      "SELECT tenant_id::text AS tenant, id FROM keychain_credentials ORDER BY tenant_id = $1 DESC",
      [tenant],
    );
    assert.deepEqual(rows, [
      { tenant, id: credential.id },
      { tenant: otherTenant, id: credential.id },
    ]);
  });
});

test("the conversion backfills keychain rows into the instance tenant and drops the old tables", { skip }, async () => {
  const createdAt = 1_700_000_000_000;
  await withTypedTableDb(
    createPostgresKeychainRows,
    async ({ store, admin, tenant }) => {
      await withTenant(tenant, async () => {
        const k = keychain(store);
        assert.equal(await k.readOwnSecret("U1", "cred-1"), "ghp_backfilled");
        const [own] = await k.materializeOwn("U1");
        assert.deepEqual(own!.env, [
          { key: "ACME_PASSWORD", value: "ghp_backfilled" },
          { key: "ACME_USERNAME", value: "alice", secret: false },
        ]);
        assert.deepEqual(await k.getGrant("grant-1"), {
          id: "grant-1",
          credentialId: "cred-1",
          ownerId: "U1",
          audienceScopeId: "channel:C1",
          mode: "standing",
          purpose: "backfilled",
          status: "active",
          createdAt,
        });
        assert.equal((await k.getAsk("ask-1"))?.status, "approved");
        assert.equal((await k.getAsk("ask-1"))?.requesterSeq, 7);
      });
      const { rows } = await admin.query(
        `SELECT (SELECT count(*)::int FROM keychain_credentials WHERE tenant_id = $1) AS creds,
                (SELECT count(*)::int FROM keychain_grants WHERE tenant_id = $1) AS grants,
                (SELECT count(*)::int FROM keychain_asks WHERE tenant_id = $1) AS asks,
                to_regclass('keychain_credentials_kv') IS NULL AND to_regclass('keychain_grants_kv') IS NULL
                  AND to_regclass('keychain_asks_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions WHERE tbl LIKE 'keychain_%') AS versions`,
        [tenant],
      );
      assert.deepEqual(rows, [{ creds: 1, grants: 1, asks: 1, dropped: true, versions: 0 }]);
    },
    async (admin) => {
      await seedKeyValueTable(admin, "keychain_credentials", {
        "cred-1": {
          id: "cred-1",
          ownerId: "U1",
          orgId: "default-org",
          service: "acme",
          kind: "env",
          envKey: "ACME_PASSWORD",
          username: "alice",
          secretEnc: encryptSecret("ghp_backfilled", KEY),
          fingerprint: "fp",
          createdAt,
          updatedAt: createdAt,
        },
        broken: { id: "broken", kind: "env" },
      });
      await seedKeyValueTable(admin, "keychain_grants", {
        "grant-1": {
          id: "grant-1",
          credentialId: "cred-1",
          ownerId: "U1",
          orgId: "default-org",
          audienceScopeId: "channel:C1",
          mode: "standing",
          purpose: "backfilled",
          status: "active",
          createdAt,
        },
      });
      await seedKeyValueTable(admin, "keychain_asks", {
        "ask-1": {
          id: "ask-1",
          credentialId: "cred-1",
          ownerId: "U1",
          requesterId: "U2",
          requesterScopeId: "channel:C1",
          requesterSeq: 7,
          purpose: "backfilled",
          status: "approved",
          createdAt,
          expiresAt: createdAt + 1_000,
          grantId: "grant-1",
        },
      });
    },
  );
});
