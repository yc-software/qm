import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMap } from "../src/persistence/durable-map.ts";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { testBareDatabaseUrl, testMigratedDatabaseUrl } from "./support/test-database.ts";
import { appUrl, ownerUrl } from "./support/test-tenant.ts";

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

for (const access of ["app", "ledger-owner", "bootstrap"]) {
  test(`pending migrations with ${access} authority`, { skip }, async () => {
    const databaseUrl = appUrl(access === "bootstrap" ? testBareDatabaseUrl() : testMigratedDatabaseUrl());
    const app = createPgPool(databaseUrl);
    const owner = createPgPool(ownerUrl(databaseUrl).toString());
    try {
      if (access !== "app") await owner.q("GRANT CREATE ON SCHEMA public TO qm_app");
      if (access === "ledger-owner") await owner.q("ALTER TABLE qm_schema_migrations OWNER TO qm_app");
      const read = createPostgresMap<{ v: number }>(app, "unmigrated_probe").get("x");
      if (access === "app")
        await assert.rejects(
          read,
          /misconfiguration: migration durable-map\/unmigrated_probe\/0001 has not been applied/,
        );
      else assert.equal(await read, null);
      assert.deepEqual(await owner.q("SELECT to_regclass('unmigrated_probe') AS t"), [
        { t: access === "app" ? null : "unmigrated_probe" },
      ]);
    } finally {
      await app.close();
      await owner.close();
    }
  });
}
