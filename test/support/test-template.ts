import { buildApp } from "../../src/wiring.ts";
import { migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { testConfig } from "./test-config.ts";

if (import.meta.main) {
  const databaseUrl = process.argv[2]!;
  const { runtime } = buildApp({ anthropicApiKey: "test-anthropic-key", ...testConfig({ databaseUrl }) });
  await migrateRegisteredPgSchemas(databaseUrl);
  await runtime.stop();
  process.exit(0);
}
