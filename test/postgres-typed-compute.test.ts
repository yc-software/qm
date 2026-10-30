import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "../src/tenants/context.ts";
import { createSandboxResourceStores } from "../src/sandbox/sandbox-resource-store.ts";
import type { SandboxResource } from "../src/sandbox/sandbox-resources.ts";
import { seedKeyValueTable, skipWithoutPg as skip, withTypedTableDb } from "./support/typed-table.ts";

const resource = (id: string, extra: Partial<SandboxResource> = {}): SandboxResource => ({
  id,
  backend: "sprites",
  ownerScopeId: "personal:alice",
  backingScopeId: `sandbox-${id}`,
  name: "build",
  createdBy: "alice",
  createdAt: "2026-10-01T00:00:00.000Z",
  legacy: false,
  state: "ready",
  ...extra,
});

test("sandbox resources and defaults backfill from key-value rows onto the existing tenant", { skip }, async () => {
  const legacy = resource("legacy-abc", {
    backend: "modal",
    backingScopeId: "personal:alice",
    legacy: true,
    state: "unverified",
    machineId: "sb-1",
    holders: ["run-1"],
    spec: { os: "Linux", runtimes: ["Node"] },
  });
  await withTypedTableDb(
    createSandboxResourceStores,
    async ({ store, admin, tenant }) => {
      await withTenant(tenant, async () => {
        assert.deepEqual(await store.records.get("legacy-abc"), legacy);
        assert.deepEqual(await store.defaults.get("personal:alice"), { sandboxId: "legacy-abc" });
        assert.deepEqual(await store.defaults.get("personal:cleared"), {});
      });
      const { rows } = await admin.query(
        `SELECT to_regclass('sandbox_resources_kv') AS kv, (SELECT count(*)::int FROM durable_map_versions) AS versions,
                (SELECT array_agg(DISTINCT tenant_id::text) FROM sandbox_resources) AS tenants`,
      );
      assert.deepEqual(rows[0], { kv: null, versions: 0, tenants: [tenant] });
    },
    async (admin) => {
      await seedKeyValueTable(admin, "sandbox_resources", { "legacy-abc": legacy });
      await seedKeyValueTable(admin, "sandbox_defaults", {
        "personal:alice": { sandboxId: "legacy-abc" },
        "personal:cleared": { sandboxId: null },
      });
    },
  );
});

test("sandbox resources and defaults stay inside their tenant", { skip }, async () => {
  await withTypedTableDb(createSandboxResourceStores, async ({ store, tenant, otherTenant }) => {
    await withTenant(tenant, async () => {
      await store.records.put("a", resource("a", { holders: [] }));
      await store.records.put("job", resource("job", { jobOnly: true }));
      await store.defaults.put("personal:alice", { sandboxId: "a" });
    });
    await withTenant(otherTenant, async () => {
      assert.equal(await store.records.get("a"), null);
      assert.deepEqual(await store.records.owners(), []);
      assert.deepEqual(await store.records.jobComputers(), []);
      assert.equal(await store.defaults.get("personal:alice"), null);
      await store.records.put("a", resource("a", { ownerScopeId: "personal:bob" }));
      assert.equal(await store.records.update("job", (r) => ({ ...r, state: "retired" })), null);
      await store.records.delete("job");
    });
    await withTenant(tenant, async () => {
      assert.equal((await store.records.get("a"))?.ownerScopeId, "personal:alice");
      assert.deepEqual(await store.records.owners(), ["personal:alice"]);
      assert.deepEqual(
        (await store.records.ownedBy(["personal:alice", "personal:bob"])).map((r) => r.id),
        ["a"],
      );
      assert.deepEqual(
        (await store.records.jobComputers()).map((r) => r.id),
        ["job"],
      );
      const held = await store.records.update("a", (r) => ({ ...r, holders: [...(r.holders ?? []), "run-2"] }));
      assert.deepEqual(held?.holders, ["run-2"]);
      assert.deepEqual((await store.records.get("a"))?.holders, ["run-2"]);
    });
  });
});
