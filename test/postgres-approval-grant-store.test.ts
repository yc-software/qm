import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresApprovalGrantStore } from "../src/core/approval-grant-store.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { withTenant } from "../src/tenants/context.ts";
import type { CommandApprovalGrant } from "../src/types.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;

const grant = (actorId: string, extra: Partial<CommandApprovalGrant> = {}): CommandApprovalGrant => ({
  actorId,
  command: "git push",
  scope: "always",
  createdAt: 10,
  ...extra,
});

test("grants are read by actor case-insensitively and only for the asked actors", { skip }, async () => {
  await withTypedTableDb(createPostgresApprovalGrantStore, ({ store, tenant }) =>
    withTenant(tenant, async () => {
      const session = grant("Alice@Example.com", { scope: "session", sessionId: "s1", approvalKey: "push" });
      await store.put("g1", session);
      await store.put("g2", grant("bob@example.com"));
      await store.put("g1", { ...session, createdAt: 11 });
      assert.deepEqual(await store.forActors(["alice@example.com"]), [{ ...session, createdAt: 11 }]);
      assert.deepEqual(await store.forActors(["ALICE@example.com", "alice@example.com"]), [
        { ...session, createdAt: 11 },
      ]);
      assert.deepEqual(await store.forActors(["bob@example.com"]), [grant("bob@example.com")]);
      assert.deepEqual(await store.forActors([]), []);
    }),
  );
});

test("grants are isolated per tenant and the same id can exist in both", { skip }, async () => {
  await withTypedTableDb(createPostgresApprovalGrantStore, async ({ store, tenant, otherTenant }) => {
    await withTenant(tenant, () => store.put("g1", grant("alice")));
    assert.deepEqual(await withTenant(otherTenant, () => store.forActors(["alice"])), []);
    await withTenant(otherTenant, () => store.put("g1", grant("alice", { command: "rm" })));
    assert.equal((await withTenant(tenant, () => store.forActors(["alice"])))[0]?.command, "git push");
    assert.equal((await withTenant(otherTenant, () => store.forActors(["alice"])))[0]?.command, "rm");
  });
});

test("the conversion backfills grants into the instance tenant and drops the old table", { skip }, async () => {
  const kept = grant("alice", { scope: "session", sessionId: "s1" });
  await withTypedTableDb(
    createPostgresApprovalGrantStore,
    async ({ store, admin, tenant }) => {
      assert.deepEqual(await withTenant(tenant, () => store.forActors(["alice"])), [kept]);
      const { rows } = await admin.query(
        `SELECT tenant_id::text AS tenant, id, to_regclass('approval_grants_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions WHERE tbl = 'approval_grants') AS versions
           FROM approval_grants`,
      );
      assert.deepEqual(rows, [{ tenant, id: "g1", dropped: true, versions: 0 }]);
    },
    (admin) =>
      seedKeyValueTable(admin, "approval_grants", {
        g1: kept,
        broken: { actorId: "bob", command: "x", scope: "once", createdAt: 1 },
      }),
  );
});

test(
  "row security alone hides other tenants' grants from the app role and fails closed unbound",
  { skip },
  async () => {
    await withTypedTableDb(createPostgresApprovalGrantStore, async ({ store, url, tenant, otherTenant }) => {
      await withTenant(tenant, () => store.put("g1", grant("alice")));
      const app = createPgPool(url);
      try {
        const rows = (bound: string) => withTenant(bound, () => app.q(`SELECT id FROM approval_grants`));
        assert.deepEqual(await rows(tenant), [{ id: "g1" }]);
        assert.deepEqual(await rows(otherTenant), []);
        await assert.rejects(app.q(`SELECT id FROM approval_grants`), /No tenant is bound/);
        await assert.rejects(store.forActors(["alice"]), /No tenant is bound/);
      } finally {
        await app.close();
      }
    });
  },
);
