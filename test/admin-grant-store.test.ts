import { test } from "node:test";
import assert from "node:assert/strict";
import { createAdminGrantStore, createMemoryAdminGrantPersistence, grantKey } from "../src/admin/admin-grant-store.ts";

test("grant store: add / list / revoke round-trip on (principal, scope, role)", async () => {
  const store = createAdminGrantStore();
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

test("grant store: configured bootstrap grants apply at each boot", async () => {
  const persist = createMemoryAdminGrantPersistence();
  const bootstrap = [{ principalId: "A", scopeId: "org:default-org", role: "org_admin" as const }];
  const store = createAdminGrantStore(persist, { bootstrap });
  assert.equal((await store.list()).length, 1);
  await store.revoke("A", "org:default-org", "org_admin");
  assert.equal((await store.list()).length, 0);

  const store2 = createAdminGrantStore(persist, { bootstrap });
  assert.deepEqual(
    (await store2.list()).map((g) => g.principalId),
    ["A"],
  );
});

test("grant store: changed bootstrap grants replace stale bootstrap rows without touching durable grants", async () => {
  const persist = createMemoryAdminGrantPersistence();
  const oldBootstrap = [{ principalId: "old-admin@example.test", scopeId: "org:acme", role: "org_admin" as const }];
  const firstBoot = createAdminGrantStore(persist, { bootstrap: oldBootstrap });
  await firstBoot.list();
  await firstBoot.add({
    principalId: "operator-admin@example.test",
    scopeId: "org:acme",
    role: "org_admin",
    grantedBy: "owner@example.test",
    createdAt: 1,
  });
  await persist.put({ principalId: "legacy-admin@example.test", scopeId: "org:acme", role: "org_admin" });

  const secondBoot = createAdminGrantStore(persist, {
    bootstrap: [{ principalId: "new-admin@example.test", scopeId: "org:acme", role: "org_admin" }],
  });

  assert.deepEqual((await secondBoot.list()).map((g) => g.principalId).sort(), [
    "legacy-admin@example.test",
    "new-admin@example.test",
    "operator-admin@example.test",
  ]);
  assert.deepEqual(
    (await secondBoot.list()).find((g) => g.principalId === "new-admin@example.test"),
    {
      principalId: "new-admin@example.test",
      scopeId: "org:acme",
      role: "org_admin",
      grantedBy: "system",
      createdAt: 0,
    },
  );

  const unchangedBoot = createAdminGrantStore(persist, {
    bootstrap: [{ principalId: "new-admin@example.test", scopeId: "org:acme", role: "org_admin" }],
  });
  assert.deepEqual(await unchangedBoot.list(), await secondBoot.list());

  const removedConfigBoot = createAdminGrantStore(persist, { bootstrap: [] });
  assert.deepEqual((await removedConfigBoot.list()).map((g) => g.principalId).sort(), [
    "legacy-admin@example.test",
    "operator-admin@example.test",
  ]);
});

test("grant store: an operator-owned replacement of a bootstrap row survives config removal", async () => {
  const persist = createMemoryAdminGrantPersistence();
  const bootstrap = [{ principalId: "admin@example.test", scopeId: "org:acme", role: "org_admin" as const }];
  const firstBoot = createAdminGrantStore(persist, { bootstrap });
  await firstBoot.list();
  await firstBoot.add({ ...bootstrap[0]!, grantedBy: "owner@example.test", createdAt: 10 });

  const removedConfigBoot = createAdminGrantStore(persist, { bootstrap: [] });
  assert.deepEqual(await removedConfigBoot.list(), [
    { ...bootstrap[0]!, grantedBy: "owner@example.test", createdAt: 10 },
  ]);
});

test("grant store: an empty bootstrap grants no admins (deliberate lock-out)", async () => {
  const store = createAdminGrantStore(createMemoryAdminGrantPersistence(), { bootstrap: [] });
  assert.deepEqual(await store.list(), []);
});

test("grantKey is stable and collision-free across the triple", () => {
  assert.equal(grantKey("U1", "org:default-org", "org_admin"), grantKey("U1", "org:default-org", "org_admin"));
  assert.notEqual(grantKey("U1", "org:default-org", "org_admin"), grantKey("U1", "org:other", "org_admin"));
  assert.notEqual(grantKey("U1", "org:default-org", "org_admin"), grantKey("U2", "org:default-org", "org_admin"));
});
