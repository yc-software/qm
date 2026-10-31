import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresUiStateStore } from "../src/surfaces/ui-state.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { withTenant, withoutTenant } from "../src/tenants/context.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;

test("ui state reads, writes, claims and deletes a principal's keys", { skip }, async () => {
  await withTypedTableDb(
    (url) => createPostgresUiStateStore(url),
    async ({ store, tenant }) =>
      withTenant(tenant, async () => {
        assert.equal(await store.get("U1", "inbox-filter"), null);
        await store.put("U1", "inbox-filter", { value: "all", updatedAt: 1 });
        await store.put("U1", "inbox-filter", { value: "human", updatedAt: 2 });
        assert.deepEqual(await store.get("U1", "inbox-filter"), { value: "human", updatedAt: 2 });
        assert.equal(await store.get("U2", "inbox-filter"), null);
        assert.deepEqual(await store.putIfAbsent("U1", "inbox-filter", { value: "x", updatedAt: 9 }), {
          value: "human",
          updatedAt: 2,
        });
        assert.deepEqual(await store.putIfAbsent("U1", "inbox-loops", { value: ["l1"], updatedAt: 3 }), {
          value: ["l1"],
          updatedAt: 3,
        });
        await store.put("U1", "observe:c1", { value: { runId: "r1" }, updatedAt: 4 });
        assert.deepEqual(await store.take("U1", "observe:c1"), { value: { runId: "r1" }, updatedAt: 4 });
        assert.equal(await store.take("U1", "observe:c1"), null);
        await store.delete("U1", "inbox-loops");
        assert.equal(await store.get("U1", "inbox-loops"), null);
      }),
  );
});

test("a newer write wins and an older one is refused with the stored time", { skip }, async () => {
  await withTypedTableDb(
    (url) => createPostgresUiStateStore(url),
    async ({ store, tenant }) =>
      withTenant(tenant, async () => {
        assert.deepEqual(await store.putNewer("U1", "theme", { value: "dark", updatedAt: 10 }), {
          ok: true,
          updatedAt: 10,
        });
        assert.deepEqual(await store.putNewer("U1", "theme", { value: "light", updatedAt: 5 }), {
          ok: false,
          updatedAt: 10,
        });
        assert.deepEqual(await store.putNewer("U1", "theme", { value: "light", updatedAt: 10 }), {
          ok: true,
          updatedAt: 10,
        });
        assert.deepEqual(await store.get("U1", "theme"), { value: "light", updatedAt: 10 });
      }),
  );
});

test("modify serializes concurrent read-modify-writes on one key", { skip }, async () => {
  await withTypedTableDb(
    (url) => createPostgresUiStateStore(url),
    async ({ store, tenant }) =>
      withTenant(tenant, async () => {
        const bump = () =>
          store.modify("U1", "canvas:s1", (current) => ({
            value: { rev: ((current?.value as { rev?: number } | undefined)?.rev ?? 0) + 1 },
            updatedAt: 1,
          }));
        await Promise.all(Array.from({ length: 8 }, bump));
        assert.deepEqual((await store.get("U1", "canvas:s1"))?.value, { rev: 8 });
      }),
  );
});

test("ui state keys are scoped to their tenant", { skip }, async () => {
  await withTypedTableDb(
    (url) => createPostgresUiStateStore(url),
    async ({ store, tenant, otherTenant }) => {
      await withTenant(tenant, () => store.put("U1", "theme", { value: "dark", updatedAt: 10 }));
      assert.equal(await withTenant(otherTenant, () => store.get("U1", "theme")), null);
      assert.deepEqual(
        await withTenant(otherTenant, () => store.putNewer("U1", "theme", { value: "x", updatedAt: 1 })),
        {
          ok: true,
          updatedAt: 1,
        },
      );
      assert.equal(await withTenant(otherTenant, () => store.take("U1", "theme")).then((r) => r?.value), "x");
      assert.deepEqual(await withTenant(tenant, () => store.get("U1", "theme")), { value: "dark", updatedAt: 10 });
    },
  );
});

test("the conversion splits principal and key on the last separator and drops the old table", { skip }, async () => {
  await withTypedTableDb(
    (url) => createPostgresUiStateStore(url),
    async ({ store, admin, tenant }) => {
      assert.deepEqual(await withTenant(tenant, () => store.get("U#1", "canvas:s1")), {
        value: { html: "<p/>" },
        updatedAt: 3,
      });
      const { rows } = await admin.query(
        `SELECT tenant_id::text AS tenant, principal_id, key, updated_at::text AS at, to_regclass('web_ui_state_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions WHERE tbl = 'web_ui_state') AS versions
           FROM web_ui_state ORDER BY principal_id COLLATE "C", key COLLATE "C"`,
      );
      assert.deepEqual(rows, [
        { tenant, principal_id: "U#1", key: "canvas:s1", at: "3", dropped: true, versions: 0 },
        { tenant, principal_id: "U3", key: "decimal", at: "1730000000001", dropped: true, versions: 0 },
        { tenant, principal_id: "alice@example.com", key: "inbox-filter", at: "2", dropped: true, versions: 0 },
      ]);
    },
    (admin) =>
      seedKeyValueTable(admin, "web_ui_state", {
        "U#1#canvas:s1": { value: { html: "<p/>" }, updatedAt: 3 },
        "alice@example.com#inbox-filter": { value: "all", updatedAt: 2 },
        "no-separator": { value: 1, updatedAt: 1 },
        "U2#theme": { value: "dark" },
        "U3#decimal": { value: 1, updatedAt: 1730000000000.5 },
        "U4#huge": { value: 1, updatedAt: -1e300 },
        "U5#text": { value: 1, updatedAt: "soon" },
      }),
  );
});

test(
  "row security alone hides other tenants' ui state from the app role and fails closed unbound",
  { skip },
  async () => {
    await withTypedTableDb(
      (url) => createPostgresUiStateStore(url),
      async ({ store, url, tenant, otherTenant }) => {
        await withTenant(tenant, () => store.put("U1", "theme", { value: "dark", updatedAt: 1 }));
        const app = createPgPool(url);
        try {
          const keys = (bound: string) => withTenant(bound, () => app.q(`SELECT key FROM web_ui_state`));
          assert.deepEqual(await keys(tenant), [{ key: "theme" }]);
          assert.deepEqual(await keys(otherTenant), []);
          await withoutTenant(() => assert.rejects(app.q(`SELECT key FROM web_ui_state`), /No tenant is bound/));
          await withoutTenant(() => assert.rejects(store.get("U1", "theme"), /No tenant is bound/));
          await withoutTenant(() =>
            assert.rejects(
              store.modify("U1", "theme", (c) => c!),
              /No tenant is bound/,
            ),
          );
        } finally {
          await app.close();
        }
      },
    );
  },
);
