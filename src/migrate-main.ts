import { loadConfig } from "./config.ts";
import { migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { buildApp } from "./wiring.ts";

const config = loadConfig();
const built = buildApp(config);
try {
  await migrateRegisteredPgSchemas(config.databaseUrl);
  await built.rewriteSurfaceOrigins();
  console.log("[qm:migrate] database migrations applied");
} finally {
  await built.runtime.stop();
}
