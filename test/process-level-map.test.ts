import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMap, processLevelMap } from "../src/persistence/durable-map.ts";
import { applyPgMigrations, createPgPool, definePgMigration } from "../src/persistence/pg-pool.ts";
import { SESSION_MIGRATIONS } from "../src/sessions/session-schema.ts";
import { withoutTenant, withTenant } from "../src/tenants/context.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { appUrl, ownerUrl, TEST_TENANT } from "./support/test-tenant.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the process-level map tests";

test("a tenant map turned process-level keeps its rows and serves an unbound app login", { skip }, async () => {
  const databaseUrl = testDatabaseUrl();
  const owner = createPgPool(ownerUrl(databaseUrl).toString());
  const app = createPgPool(appUrl(databaseUrl));
  try {
    const tenanted = createPostgresMap<{ v: number }>(owner, "layer_probe");
    await withTenant(TEST_TENANT, () => tenanted.put("current", { v: 1 }));
    const migrate = createPostgresMap<{ v: number }>(owner, "layer_probe", [], [], [processLevelMap("layer_probe")]);
    await withoutTenant(() => migrate.get("current"));
    const columns = await owner.q(
      "SELECT 1 FROM pg_attribute WHERE attrelid = 'layer_probe'::regclass AND attname = 'tenant_id' AND NOT attisdropped",
    );
    assert.equal(columns.length, 0);
    const map = createPostgresMap<{ v: number }>(app, "layer_probe", [], [], [processLevelMap("layer_probe")]);
    await withoutTenant(async () => {
      assert.deepEqual(await map.get("current"), { v: 1 });
      await map.put("current", { v: 2 });
      assert.deepEqual(await map.entries(), [["current", { v: 2 }]]);
      await assert.rejects(map.claimIds(), /layer_probe holds no tenant rows to claim/);
    });
  } finally {
    await app.close();
    await owner.close();
  }
});

test("migrating a fresh database stamps no tenant of its own", { skip }, async () => {
  const owner = createPgPool(ownerUrl(testDatabaseUrl()).toString());
  try {
    await owner.q("DELETE FROM tenants");
    await applyPgMigrations(await owner.pool(), SESSION_MIGRATIONS.map(definePgMigration));
    assert.deepEqual(await owner.q("SELECT id FROM tenants"), []);
  } finally {
    await owner.close();
  }
});
