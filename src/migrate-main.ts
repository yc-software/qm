import { loadConfig } from "./config.ts";
import { migrateCronQueue } from "./cron/job-queue.ts";
import { createPostgresAppPageViewLog } from "./deploy/page-views.ts";
import { createPostgresFileUploadStore } from "./files/file-upload-store.ts";
import { migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { createPostgresBudgetTracker } from "./ratelimit/postgres-budget.ts";
import { buildApp } from "./wiring.ts";

const config = loadConfig();
const built = buildApp(config);
try {
  if (config.databaseUrl) {
    createPostgresFileUploadStore(config.databaseUrl);
    createPostgresAppPageViewLog(config.databaseUrl);
    createPostgresBudgetTracker(config.databaseUrl);
  }
  await migrateRegisteredPgSchemas(config.databaseUrl);
  if (config.databaseUrl) await migrateCronQueue(config.databaseUrl);
  await built.rewriteSurfaceOrigins();
  console.log("[qm:migrate] database migrations applied");
} finally {
  await built.runtime.stop();
}
