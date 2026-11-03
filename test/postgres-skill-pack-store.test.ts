import assert from "node:assert/strict";
import test from "node:test";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresSkillPackStore, type NewSkillPack } from "../src/skills/skill-pack-store.ts";
import { computeBundleHash, createPostgresSkillBundleStore } from "../src/skills/skill-bundle-store.ts";
import { withTenant, withoutTenant } from "../src/tenants/context.ts";
import { scopeId } from "../src/types.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;
const ORG = scopeId("org", "acme");
const base: NewSkillPack = {
  kind: "git",
  url: "https://example.com/skills.git",
  ref: "main",
  syncMode: "tracked",
  trustTier: "third-party",
  config: { exclude: ["internal/*"] },
  targetScopeId: ORG,
  subset: ["lint", "digest"],
  createdBy: "alice",
};
const makePacks = (url: string) => createPostgresSkillPackStore(url, { now: () => 1000 });
const files = [{ path: "skills/shared/run.sh", content: "echo hi", executable: true }];
const bundle = (packId: string) => ({ packId, commit: "c1", files, hash: computeBundleHash(files) });

test("the conversion backfills skill packs into the instance tenant and drops the old table", { skip }, async () => {
  const stored = {
    id: "p1",
    kind: "git",
    url: "https://example.com/skills.git",
    ref: "main",
    syncMode: "pinned",
    trustTier: "internal",
    targetScopeId: ORG,
    subset: "all",
    createdBy: "alice",
    createdAt: 7,
    lastImport: { at: 8, commit: "c1", status: "ok", counts: { imported: 1 } },
    updateAvailable: false,
    available: 3,
  };
  await withTypedTableDb(
    makePacks,
    async ({ store, admin, tenant }) => {
      const { lastImport: _import, ...unimported } = stored;
      assert.deepEqual(await withTenant(tenant, () => store.list()), [
        { ...stored, id: "broken", syncMode: "pinned", trustTier: "third-party" },
        { ...unimported, id: "halfImport" },
        stored,
      ]);
      const { rows } = await admin.query(
        `SELECT tenant_id::text AS tenant, id, to_regclass('skill_packs_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions WHERE tbl = 'skill_packs') AS versions
           FROM skill_packs ORDER BY id COLLATE "C"`,
      );
      assert.deepEqual(
        rows.map((row) => row.id),
        ["broken", "halfImport", "p1"],
      );
      assert.ok(rows.every((row) => row.tenant === tenant && row.dropped && row.versions === 0));
    },
    (admin) =>
      seedKeyValueTable(admin, "skill_packs", {
        p1: stored,
        broken: { ...stored, id: "broken", syncMode: "sometimes", trustTier: "unknown" },
        halfImport: { ...stored, id: "halfImport", lastImport: { at: 1 } },
        urlless: { ...stored, id: "urlless", url: undefined },
      }),
  );
});

test("row security alone hides other tenants' packs from the app role and fails closed unbound", { skip }, async () => {
  await withTypedTableDb(makePacks, async ({ store, url, tenant, otherTenant }) => {
    await withTenant(tenant, () => store.create(base));
    const app = createPgPool(url);
    try {
      const refs = (bound: string) => withTenant(bound, () => app.q(`SELECT ref FROM skill_packs`));
      assert.deepEqual(await refs(tenant), [{ ref: "main" }]);
      assert.deepEqual(await refs(otherTenant), []);
      await withoutTenant(() => assert.rejects(app.q(`SELECT ref FROM skill_packs`), /No tenant is bound/));
      await withoutTenant(() => assert.rejects(store.list(), /No tenant is bound/));
    } finally {
      await app.close();
    }
  });
});

test("skill bundles upsert by pack, load for a pack set, and stay per tenant", { skip }, async () => {
  await withTypedTableDb(createPostgresSkillBundleStore, async ({ store, tenant, otherTenant }) => {
    await withTenant(tenant, async () => {
      await store.put(bundle("p2"));
      await store.put(bundle("p1"));
      await store.put({ ...bundle("p1"), commit: "c2" });
      assert.equal((await store.get("p1"))?.commit, "c2");
      assert.deepEqual(await store.get("p2"), bundle("p2"));
      assert.deepEqual(
        (await store.forPacks(["p2", "p1", "p9"])).map((b) => b.packId),
        ["p1", "p2"],
      );
    });
    await withTenant(otherTenant, async () => {
      assert.equal(await store.get("p1"), null);
      assert.deepEqual(await store.forPacks(["p1", "p2"]), []);
      await store.put({ ...bundle("p1"), commit: "theirs" });
      await store.delete("p2");
    });
    await withTenant(tenant, async () => {
      assert.equal((await store.get("p1"))?.commit, "c2");
      await store.delete("p1");
      assert.deepEqual(
        (await store.forPacks(["p1", "p2"])).map((b) => b.packId),
        ["p2"],
      );
    });
    assert.equal((await withTenant(otherTenant, () => store.get("p1")))?.commit, "theirs");
  });
});

test("the conversion backfills skill bundles into the instance tenant and drops the old table", { skip }, async () => {
  await withTypedTableDb(
    createPostgresSkillBundleStore,
    async ({ store, admin, tenant }) => {
      assert.deepEqual(await withTenant(tenant, () => store.forPacks(["p1", "broken"])), [bundle("p1")]);
      const { rows } = await admin.query(
        `SELECT tenant_id::text AS tenant, pack_id, to_regclass('skill_bundles_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions WHERE tbl = 'skill_bundles') AS versions
           FROM skill_bundles`,
      );
      assert.deepEqual(rows, [{ tenant, pack_id: "p1", dropped: true, versions: 0 }]);
    },
    (admin) =>
      seedKeyValueTable(admin, "skill_bundles", {
        p1: bundle("p1"),
        broken: { packId: "broken", commit: "c1", files: "nope", hash: "h" },
      }),
  );
});

test(
  "row security alone hides other tenants' bundles from the app role and fails closed unbound",
  { skip },
  async () => {
    await withTypedTableDb(createPostgresSkillBundleStore, async ({ store, url, tenant, otherTenant }) => {
      await withTenant(tenant, () => store.put(bundle("p1")));
      const app = createPgPool(url);
      try {
        const packs = (bound: string) => withTenant(bound, () => app.q(`SELECT pack_id FROM skill_bundles`));
        assert.deepEqual(await packs(tenant), [{ pack_id: "p1" }]);
        assert.deepEqual(await packs(otherTenant), []);
        await withoutTenant(() => assert.rejects(app.q(`SELECT pack_id FROM skill_bundles`), /No tenant is bound/));
        await withoutTenant(() => assert.rejects(store.get("p1"), /No tenant is bound/));
      } finally {
        await app.close();
      }
    });
  },
);
