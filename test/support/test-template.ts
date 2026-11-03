import { buildApp } from "../../src/wiring.ts";
import { migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { testConfig } from "./test-config.ts";
import { seedTestTenants } from "./tenant-seed.ts";
import { grantTestAppLogin } from "./app-login.ts";

if (import.meta.main) {
  const [mode, databaseUrl, appDatabaseUrl] = process.argv.slice(2) as [string, string, string];
  if (mode === "tenants") {
    await seedTestTenants(databaseUrl);
  } else {
    const { runtime } = buildApp(testConfig({ databaseUrl }));
    await migrateRegisteredPgSchemas(databaseUrl);
    await runtime.stop();
  }
  await grantTestAppLogin(databaseUrl, appDatabaseUrl);
  process.exit(0);
}
