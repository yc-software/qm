import { loadConfig } from "./config.ts";
import { backfillProviderNames } from "./sandbox/provider-name-backfill.ts";
import { migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { ownerDatabaseUrlFor, useOwnerDatabase } from "./tenants/claim.ts";
import { migrateTenantStorageOnce } from "./tenants/storage-migration.ts";
import { buildApp } from "./wiring.ts";

const config = loadConfig();
useOwnerDatabase(config.databaseOwnerUrl);
const { runtime } = buildApp(config);
try {
  await migrateRegisteredPgSchemas(config.databaseUrl);
  console.log("[qm:migrate] database migrations applied");
  if (config.databaseUrl) {
    const owner = ownerDatabaseUrlFor(config.databaseUrl);
    await backfillProviderNames(config, owner);
    await migrateTenantStorageOnce(config, owner);
  }
} finally {
  await runtime.stop();
}
