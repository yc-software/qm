import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createBackgroundOwnershipStore, type BackgroundOwnership } from "../src/runs/background-ownership.ts";
import { inInstallTenant } from "../src/tenants/claim.ts";
import { TENANT_A, twoTenantDatabase, twoTenantTestSkip } from "./support/two-tenants.ts";

test(
  "with several tenants, background ownership reads and writes the install tenant's record without a bound tenant",
  { skip: twoTenantTestSkip() },
  async () => {
    const db = await twoTenantDatabase((url) =>
      createPostgresMapFactory(url).map<BackgroundOwnership>("background_ownership"),
    );
    await db.owner.query(
      `CREATE OR REPLACE FUNCTION qm_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT '${TENANT_A}'::uuid $f$`,
    );
    const maps = createPostgresMapFactory(db.appUrl);
    const store = createBackgroundOwnershipStore(maps.map<BackgroundOwnership>("background_ownership"));
    try {
      await assert.rejects(store.get(), /No tenant is bound/);
      const installed = await inInstallTenant(maps.pool, () =>
        store.set({ ownerDeploymentId: "cohort-a", setBy: "test" }),
      );
      assert.equal(installed.ownerDeploymentId, "cohort-a");
      assert.equal((await inInstallTenant(maps.pool, () => store.get())).ownerDeploymentId, "cohort-a");
      const { rows } = await db.owner.query("SELECT tenant_id::text AS tenant FROM background_ownership");
      assert.deepEqual(rows, [{ tenant: TENANT_A }]);
    } finally {
      await maps.pool.close();
      await db.close();
    }
  },
);
