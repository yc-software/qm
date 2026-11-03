import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { withTenant, withoutTenant } from "../src/tenants/context.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;
const COMMITTED_AT = Date.now() - 60_000;

test("the conversion backfills committed keys into the instance tenant and drops the old table", { skip }, async () => {
  await withTypedTableDb(
    (url) => createPostgresIdempotencyStore(url),
    async ({ store, admin, tenant }) => {
      assert.equal(await withTenant(tenant, () => store.committed("cron:c1:fire")), true);
      const { rows } = await admin.query(
        `SELECT tenant_id::text AS tenant, key, committed_at::text AS at,
                to_regclass('idempotency_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions WHERE tbl = 'idempotency') AS versions
           FROM idempotency`,
      );
      assert.deepEqual(rows, [{ tenant, key: "cron:c1:fire", at: String(COMMITTED_AT), dropped: true, versions: 0 }]);
    },
    (admin) =>
      seedKeyValueTable(admin, "idempotency", {
        "cron:c1:fire": { key: "cron:c1:fire", at: COMMITTED_AT },
        broken: { key: "broken" },
      }),
  );
});

test("row security alone hides other tenants' keys from the app role and fails closed unbound", { skip }, async () => {
  await withTypedTableDb(
    (url) => createPostgresIdempotencyStore(url),
    async ({ store, url, tenant, otherTenant }) => {
      await withTenant(tenant, () => store.once("k", async () => {}));
      const app = createPgPool(url);
      try {
        const keys = (bound: string) => withTenant(bound, () => app.q(`SELECT key FROM idempotency`));
        assert.deepEqual(await keys(tenant), [{ key: "k" }]);
        assert.deepEqual(await keys(otherTenant), []);
        await withoutTenant(() => assert.rejects(app.q(`SELECT key FROM idempotency`), /No tenant is bound/));
        await withoutTenant(() => assert.rejects(store.committed("k"), /No tenant is bound/));
      } finally {
        await app.close();
      }
    },
  );
});
