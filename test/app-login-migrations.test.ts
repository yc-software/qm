import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMap } from "../src/persistence/durable-map.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";
import { ownerUrl } from "./support/test-tenant.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the app login migration tests";

test("a migrated database already has every configured store's tables", { skip }, async () => {
  const owner = createPgPool(ownerUrl(testMigratedDatabaseUrl()).toString());
  try {
    const rows = await owner.q("SELECT tablename FROM pg_tables WHERE schemaname = current_schema()");
    const tables = new Set(rows.map((row) => String(row.tablename)));
    for (const table of [
      "file_uploads",
      "sprites_initialization",
      "budget_spend",
      "instance_heartbeats",
      "fly_deploy_ports",
      "fly_peer_claims",
      "render_sandbox_bases",
    ])
      assert.ok(tables.has(table), `${table} is missing after migration`);
  } finally {
    await owner.close();
  }
});

test("the app login refuses to create a table a migration never made", { skip }, async () => {
  const databaseUrl = testMigratedDatabaseUrl();
  const app = createPgPool(databaseUrl);
  const owner = createPgPool(ownerUrl(databaseUrl).toString());
  try {
    await assert.rejects(
      createPostgresMap<{ v: number }>(app, "unmigrated_probe").get("x"),
      /misconfiguration: migration durable-map\/unmigrated_probe\/0001 has not been applied/,
    );
    assert.deepEqual(await owner.q("SELECT to_regclass('unmigrated_probe') AS t"), [{ t: null }]);
  } finally {
    await app.close();
    await owner.close();
  }
});
