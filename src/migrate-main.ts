import { loadConfig } from "./config.ts";
import { migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { buildCore } from "./wiring.ts";

const config = loadConfig();
const core = buildCore(config);
try {
  await migrateRegisteredPgSchemas(config.databaseUrl);
  console.log("[qm:migrate] database migrations applied");
} finally {
  await core.close();
}
