import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "../src/tenants/context.ts";
import { globalConversion, tableConversion, typedTable, type TableSpec } from "../src/persistence/typed-table.ts";
import { E2B_SANDBOX_BODIES } from "../src/sandbox/e2b-sandbox.ts";
import { MODAL_SANDBOX_BODIES } from "../src/sandbox/modal-sandbox.ts";
import { AWS_SANDBOX_BODIES } from "../src/sandbox/aws-sandbox.ts";
import { MANAGED_AGENTS_SANDBOX_BODIES } from "../src/sandbox/managed-agents-sandbox.ts";
import { SMOLMACHINES_SANDBOX_BODIES } from "../src/sandbox/smolmachines-sandbox.ts";
import { SPRITES_INITIALIZATION } from "../src/sandbox/sprites-sandbox.ts";
import { SUPERSERVE_CONFIG_EPOCHS, SUPERSERVE_SANDBOX_BODIES } from "../src/sandbox/superserve-sandbox.ts";
import { RENDER_SANDBOX_BODIES, RENDER_SANDBOX_CLEANUP, RENDER_SCRATCH_BODIES } from "../src/sandbox/render-sandbox.ts";
import { AWS_DEPLOY_BODIES } from "../src/deploy/aws-deploy-provider.ts";
import { E2B_DEPLOY_BODIES } from "../src/deploy/e2b-deploy-provider.ts";
import { PORTER_DEPLOY_BODIES } from "../src/deploy/porter-deploy-provider.ts";
import { RENDER_DEPLOY_BODIES } from "../src/deploy/render-deploy-provider.ts";
import { RENDER_DEPLOY_CREDENTIALS } from "../src/deploy/render-deploy-artifacts.ts";
import { RENDER_APP_STORAGE } from "../src/deploy/render-app-storage.ts";
import { FLY_DEPLOY_CONFIGS, createFlyPortClaims } from "../src/deploy/fly-deploy-stores.ts";
import { FLY_PEER_CLAIMS } from "../src/deploy/fly-peer-claims.ts";
import { seedKeyValueTable, skipWithoutPg as skip, withTypedTableDb } from "./support/typed-table.ts";

type Spec = TableSpec<object, string>;

const rows: Array<[Spec, string, Record<string, unknown>]> = [
  [
    E2B_SANDBOX_BODIES as Spec,
    "personal:alice",
    {
      sandboxId: "sb-1",
      nativePause: true,
      preservationState: "paused",
      recoverySnapshotId: "snap-1",
      createdAtMs: 1_730_000_000_000,
      lastSnapshotMs: 1_730_000_000_500,
      homeDirty: false,
    },
  ],
  [
    MODAL_SANDBOX_BODIES as Spec,
    "sandbox-abc",
    {
      sandboxId: "sb-2",
      hydrationPending: false,
      nativeSnapshotId: "im-1",
      nativeSnapshotExpiresAtMs: 1_730_000_100_000,
      snapshotGeneration: 4,
      createdAtMs: 1_730_000_000_000,
      lastActivityMs: 1_730_000_000_900,
      orgId: "org-1",
    },
  ],
  [
    AWS_SANDBOX_BODIES as Spec,
    "personal:bob",
    { microvmId: "vm-1", endpoint: "https://vm-1", createdAtMs: 1, provisioning: true, lastActivityMs: 2 },
  ],
  [
    MANAGED_AGENTS_SANDBOX_BODIES as Spec,
    "channel:C1",
    {
      sessionId: "sess-1",
      sandboxId: "sb-3",
      preservationState: "running",
      createdAtMs: 1,
      checkpointId: "cp-1",
      checkpointAtMs: 2,
      pendingCheckpointDeletes: ["cp-0"],
    },
  ],
  [SMOLMACHINES_SANDBOX_BODIES as Spec, "personal:carol", { initializationPending: true, snapshotError: "boom" }],
  [SPRITES_INITIALIZATION as Spec, "qm-sandbox-1", { pending: true }],
  [SUPERSERVE_SANDBOX_BODIES as Spec, "personal:dan", { sandboxId: "ss-1", createdAtMs: 9 }],
  [
    RENDER_SANDBOX_BODIES as Spec,
    "personal:erin",
    {
      sandboxId: "rs-1",
      checkpoint: { id: "snap", sandboxGroupId: "g", status: "available", expiresAtMs: 5 },
      expiresAtMs: 10,
      lastActivityMs: 3,
      retiredResources: [{ sandboxId: "rs-0" }],
    },
  ],
  [RENDER_SCRATCH_BODIES as Spec, "scratch-1", { id: "rs-9", status: "running", expiresAtMs: 7, cleanupPending: true }],
  [RENDER_SANDBOX_CLEANUP as Spec, "personal:erin", { resources: [{ sandboxId: "rs-0" }], error: "later" }],
  [
    AWS_DEPLOY_BODIES as Spec,
    "dep-1",
    { deploymentId: "dep-1", microvmId: "vm-2", endpoint: "https://vm-2", createdAtMs: 1, dataCredsAtMs: 2 },
  ],
  [
    E2B_DEPLOY_BODIES as Spec,
    "dep-2",
    { deploymentId: "dep-2", sandboxId: "sb-4", host: "h.e2b.app", trafficAccessToken: "tok", createdAtMs: 1 },
  ],
  [
    PORTER_DEPLOY_BODIES as Spec,
    "dep-3",
    { deploymentId: "dep-3", sandboxId: "p-1", name: "app", host: "app.porter", port: 8080, createdAtMs: 1 },
  ],
  [
    RENDER_DEPLOY_BODIES as Spec,
    "dep-4",
    {
      deploymentId: "dep-4",
      appRegion: "oregon",
      serviceId: "srv-1",
      token: "t",
      liveVersion: 3,
      suspended: false,
      pending: { version: 4, runnerCommit: "abc", readinessNonce: "n" },
    },
  ],
  [RENDER_DEPLOY_CREDENTIALS as Spec, "dep-4", { principalId: "deploy:dep-4" }],
  [RENDER_APP_STORAGE as Spec, "dep-4", { deploymentId: "dep-4", accessKey: "ak", secretKeyEnc: "enc", enabled: true }],
  [
    FLY_DEPLOY_CONFIGS as Spec,
    "dep-5",
    {
      image: "registry/app:1",
      metadata: { qm_deployment_id: "dep-5" },
      env: { PORT: "8080" },
      guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
      files: [],
      services: [],
      init: { exec: ["/bin/run"] },
    },
  ],
];

