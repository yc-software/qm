import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { withTenant } from "../src/tenants/context.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;
const COMMITTED_AT = Date.now() - 60_000;

test("a committed key survives a restart and stays scoped to its tenant", { skip }, async () => {
  await withTypedTableDb(
    (url) => createPostgresIdempotencyStore(url),
    async ({ store, url, tenant, otherTenant }) => {
      let runs = 0;
      assert.equal(await withTenant(tenant, () => store.once("webhook:w1:d1", async () => void runs++)), true);
      const restarted = createPostgresIdempotencyStore(url);
      try {
        assert.equal(await withTenant(tenant, () => restarted.committed("webhook:w1:d1")), true);
        assert.equal(await withTenant(tenant, () => restarted.once("webhook:w1:d1", async () => void runs++)), false);
        assert.equal(await withTenant(otherTenant, () => restarted.committed("webhook:w1:d1")), false);
        assert.equal(await withTenant(otherTenant, () => store.committed("webhook:w1:d1")), false);
        assert.equal(
          await withTenant(otherTenant, () => restarted.once("webhook:w1:d1", async () => void runs++)),
          true,
        );
        assert.equal(runs, 2);
      } finally {
        await restarted.close?.();
      }
    },
  );
});

test("retention prunes only the current tenant's expired rows", { skip }, async () => {
  let t = 0;
  await withTypedTableDb(
    (url) => createPostgresIdempotencyStore(url, { retentionMs: 100, pruneIntervalMs: 1, now: () => t }),
    async ({ store, admin, tenant, otherTenant }) => {
      t = 10;
      await withTenant(tenant, () => store.once("old", async () => {}));
      await withTenant(otherTenant, () => store.once("old", async () => {}));
      t = 500;
      await withTenant(tenant, () => store.once("fresh", async () => {}));
      const keys = async () =>
        (await admin.query(`SELECT tenant_id::text AS tenant, key FROM idempotency ORDER BY key, tenant_id`)).rows;
      for (let i = 0; i < 50 && (await keys()).length === 3; i++) await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(await keys(), [
        { tenant, key: "fresh" },
        { tenant: otherTenant, key: "old" },
      ]);
    },
  );
});

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
        await assert.rejects(app.q(`SELECT key FROM idempotency`), /No tenant is bound/);
        await assert.rejects(store.committed("k"), /No tenant is bound/);
      } finally {
        await app.close();
      }
    },
  );
});
