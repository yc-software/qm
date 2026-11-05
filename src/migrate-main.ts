import { loadConfig } from "./config.ts";
import { installCronQueue } from "./cron/job-queue.ts";
import { registerVectorMigrations } from "./memory/postgres-vector-store.ts";
import { migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { buildApp } from "./wiring.ts";

const config = loadConfig();
const { runtime } = buildApp(config);
try {
  if (config.databaseUrl) await registerVectorMigrations(config.databaseUrl);
  await migrateRegisteredPgSchemas(config.databaseUrl);
  if (config.databaseUrl) await installCronQueue(config.databaseUrl);
  console.log("[qm:migrate] database migrations applied");
} finally {
  await runtime.stop();
}
