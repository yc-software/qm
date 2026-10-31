import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "../src/tenants/context.ts";
import { createSandboxResourceStores } from "../src/sandbox/sandbox-resource-store.ts";
import { backfillProviderNames } from "../src/sandbox/provider-name-backfill.ts";
import type { Config } from "../src/config.ts";
import type { SandboxResource } from "../src/sandbox/sandbox-resources.ts";
import { DEPLOYMENT_LAYER, type StoredDeploymentLayer } from "../src/deployment/deployment-layer-store.ts";
import { pgRows, type RowTable } from "../src/persistence/keyed-rows.ts";

const table =
  <T, K extends string>(spec: RowTable<T, K>) =>
  (url: string) =>
    pgRows(url, spec);
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
                (SELECT array_agg(DISTINCT tenant_id::text) FROM sandbox_resources) AS tenants,
                to_regclass('sandbox_routing') AS routing, to_regclass('sandbox_resource_rollout') AS rollout,
                to_regclass('aws_sandbox_bodies') AS aws, to_regclass('superserve_config_epochs') AS epochs`,
      );
      assert.deepEqual(rows[0], {
        kv: null,
        versions: 0,
        tenants: [tenant],
        routing: null,
        rollout: null,
        aws: null,
        epochs: null,
      });
    },
    async (admin) => {
      await seedKeyValueTable(admin, "sandbox_resources", { "legacy-abc": legacy });
      await seedKeyValueTable(admin, "sandbox_routing", { "personal:alice": { backend: "modal" } });
      await seedKeyValueTable(admin, "sandbox_resource_rollout", { "explicit-defaults": { activatedAt: "x" } });
      await seedKeyValueTable(admin, "aws_sandbox_bodies", { "personal:bob": { microvmId: "vm" } });
      await seedKeyValueTable(admin, "superserve_config_epochs", { gen: { generation: 1 } });
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

test(
  "existing computers get today's provider names once, and stored names are never overwritten",
  { skip },
  async () => {
    await withTypedTableDb(createSandboxResourceStores, async ({ store, admin, tenant, otherTenant }) => {
      await withTenant(tenant, async () => {
        await store.records.put("legacy", resource("legacy", { backingScopeId: "personal:alice", legacy: true }));
        await store.records.put("named", resource("named", { providerName: "qmt-tenant-name" }));
        await store.records.put("modal", resource("modal", { backend: "modal" }));
      });
      await withTenant(otherTenant, () =>
        store.records.put("smol", resource("smol", { backend: "smolmachines", backingScopeId: "sandbox-b" })),
      );
      const config = {
        databaseUrl: String(admin.options.connectionString),
        spritesSandbox: { namePrefix: "qmt" },
        smolmachinesSandbox: { namePrefix: "a-very-long-deployment-prefix-that-eats-the-budget" },
      } as unknown as Config;
      assert.equal(await backfillProviderNames(config), 2);
      await withTenant(tenant, () =>
        store.records.put("late", resource("late", { backingScopeId: "personal:late", legacy: true })),
      );
      assert.equal(await backfillProviderNames(config), 0);
      await withTenant(tenant, async () => {
        assert.equal(await store.records.providerName("sprites", "personal:alice"), "qmt-personal-alice-84c212");
        assert.equal(await store.records.providerName("sprites", "sandbox-named"), "qmt-tenant-name");
        assert.equal(await store.records.providerName("modal", "sandbox-modal"), null);
        assert.equal(await store.records.providerName("sprites", "personal:late"), null);
        assert.equal(await store.records.providerName("smolmachines", "sandbox-b"), null);
      });
      await withTenant(otherTenant, async () => {
        assert.equal(
          await store.records.providerName("smolmachines", "sandbox-b"),
          "a-very-long-deployment-prefix-that-eats-the-budget-sandb-206483",
        );
      });
    });
  },
);

test("the deployment layer row backfills and stays per tenant", { skip }, async () => {
  const layer: StoredDeploymentLayer = {
    contentHash: "abc",
    version: 3,
    updatedAt: 1_730_000_000_000,
    updatedBy: "admin",
    bundle: { contract: 1, tools: [], skills: [] },
    resolved: { tools: [], installFiles: [], advertisedTools: [], credentialPaths: [], brokeredTools: [] },
    pendingAudits: [{ contentHash: "abc", version: 3, updatedAt: 1, updatedBy: "admin" }],
  } as unknown as StoredDeploymentLayer;
  await withTypedTableDb(
    table(DEPLOYMENT_LAYER),
    async ({ store, tenant, otherTenant }) => {
      await withTenant(tenant, async () => assert.deepEqual(await store.get("current"), layer));
      await withTenant(otherTenant, async () => {
        assert.equal(await store.get("current"), null);
        assert.equal(await store.update("current", (current) => ({ ...current, version: 9 })), null);
        assert.equal((await store.putIfAbsent("current", { ...layer, contentHash: "mine" })).contentHash, "mine");
      });
      await withTenant(tenant, async () => {
        const next = await store.update("current", (current) => ({ ...current, version: 4, pendingAudits: undefined }));
        assert.equal(next?.version, 4);
        const { pendingAudits: _cleared, ...rest } = layer;
        assert.deepEqual(await store.get("current"), { ...rest, version: 4 });
      });
    },
    (admin) => seedKeyValueTable(admin, "deployment_layer", { current: layer }),
  );
});
