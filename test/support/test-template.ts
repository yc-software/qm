import { buildApp } from "../../src/wiring.ts";
import { migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { testConfig } from "./test-config.ts";
import { enterTenant } from "../../src/tenants/context.ts";
import { seedTestTenants, TEST_TENANT } from "./tenant-seed.ts";

if (import.meta.main) {
  const databaseUrl = process.argv[2]!;
  enterTenant(TEST_TENANT);
  await seedTestTenants(databaseUrl);
  const { runtime } = buildApp(testConfig({ databaseUrl }));
  await migrateRegisteredPgSchemas(databaseUrl);
  await runtime.stop();
  process.exit(0);
}
