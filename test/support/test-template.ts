import { buildApp } from "../../src/wiring.ts";
import { migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { testConfig } from "./test-config.ts";
import { seedTestTenants } from "./test-tenants.ts";

if (import.meta.main) {
  const [mode, databaseUrl] = process.argv.slice(2) as [string, string];
  if (mode === "tenants") {
    await seedTestTenants(databaseUrl);
  } else {
    const { runtime } = buildApp({ anthropicApiKey: "test-anthropic-key", ...testConfig({ databaseUrl }) });
    await migrateRegisteredPgSchemas(databaseUrl);
    await runtime.stop();
  }
  process.exit(0);
}