for (const [spec, key, row] of rows) {
  test(`${spec.table} backfills its key-value rows and stays inside one tenant`, { skip }, async () => {
    await withTypedTableDb(
      (url) => typedTable(url, spec, tableConversion(spec)),
      async ({ store, tenant, otherTenant, admin }) => {
        await withTenant(tenant, async () => {
          assert.deepEqual(await store.get(key), row);
          assert.deepEqual(await store.entries(), [[key, row]]);
        });
        await withTenant(otherTenant, async () => {
          assert.equal(await store.get(key), null);
          assert.deepEqual(await store.entries(), []);
          assert.equal(await store.merge(key, {}), null);
          await store.delete(key);
          await store.put(key, row);
        });
        await withTenant(tenant, async () => {
          const required = new Set<string>([...(spec.required ?? []), spec.fieldKey ?? ""]);
          const field = Object.keys(row).find((name) => !required.has(name));
          if (field) {
            const merged = await store.merge(key, { [field]: undefined });
            assert.equal((merged as Record<string, unknown>)[field], undefined);
          }
          await store.delete(key);
          assert.equal(await store.get(key), null);
        });
        const { rows: counts } = await admin.query(
          `SELECT count(*)::int AS n, to_regclass('${spec.table}_kv') AS kv FROM ${spec.table}`,
        );
        assert.deepEqual(counts[0], { n: 1, kv: null });
      },
      (admin) => seedKeyValueTable(admin, spec.table, { [key]: row }),
    );
  });
}

test("global infra tables backfill without a tenant and are shared by every tenant", { skip }, async () => {
  const make = (url: string) => {
    const claims = typedTable(url, FLY_PEER_CLAIMS, globalConversion(FLY_PEER_CLAIMS));
    const epochs = typedTable(url, SUPERSERVE_CONFIG_EPOCHS, globalConversion(SUPERSERVE_CONFIG_EPOCHS));
    return {
      claims,
      epochs,
      ports: createFlyPortClaims(url),
      close: async () => {
        await Promise.all([claims.close(), epochs.close()]);
      },
    };
  };
  await withTypedTableDb(
    make,
    async ({ store, tenant, otherTenant, admin }) => {
      await withTenant(tenant, async () => {
        assert.deepEqual(await store.claims.get("peer-1"), { taskArn: "arn:task/1" });
        assert.deepEqual(await store.epochs.get("gen-a"), { generation: 2 });
        assert.equal(await store.ports.claim("company-app", 20001, "dep-z"), "dep-1");
        assert.equal(await store.ports.claim("company-app", 20002, "dep-z"), "dep-z");
      });
      await withTenant(otherTenant, async () => {
        assert.deepEqual(await store.claims.get("peer-1"), { taskArn: "arn:task/1" });
        assert.equal(await store.ports.claim("company-app", 20002, "dep-y"), "dep-z");
        const updated = await store.claims.update("peer-1", (claim) => ({ ...claim, stoppedConfirmedAt: "now" }));
        assert.equal(updated?.stoppedConfirmedAt, "now");
      });
      const { rows: columns } = await admin.query(
        `SELECT count(*)::int AS n FROM pg_attribute
          WHERE attname = 'tenant_id' AND NOT attisdropped
            AND attrelid IN ('fly_peer_claims'::regclass, 'superserve_config_epochs'::regclass, 'fly_deploy_ports'::regclass)`,
      );
      assert.equal(columns[0].n, 0);
    },
    async (admin) => {
      await seedKeyValueTable(admin, "fly_peer_claims", { "peer-1": { taskArn: "arn:task/1" } });
      await seedKeyValueTable(admin, "superserve_config_epochs", { "gen-a": { generation: 2 } });
      await admin.query(`CREATE TABLE fly_deploy_ports(id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
      await admin.query(`INSERT INTO fly_deploy_ports VALUES ('company-app:20001', '"dep-1"')`);
    },
  );
});
