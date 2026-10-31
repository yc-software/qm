import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresContextRequestStore } from "../src/api/context-request-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { withoutTenant, withTenant } from "../src/tenants/context.ts";
import type { SurfaceContextRequest } from "../src/reach/reach.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;

const request = (id: string, source: string, createdAt: number): SurfaceContextRequest => ({
  id,
  source,
  createdAt,
  status: "pending",
  query: { channelId: "C1", count: 5, viewer: "alice" },
});

test("pending reads return only the source's unexpired pending requests", { skip }, async () => {
  await withTypedTableDb(createPostgresContextRequestStore, ({ store, tenant }) =>
    withTenant(tenant, async () => {
      await store.create(request("old", "slack", 100));
      await store.create(request("new", "slack", 500));
      await store.create(request("web", "web", 500));
      await store.create(request("answered", "slack", 600));
      assert.equal(await store.settle("answered", { status: "done", result: { messages: ["hi"] } }), true);
      assert.deepEqual(
        (await store.pending("slack", 200)).map((r) => r.id),
        ["new"],
      );
      assert.deepEqual(await store.expirePending(200), ["old"]);
      assert.equal(await store.get("old"), null);
      assert.deepEqual(await store.get("answered"), {
        ...request("answered", "slack", 600),
        status: "done",
        result: { messages: ["hi"] },
      });
      assert.equal(await store.settle("new", { status: "failed", error: "nope" }), true);
      assert.deepEqual(await store.get("new"), { ...request("new", "slack", 500), status: "failed", error: "nope" });
      assert.equal(await store.settle("missing", { status: "failed", error: "x" }), false);
      await store.delete("new");
      assert.equal(await store.get("new"), null);
    }),
  );
});

test("context requests are isolated per tenant", { skip }, async () => {
  await withTypedTableDb(createPostgresContextRequestStore, async ({ store, tenant, otherTenant }) => {
    await withTenant(tenant, () => store.create(request("r1", "slack", 100)));
    await withTenant(otherTenant, async () => {
      assert.equal(await store.get("r1"), null);
      assert.deepEqual(await store.pending("slack", 0), []);
      assert.deepEqual(await store.expirePending(1_000), []);
      assert.equal(await store.settle("r1", { status: "failed", error: "x" }), false);
      await store.create(request("r1", "slack", 200));
    });
    assert.equal((await withTenant(tenant, () => store.get("r1")))?.createdAt, 100);
    assert.equal((await withTenant(otherTenant, () => store.get("r1")))?.createdAt, 200);
  });
});

test("the conversion backfills context requests into the instance tenant", { skip }, async () => {
  const kept = { ...request("r1", "slack", 100), status: "done" as const, result: { messages: [], note: "n" } };
  await withTypedTableDb(
    createPostgresContextRequestStore,
    async ({ store, admin, tenant }) => {
      assert.deepEqual(await withTenant(tenant, () => store.get("r1")), kept);
      const { rows } = await admin.query(
        `SELECT tenant_id::text AS tenant, id, to_regclass('context_requests_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions WHERE tbl = 'context_requests') AS versions
           FROM context_requests`,
      );
      assert.deepEqual(rows, [{ tenant, id: "r1", dropped: true, versions: 0 }]);
    },
    (admin) =>
      seedKeyValueTable(admin, "context_requests", {
        r1: kept,
        broken: { id: "broken", source: "slack", createdAt: 1, status: "pending" },
      }),
  );
});

test(
  "row security alone hides other tenants' context requests from the app role and fails closed unbound",
  { skip },
  async () => {
    await withTypedTableDb(createPostgresContextRequestStore, async ({ store, url, tenant, otherTenant }) => {
      await withTenant(tenant, () => store.create(request("r1", "slack", 1)));
      const app = createPgPool(url);
      try {
        const rows = (bound: string) => withTenant(bound, () => app.q(`SELECT id FROM context_requests`));
        assert.deepEqual(await rows(tenant), [{ id: "r1" }]);
        assert.deepEqual(await rows(otherTenant), []);
        await withoutTenant(async () => {
          await assert.rejects(app.q(`SELECT id FROM context_requests`), /No tenant is bound/);
          await assert.rejects(store.pending("slack", 0), /No tenant is bound/);
        });
      } finally {
        await app.close();
      }
    });
  },
);
