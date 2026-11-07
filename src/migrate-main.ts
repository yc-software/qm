import { loadConfig } from "./config.ts";
import { migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { buildApp } from "./wiring.ts";

const config = loadConfig();
const { runtime, checkReadiness } = buildApp(config);
try {
  await migrateRegisteredPgSchemas(config.databaseUrl);
  await checkReadiness(new AbortController().signal);
  console.log("[qm:migrate] database migrations applied");
} finally {
  await runtime.stop();
}
