import { loadConfig } from "./config.ts";
import { migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { buildApp } from "./wiring.ts";

const config = loadConfig();
const { config: configStore, identity, mcpToolService, runtime } = buildApp(config);
try {
  await migrateRegisteredPgSchemas(config.databaseUrl);
  await configStore.hydrate?.();
  await identity.hydrate();
  await mcpToolService.ready();
  console.log("[qm:migrate] database migrations applied");
} finally {
  await runtime.stop();
}
