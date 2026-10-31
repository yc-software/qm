import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresExternalMemberStore, type ExternalMember } from "../src/identity/external-members.ts";
import { createPostgresDeactivationStore } from "../src/identity/identity-service.ts";
import { createPostgresPrincipalLinkStore, createPrincipalLinkService } from "../src/identity/principal-links.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { withTenant } from "../src/tenants/context.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;

function identityStores(url: string) {
  const links = createPostgresPrincipalLinkStore(url);
  const deactivations = createPostgresDeactivationStore(url);
  const members = createPostgresExternalMemberStore(url);
  return {
    links,
    deactivations,
    members,
    close: async () => {
      await Promise.all([links.close?.(), deactivations.close?.(), members.close?.()]);
    },
  };
}

const link = (principalId: string, canonicalId: string, createdAt = 1) => ({
  principalId,
  canonicalId,
  evidence: "same verified email",
  linkedBy: "admin",
  createdAt,
});

const member = (email: string, overrides: Partial<ExternalMember> = {}): ExternalMember => ({
  email,
  role: "member",
  expiresAt: 500,
  invitedBy: "admin",
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

test("principal links insert once, list in creation order and are taken by folded id", { skip }, async () => {
  await withTypedTableDb(identityStores, async ({ store, tenant }) =>
    withTenant(tenant, async () => {
      assert.deepEqual(
        await store.links.insertIfAbsent(link("Casey@Acme.test", "U1", 2)),
        link("casey@acme.test", "U1", 2),
      );
      assert.deepEqual(
        await store.links.insertIfAbsent(link("casey@acme.test", "U2", 3)),
        link("casey@acme.test", "U1", 2),
      );
      await store.links.insertIfAbsent(link("oidc|1", "U1", 1));
      assert.deepEqual(
        (await store.links.list()).map((row) => row.principalId),
        ["oidc|1", "casey@acme.test"],
      );
      assert.deepEqual(await store.links.take("CASEY@acme.test"), link("casey@acme.test", "U1", 2));
      assert.equal(await store.links.take("casey@acme.test"), null);
      const service = createPrincipalLinkService(store.links);
      await service.refresh(true);
      assert.equal(service.canonical("oidc|1"), "U1");
      assert.deepEqual(service.aliases("U1"), ["oidc|1"]);
    }),
  );
});

test("deactivations and external members upsert and remove by folded id", { skip }, async () => {
  await withTypedTableDb(identityStores, async ({ store, tenant }) =>
    withTenant(tenant, async () => {
      await store.deactivations.put({ principalId: "Pat@Corp.com", source: "directory-sync", at: 1 });
      await store.deactivations.put({ principalId: "pat@corp.com", source: "manual", at: 2 });
      await store.deactivations.put({ principalId: "U9", source: "manual", at: 3 });
      assert.deepEqual(
        (await store.deactivations.list()).sort((x, y) => x.at - y.at),
        [
          { principalId: "pat@corp.com", source: "manual", at: 2 },
          { principalId: "U9", source: "manual", at: 3 },
        ],
      );
      await store.deactivations.remove(["PAT@corp.com", "nobody"]);
      assert.deepEqual(
        (await store.deactivations.list()).map((row) => row.principalId),
        ["U9"],
      );

      await store.members.put(member("Guest@Partner.test"));
      await store.members.put(member("guest@partner.test", { expiresAt: null, kind: "teammate", inviteId: "inv-1" }));
      await store.members.put(member("admin@partner.test", { role: "org_admin" }));
      assert.deepEqual(await store.members.list(), [
        member("admin@partner.test", { role: "org_admin" }),
        member("guest@partner.test", { expiresAt: null, kind: "teammate", inviteId: "inv-1" }),
      ]);
      await store.members.remove(["Guest@partner.test"]);
      assert.deepEqual(
        (await store.members.list()).map((row) => row.email),
        ["admin@partner.test"],
      );
    }),
  );
});

test("identity rows are scoped to their tenant", { skip }, async () => {
  await withTypedTableDb(identityStores, async ({ store, tenant, otherTenant }) => {
    await withTenant(tenant, async () => {
      await store.links.insertIfAbsent(link("oidc|1", "U1"));
      await store.deactivations.put({ principalId: "U1", source: "manual", at: 1 });
      await store.members.put(member("guest@partner.test"));
    });
    await withTenant(otherTenant, async () => {
      assert.deepEqual(await store.links.list(), []);
      assert.deepEqual(await store.deactivations.list(), []);
      assert.deepEqual(await store.members.list(), []);
      assert.equal(await store.links.take("oidc|1"), null);
      await store.deactivations.remove(["U1"]);
      await store.members.remove(["guest@partner.test"]);
      assert.deepEqual(await store.links.insertIfAbsent(link("oidc|1", "U7")), link("oidc|1", "U7"));
    });
    await withTenant(tenant, async () => {
      assert.deepEqual(await store.links.list(), [link("oidc|1", "U1")]);
      assert.equal((await store.deactivations.list()).length, 1);
      assert.equal((await store.members.list()).length, 1);
    });
  });
});

test("the conversions backfill well-formed identity rows into the instance tenant", { skip }, async () => {
  await withTypedTableDb(
    identityStores,
    async ({ store, admin, tenant }) => {
      await withTenant(tenant, async () => {
        assert.deepEqual(await store.links.list(), [link("casey@acme.test", "U1", 4)]);
        assert.deepEqual(await store.deactivations.list(), [{ principalId: "pat@corp.com", source: "manual", at: 5 }]);
        assert.deepEqual(await store.members.list(), [
          member("guest@partner.test", { expiresAt: null, kind: "teammate", inviteId: "inv-1" }),
        ]);
      });
      const { rows } = await admin.query(
        `SELECT t.tbl, (SELECT count(*)::int FROM durable_map_versions v WHERE v.tbl = t.tbl) AS versions,
                to_regclass(t.tbl || '_kv') IS NULL AS dropped
           FROM unnest(ARRAY['principal_links', 'deactivated_principals', 'external_members']) AS t(tbl)`,
      );
      assert.deepEqual(
        rows.map((row) => [row.tbl, row.versions, row.dropped]),
        [
          ["principal_links", 0, true],
          ["deactivated_principals", 0, true],
          ["external_members", 0, true],
        ],
      );
      const tenants = await admin.query(
        `SELECT DISTINCT tenant_id::text AS tenant FROM (
           SELECT tenant_id FROM principal_links UNION ALL SELECT tenant_id FROM deactivated_principals
           UNION ALL SELECT tenant_id FROM external_members) AS all_rows`,
      );
      assert.deepEqual(tenants.rows, [{ tenant }]);
    },
    async (admin) => {
      await seedKeyValueTable(admin, "principal_links", {
        "casey@acme.test": { ...link("Casey@Acme.test", "U1", 4) },
        broken: { principalId: "broken", canonicalId: "U1" },
      });
      await seedKeyValueTable(admin, "deactivated_principals", {
        "pat@corp.com": { principalId: "Pat@Corp.com", source: "manual", at: 5 },
        broken: { principalId: "broken", source: "whim", at: 1 },
      });
      await seedKeyValueTable(admin, "external_members", {
        "guest@partner.test": member("Guest@Partner.test", { expiresAt: null, kind: "teammate", inviteId: "inv-1" }),
        broken: { email: "broken@partner.test", role: "owner", invitedBy: "admin", createdAt: 1, updatedAt: 1 },
      });
    },
  );
});

test(
  "row security alone hides other tenants' identity rows from the app role and fails closed unbound",
  { skip },
  async () => {
    await withTypedTableDb(identityStores, async ({ store, url, tenant, otherTenant }) => {
      await withTenant(tenant, async () => {
        await store.links.insertIfAbsent(link("oidc|1", "U1"));
        await store.deactivations.put({ principalId: "U1", source: "manual", at: 1 });
        await store.members.put(member("guest@partner.test"));
      });
      const app = createPgPool(url);
      try {
        const counts = `SELECT (SELECT count(*)::int FROM principal_links) AS links,
                             (SELECT count(*)::int FROM deactivated_principals) AS deactivations,
                             (SELECT count(*)::int FROM external_members) AS members`;
        assert.deepEqual(await withTenant(tenant, () => app.q(counts)), [{ links: 1, deactivations: 1, members: 1 }]);
        assert.deepEqual(await withTenant(otherTenant, () => app.q(counts)), [
          { links: 0, deactivations: 0, members: 0 },
        ]);
        await assert.rejects(app.q(counts), /No tenant is bound/);
        await assert.rejects(store.links.list(), /No tenant is bound/);
        await assert.rejects(store.deactivations.list(), /No tenant is bound/);
        await assert.rejects(store.members.list(), /No tenant is bound/);
      } finally {
        await app.close();
      }
    });
  },
);
