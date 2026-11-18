import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool,migrateDatabase } from "../src/persistence/pg-pool.ts";
import { testBareDatabaseUrl,testMigratedDatabaseUrl } from "./support/test-database.ts";
import { appUrl,ownerUrl } from "./support/test-tenant.ts";

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

for (const access of ["app", "bootstrap"]) {
  test(`migrating a bare database with ${access} authority`, { skip }, async () => {
    const databaseUrl = appUrl(testBareDatabaseUrl());
    const owner = createPgPool(ownerUrl(databaseUrl).toString());
    try {
      if (access === "bootstrap") {
        const database = (await owner.q("SELECT current_database() AS d"))[0]!.d as string;
        await owner.q(`GRANT CREATE ON DATABASE "${database}" TO qm_app`);
        await owner.q("GRANT CREATE ON SCHEMA public TO qm_app");
      }
      const migrated = migrateDatabase(databaseUrl);
      if (access === "app") await assert.rejects(migrated, /misconfiguration: migration schema has not been applied/);
      else await migrated;
      assert.deepEqual(await owner.q("SELECT to_regclass('tenants') AS t"), [
        { t: access === "app" ? null : "tenants" },
      ]);
    } finally {
      await owner.close();
    }
  });
}
