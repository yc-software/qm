import assert from "node:assert/strict";
import test from "node:test";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { createPostgresSkillPackStore, type NewSkillPack } from "../src/skills/skill-pack-store.ts";
import { computeBundleHash, createPostgresSkillBundleStore } from "../src/skills/skill-bundle-store.ts";
import { withTenant } from "../src/tenants/context.ts";
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

test("skill packs round-trip, patch only the given fields, and record imports", { skip }, async () => {
  await withTypedTableDb(makePacks, async ({ store, tenant }) => {
    await withTenant(tenant, async () => {
      const pack = await store.create(base);
      assert.deepEqual(await store.get(pack.id), { ...base, id: pack.id, createdAt: 1000 });
      const all = await store.create({ ...base, subset: "all", config: undefined, authCredentialSlug: "gh" });
      assert.equal((await store.get(all.id))?.subset, "all");
      assert.equal((await store.get(all.id))?.authCredentialSlug, "gh");
      assert.equal((await store.get(all.id))?.config, undefined);

      const updated = await store.update(pack.id, { ref: "v2", updateAvailable: true, available: 4 });
      assert.deepEqual(updated, {
        ...base,
        id: pack.id,
        createdAt: 1000,
        ref: "v2",
        updateAvailable: true,
        available: 4,
      });
      assert.equal((await store.update(pack.id, { authCredentialSlug: undefined })).authCredentialSlug, undefined);
      await store.recordImport(pack.id, { at: 5, commit: "c1", status: "ok", counts: { imported: 2 } });
      assert.deepEqual((await store.get(pack.id))?.lastImport, {
        at: 5,
        commit: "c1",
        status: "ok",
        counts: { imported: 2 },
      });
      await store.recordImport(pack.id, { at: 6, commit: "c2", status: "error", error: "boom" });
      assert.deepEqual((await store.get(pack.id))?.lastImport, { at: 6, commit: "c2", status: "error", error: "boom" });
      await assert.rejects(store.update("missing", { ref: "x" }), /unknown skill pack/);

      assert.deepEqual((await store.list()).map((p) => p.id).sort(), [pack.id, all.id].sort());
      await store.remove(all.id);
      assert.equal(await store.get(all.id), null);
    });
  });
});

test("skill packs are isolated per tenant", { skip }, async () => {
  await withTypedTableDb(makePacks, async ({ store, tenant, otherTenant }) => {
    const mine = await withTenant(tenant, () => store.create(base));
    await withTenant(otherTenant, async () => {
      assert.equal(await store.get(mine.id), null);
      assert.deepEqual(await store.list(), []);
      await assert.rejects(store.update(mine.id, { ref: "x" }), /unknown skill pack/);
      await store.remove(mine.id);
    });
    assert.equal((await withTenant(tenant, () => store.get(mine.id)))?.ref, "main");
  });
});

test("the conversion backfills skill packs into the instance tenant and drops the old table", { skip }, async () => {
  const legacy = {
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
      assert.deepEqual(await withTenant(tenant, () => store.list()), [legacy]);
      const { rows } = await admin.query(
        `SELECT tenant_id::text AS tenant, id, to_regclass('skill_packs_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions WHERE tbl = 'skill_packs') AS versions
           FROM skill_packs`,
      );
      assert.deepEqual(rows, [{ tenant, id: "p1", dropped: true, versions: 0 }]);
    },
    (admin) =>
      seedKeyValueTable(admin, "skill_packs", {
        p1: legacy,
        broken: { ...legacy, id: "broken", syncMode: "sometimes" },
        halfImport: { ...legacy, id: "halfImport", lastImport: { at: 1 } },
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
      await assert.rejects(app.q(`SELECT ref FROM skill_packs`), /No tenant is bound/);
      await assert.rejects(store.list(), /No tenant is bound/);
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
        await assert.rejects(app.q(`SELECT pack_id FROM skill_bundles`), /No tenant is bound/);
        await assert.rejects(store.get("p1"), /No tenant is bound/);
      } finally {
        await app.close();
      }
    });
  },
);
