import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAdminGrantStore,
  grantKey,
  type AdminGrant,
  type AdminGrantPersistence,
} from "../../src/admin/admin-grant-store.ts";
import { createPostgresAdminGrantStore } from "../../src/admin/postgres-admin-grant-store.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { scopeId } from "../../src/types.ts";

test("grant store: add / list / revoke round-trip on (principal, scope, role)", async () => {
  const store = createAdminGrantStore(createPostgresAdminGrantStore(testDatabaseUrl()));
  assert.deepEqual(await store.list(), []);
  await store.add({ principalId: "U1", scopeId: "org:default-org", role: "org_admin" });
  await store.add({ principalId: "U2", scopeId: "org:default-org", role: "org_admin" });
  assert.equal((await store.list()).length, 2);
  await store.add({ principalId: "U1", scopeId: "org:default-org", role: "org_admin", grantedBy: "x" });
  assert.equal((await store.list()).length, 2);
  await store.add({ principalId: "U2", scopeId: "org:other", role: "org_admin" });
  assert.equal((await store.list()).length, 3);
  await store.revoke("U1", "org:default-org", "org_admin");
  const list = await store.list();
  assert.equal(list.length, 2);
  assert.ok(!list.some((g) => g.principalId === "U1"));
});

test("grant store: seed applies only when empty and never undoes a revoke", async () => {
  const persist = createPostgresAdminGrantStore(testDatabaseUrl());
  const seed = [{ principalId: "A", scopeId: "org:default-org", role: "org_admin" as const }];
  const store = createAdminGrantStore(persist, { seed: () => seed });
  assert.equal((await store.list()).length, 1);
  await store.revoke("A", "org:default-org", "org_admin");
  assert.equal((await store.list()).length, 0);

  await persist.put({ principalId: "B", scopeId: "org:default-org", role: "org_admin" });
  const store2 = createAdminGrantStore(persist, { seed: () => seed });
  assert.deepEqual(
    (await store2.list()).map((g) => g.principalId),
    ["B"],
  );
});

test("grant store: an empty seed grants no admins (deliberate lock-out)", async () => {
  const store = createAdminGrantStore(createPostgresAdminGrantStore(testDatabaseUrl()), { seed: () => [] });
  assert.deepEqual(await store.list(), []);
});

test("grantKey is stable and collision-free across the triple", () => {
  assert.equal(grantKey("U1", "org:default-org", "org_admin"), grantKey("U1", "org:default-org", "org_admin"));
  assert.notEqual(grantKey("U1", "org:default-org", "org_admin"), grantKey("U1", "org:other", "org_admin"));
  assert.notEqual(grantKey("U1", "org:default-org", "org_admin"), grantKey("U2", "org:default-org", "org_admin"));
});

test("admin grants: a failed seed is retried on the next call (rejection not cached)", async () => {
  let failures = 1;
  const rows: AdminGrant[] = [];
  const persist: AdminGrantPersistence = {
    async insertIfAbsent() {
      throw new Error("not exercised");
    },
    async all() {
      if (failures > 0) {
        failures--;
        throw new Error("transient pg failure");
      }
      return [...rows];
    },
    async put(g) {
      rows.push(g);
    },
    async remove() {},
  };
  const store = createAdminGrantStore(persist, {
    seed: () => [{ principalId: "p", scopeId: scopeId("personal", "p"), role: "org_admin" }],
  });
  await assert.rejects(() => store.list(), /transient pg failure/);
  const listed = await store.list();
  assert.equal(listed.length, 1, "second call re-runs seeding and lists the seeded grant");
});
