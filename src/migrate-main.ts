import { loadConfig } from "./config.ts";
import { installCronQueue } from "./cron/job-queue.ts";
import { registerVectorMigrations } from "./memory/postgres-vector-store.ts";
import { migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { buildApp } from "./wiring.ts";
import { inBootTenant, readBootTenant } from "./tenants/boot.ts";

const config = loadConfig();
const { runtime, checkReadiness } = buildApp(config);
try {
  if (config.databaseUrl) await registerVectorMigrations(config.databaseUrl);
  await migrateRegisteredPgSchemas(config.databaseUrl);
  if (config.databaseUrl) await installCronQueue(config.databaseUrl);
  const tenant = config.databaseUrl ? await readBootTenant(config.databaseUrl) : undefined;
  await inBootTenant(tenant, () => checkReadiness(new AbortController().signal));
  console.log("[qm:migrate] database migrations applied");
} finally {
  await runtime.stop();
}
