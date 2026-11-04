import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createNoopAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createSandboxResources, type SandboxDefault, type SandboxResource } from "../src/sandbox/sandbox-resources.ts";
import { rewriteSurfaceOrigins } from "../src/surfaces/origin-migration.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { forEachTenant } from "../src/tenants/claim.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { ownerPgPool } from "../src/tenants/owner-pool.ts";
import { TENANT_A, TENANT_B, twoTenantDatabase, twoTenantTestSkip } from "./support/two-tenants.ts";

const skip = twoTenantTestSkip();

test("boot steps run once under each tenant as the restricted login with two tenants", { skip }, async () => {
  const db = await twoTenantDatabase((url) => {
    const maps = createPostgresMapFactory(url);
    maps.map<SandboxResource>("sandbox_resources");
    maps.map<SandboxDefault>("sandbox_defaults");
    createPostgresRunStore(url);
  });
  try {
    const maps = createPostgresMapFactory(db.appUrl);
    const upgradedIn: Array<string | undefined> = [];
    const sandboxes = createSandboxResources({
      upgrade: async () => {
        upgradedIn.push(boundTenant());
      },
      records: maps.map<SandboxResource>("sandbox_resources"),
      defaults: maps.map<SandboxDefault>("sandbox_defaults"),
      backends: {},
      defaultBackend: "e2b",
      lock: createNoopAdvisoryLock(),
      canUseScope: async () => true,
    });
    await assert.rejects(maps.pool.q("SELECT count(*) FROM sandbox_resources"), /No tenant is bound/);
    await forEachTenant(maps.pool, () => sandboxes.initialize());
    await withTenant(TENANT_B, () => sandboxes.initialize());
    const tenants = (await db.owner.query("SELECT id::text AS id FROM tenants ORDER BY id")).rows.map((row) => row.id);
    assert.ok(tenants.includes(TENANT_A) && tenants.includes(TENANT_B));
    assert.deepEqual(upgradedIn, tenants);
    await rewriteSurfaceOrigins(ownerPgPool(maps.pool));
  } finally {
    await db.close();
  }
});
