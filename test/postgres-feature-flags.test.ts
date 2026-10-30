import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresFeatureFlagStore } from "../src/feature-flags.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { withTenant } from "../src/tenants/context.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;

test("feature flags map each feature to enabled scopes and the org scope enables it everywhere", { skip }, async () => {
  await withTypedTableDb(
    (url) => createPostgresFeatureFlagStore(url, { now: () => 7 }),
    async ({ store, tenant }) =>
      withTenant(tenant, async () => {
        assert.equal(await store.enabled("inbox_loops", "channel:C1"), false);
        await store.setEnabled("inbox_loops", "personal:U1", true, "admin");
        const record = await store.setEnabled("inbox_loops", "channel:C1", true, "admin");
        await store.setEnabled("inbox_loops", "channel:C1", true, "admin");
        assert.deepEqual(record, {
          featureName: "inbox_loops",
          enabledScopes: ["channel:C1", "personal:U1"],
          updatedAt: 7,
          updatedBy: "admin",
        });
        assert.equal(await store.enabled("inbox_loops", "channel:C1"), true);
        assert.equal(await store.enabled("inbox_loops", "channel:C2"), false);
        assert.equal(await store.enabled("persistent_subagents", "personal:U1"), false);
        await store.setEnabled("responsive_spine", "personal:U1", true, "admin");
        assert.deepEqual([...(await store.enabledFor("personal:U1"))].sort(), ["inbox_loops", "responsive_spine"]);
        await store.setEnabled("inbox_loops", "channel:C1", false, "admin");
        assert.equal(await store.enabled("inbox_loops", "channel:C1"), false);
        await store.setEnabled("swarms", "org:default-org", true, "admin");
        assert.equal(await store.enabled("swarms", "channel:C9"), true);
        assert.deepEqual(
          (await store.list()).map((row) => [row.featureName, row.enabledScopes]),
          [
            ["inbox_loops", ["personal:U1"]],
            ["responsive_spine", ["personal:U1"]],
            ["swarms", ["org:default-org"]],
          ],
        );
        await assert.rejects(store.setEnabled("swarms", "personal:U1", true, " "), /must not be empty/);
      }),
  );
});

test("feature flag rows are scoped to their tenant", { skip }, async () => {
  await withTypedTableDb(
    (url) => createPostgresFeatureFlagStore(url),
    async ({ store, tenant, otherTenant }) => {
      await withTenant(tenant, () => store.setEnabled("swarms", "org:default-org", true, "admin"));
      assert.equal(await withTenant(otherTenant, () => store.enabled("swarms", "personal:U1")), false);
      assert.deepEqual(await withTenant(otherTenant, () => store.list()), []);
      await withTenant(otherTenant, () => store.setEnabled("swarms", "personal:U2", true, "other-admin"));
      assert.deepEqual(
        (await withTenant(tenant, () => store.list())).map((row) => row.enabledScopes),
        [["org:default-org"]],
      );
      assert.deepEqual(
        (await withTenant(otherTenant, () => store.list())).map((row) => row.enabledScopes),
        [["personal:U2"]],
      );
    },
  );
});

test("the conversion carries flags into the instance tenant and the store hides retired ones", { skip }, async () => {
  await withTypedTableDb(
    (url) => createPostgresFeatureFlagStore(url),
    async ({ store, admin, tenant }) => {
      assert.equal(await withTenant(tenant, () => store.enabled("inbox_loops", "channel:C1")), true);
      assert.deepEqual(
        (await withTenant(tenant, () => store.list())).map((row) => row.featureName),
        ["inbox_loops"],
      );
      assert.deepEqual([...(await withTenant(tenant, () => store.enabledFor("channel:C1")))], ["inbox_loops"]);
      const { rows } = await admin.query(
        `SELECT tenant_id::text AS tenant, feature_name, enabled_scopes, updated_at::text AS at, updated_by,
                to_regclass('feature_flags_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions WHERE tbl = 'feature_flags') AS versions
           FROM feature_flags ORDER BY feature_name`,
      );
      assert.deepEqual(rows, [
        {
          tenant,
          feature_name: "command_scoped_credentials",
          enabled_scopes: ["channel:C1"],
          at: "1",
          updated_by: "admin",
          dropped: true,
          versions: 0,
        },
        {
          tenant,
          feature_name: "inbox_loops",
          enabled_scopes: ["channel:C1", "personal:U1"],
          at: "5",
          updated_by: "admin",
          dropped: true,
          versions: 0,
        },
      ]);
    },
    (admin) =>
      seedKeyValueTable(admin, "feature_flags", {
        inbox_loops: {
          featureName: "inbox_loops",
          enabledScopes: ["channel:C1", "personal:U1"],
          updatedAt: 5,
          updatedBy: "admin",
        },
        command_scoped_credentials: {
          featureName: "command_scoped_credentials",
          enabledScopes: ["channel:C1"],
          updatedAt: 1,
          updatedBy: "admin",
        },
        swarms: { featureName: "swarms", updatedAt: 1 },
      }),
  );
});

test("row security alone hides other tenants' flags from the app role and fails closed unbound", { skip }, async () => {
  await withTypedTableDb(
    (url) => createPostgresFeatureFlagStore(url),
    async ({ store, url, tenant, otherTenant }) => {
      await withTenant(tenant, () => store.setEnabled("swarms", "personal:U1", true, "admin"));
      const app = createPgPool(url);
      try {
        const names = (bound: string) => withTenant(bound, () => app.q(`SELECT feature_name FROM feature_flags`));
        assert.deepEqual(await names(tenant), [{ feature_name: "swarms" }]);
        assert.deepEqual(await names(otherTenant), []);
        await assert.rejects(app.q(`SELECT feature_name FROM feature_flags`), /No tenant is bound/);
        await assert.rejects(store.list(), /No tenant is bound/);
      } finally {
        await app.close();
      }
    },
  );
});
