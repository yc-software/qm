import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresMemoryTidyProfiles } from "../src/memory/tidy-profiles.ts";
import { createPostgresSuggestedActivityProfiles } from "../src/suggestions/activity-profiles.ts";
import { withTenant } from "../src/tenants/context.ts";
import { seedKeyValueTable, skipWithoutPg, withTypedTableDb } from "./support/typed-table.ts";

const skip = skipWithoutPg;

test("memory tidy claims are per tenant and update atomically", { skip }, async () => {
  await withTypedTableDb(
    (url) => createPostgresMemoryTidyProfiles(url),
    async ({ store: profiles, tenant, otherTenant }) => {
      await withTenant(tenant, async () => {
        assert.deepEqual(await profiles.insertIfAbsent("channel:C1", {}), {});
        assert.deepEqual(await profiles.update("channel:C1", () => ({ cronId: "c1", arming: true })), {
          cronId: "c1",
          arming: true,
        });
        assert.deepEqual(await profiles.insertIfAbsent("channel:C1", {}), { cronId: "c1", arming: true });
        await profiles.update("channel:C1", ({ arming: _arming, ...rest }) => rest);
        assert.deepEqual(await profiles.get("channel:C1"), { cronId: "c1" });
      });
      await withTenant(otherTenant, async () => {
        assert.equal(await profiles.get("channel:C1"), null);
        assert.equal(await profiles.update("channel:C1", () => ({ cronId: "stolen" })), null);
      });
      assert.deepEqual(await withTenant(tenant, () => profiles.get("channel:C1")), { cronId: "c1" });
      await assert.rejects(profiles.get("channel:C1"), /No tenant is bound/);
    },
  );
});

test("suggested activity profiles keep seeds and dismissals per tenant", { skip }, async () => {
  const seeds = [{ id: "s1", title: "Plan the week", prompt: "Let's plan the week.", icon: "📅" }];
  await withTypedTableDb(
    (url) => createPostgresSuggestedActivityProfiles(url),
    async ({ store: profiles, tenant, otherTenant }) => {
      await withTenant(tenant, async () => {
        await profiles.insertIfAbsent("alice", { timezone: "Europe/Paris", lastSeenAt: 5 });
        const updated = await profiles.update("alice", (p) => ({
          ...p,
          seeds,
          dismissed: [{ id: "x", title: "Old idea", at: 7 }],
          managedAction: "refresh",
          lastBootstrapAt: 9,
        }));
        assert.deepEqual(await profiles.get("alice"), updated);
      });
      await withTenant(otherTenant, async () => {
        assert.deepEqual(await profiles.insertIfAbsent("alice", { timezone: "UTC", lastSeenAt: 1 }), {
          timezone: "UTC",
          lastSeenAt: 1,
        });
      });
      assert.equal((await withTenant(tenant, () => profiles.get("alice")))?.timezone, "Europe/Paris");
    },
  );
});

test("the profile conversions backfill key-value rows into the instance tenant", { skip }, async () => {
  const profile = {
    timezone: "America/Chicago",
    lastSeenAt: 1_700_000_000_000,
    cronId: "c9",
    managedAction: "refresh suggestions",
    seeds: [{ id: "s", title: "T", prompt: "P", icon: "✨" }],
  };
  await withTypedTableDb(
    (url) => {
      const tidy = createPostgresMemoryTidyProfiles(url);
      const activities = createPostgresSuggestedActivityProfiles(url);
      return { tidy, activities, close: async () => void (await Promise.all([tidy.close(), activities.close()])) };
    },
    async ({ store, admin, tenant }) => {
      await withTenant(tenant, async () => {
        assert.deepEqual(await store.tidy.get("personal:alice"), { cronId: "c3" });
        assert.deepEqual(await store.activities.get("alice"), profile);
      });
      const { rows } = await admin.query(
        `SELECT to_regclass('memory_tidy_profiles_kv') IS NULL AND to_regclass('suggested_activity_profiles_kv') IS NULL AS dropped,
                (SELECT count(*)::int FROM durable_map_versions) AS versions`,
      );
      assert.deepEqual(rows, [{ dropped: true, versions: 0 }]);
    },
    async (admin) => {
      await seedKeyValueTable(admin, "memory_tidy_profiles", { "personal:alice": { cronId: "c3" } });
      await seedKeyValueTable(admin, "suggested_activity_profiles", { alice: profile });
    },
  );
});
