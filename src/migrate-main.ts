import { loadConfig } from "./config.ts";
import { createPgPool, migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { migrateTenantStorage } from "./tenants/storage-migration.ts";
import { buildApp } from "./wiring.ts";

const config = loadConfig();
const { runtime } = buildApp(config);
try {
  await migrateRegisteredPgSchemas(config.databaseUrl);
  console.log("[qm:migrate] database migrations applied");
  if (config.databaseUrl) {
    const db = createPgPool(config.databaseUrl);
    try {
      const tenants = new Set((await db.q("SELECT id::text AS id FROM tenants")).map((row) => String(row.id)));
      const moved = await migrateTenantStorage(config, tenants);
      console.log(`[qm:migrate] tenant storage layout applied (${moved} moved)`);
    } finally {
      await db.close();
    }
  }
} finally {
  await runtime.stop();
}
