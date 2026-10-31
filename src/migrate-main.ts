import { loadConfig } from "./config.ts";
import { backfillProviderNames } from "./sandbox/provider-name-backfill.ts";
import { migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { buildApp } from "./wiring.ts";

const config = loadConfig();
const { runtime } = buildApp(config);
try {
  await migrateRegisteredPgSchemas(config.databaseUrl);
  await backfillProviderNames(config);
  console.log("[qm:migrate] database migrations applied");
} finally {
  await runtime.stop();
}
