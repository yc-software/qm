import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresAmbientCursorStore } from "../src/api/ambient-cursor-store.ts";
import { withTenant } from "../src/tenants/context.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;

test("a cursor advances per surface and container", { skip }, async () => {
  await withTypedTableDb(createPostgresAmbientCursorStore, ({ store, tenant }) =>
    withTenant(tenant, async () => {
      assert.equal(await store.get("slack", "C1"), null);
      await store.put("slack", "C1", { lastJudgedTs: "1.0" });
      await store.put("slack", "C2", { lastJudgedTs: "9.0", lastJudgedAt: 5 });
      await store.put("slack", "C1", { lastJudgedTs: "2.0", lastJudgedAt: 7 });
      assert.deepEqual(await store.get("slack", "C1"), { lastJudgedTs: "2.0", lastJudgedAt: 7 });
      assert.deepEqual(await store.get("slack", "C2"), { lastJudgedTs: "9.0", lastJudgedAt: 5 });
      assert.equal(await store.get("web", "C1"), null);
    }),
  );
});

test("cursors are isolated per tenant", { skip }, async () => {
  await withTypedTableDb(createPostgresAmbientCursorStore, async ({ store, tenant, otherTenant }) => {
    await withTenant(tenant, () => store.put("slack", "C1", { lastJudgedTs: "1.0" }));
    assert.equal(await withTenant(otherTenant, () => store.get("slack", "C1")), null);
    await withTenant(otherTenant, () => store.put("slack", "C1", { lastJudgedTs: "5.0" }));
    assert.deepEqual(await withTenant(tenant, () => store.get("slack", "C1")), { lastJudgedTs: "1.0" });
  });
});

test(
  "the conversion splits keys, keeps the newest cursor per container and drops the old table",
  { skip },
  async () => {
    await withTypedTableDb(
      createPostgresAmbientCursorStore,
      async ({ store, admin, tenant }) => {
        await withTenant(tenant, async () => {
          assert.deepEqual(await store.get("slack", "C1"), { lastJudgedTs: "3.0", lastJudgedAt: 30 });
          assert.deepEqual(await store.get("slack", "C2:thread:1.5"), { lastJudgedTs: "1.0" });
        });
        const { rows } = await admin.query(
          `SELECT tenant_id::text AS tenant, surface, container, to_regclass('ambient_cursors_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions WHERE tbl = 'ambient_cursors') AS versions
           FROM ambient_cursors ORDER BY container`,
        );
        assert.deepEqual(rows, [
          { tenant, surface: "slack", container: "C1", dropped: true, versions: 0 },
          { tenant, surface: "slack", container: "C2:thread:1.5", dropped: true, versions: 0 },
        ]);
      },
      (admin) =>
        seedKeyValueTable(admin, "ambient_cursors", {
          "org-a:slack:C1": { lastJudgedTs: "2.0", lastJudgedAt: 20 },
          "org-b:slack:C1": { lastJudgedTs: "3.0", lastJudgedAt: 30 },
          "org-a:slack:C2:thread:1.5": { lastJudgedTs: "1.0" },
          "org-a:slack:C3": { lastJudgedAt: 1 },
          nocolons: { lastJudgedTs: "1.0" },
        }),
    );
  },
);
