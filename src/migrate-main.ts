import { loadConfig } from "./config.ts";
import { migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { buildApp } from "./wiring.ts";

const config = loadConfig();
const { runtime } = buildApp(config);
try {
  await migrateRegisteredPgSchemas(config.databaseUrl);
  console.log("[qm:migrate] database migrations applied");
} finally {
  await runtime.stop();
}
