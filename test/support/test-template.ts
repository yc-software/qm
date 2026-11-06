import pg from "pg";
import { buildApp } from "../../src/wiring.ts";
import { migrateRegisteredPgSchemas } from "../../src/persistence/pg-pool.ts";
import { createPostgresAppPageViewLog } from "../../src/deploy/page-views.ts";
import { createPostgresFileUploadStore } from "../../src/files/file-upload-store.ts";
import { createPostgresVectorStore } from "../../src/memory/postgres-vector-store.ts";
import { createPostgresBudgetTracker } from "../../src/ratelimit/postgres-budget.ts";
import { createPostgresProcessRegistry } from "../../src/processes/process-registry.ts";
import { testConfig } from "./test-config.ts";
import { ownerUrl, TEST_TENANT } from "./test-tenant.ts";

async function vectorAvailable(databaseUrl: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'")).rows.length > 0;
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  const databaseUrl = process.argv[2]!;
  const { runtime } = buildApp({ anthropicApiKey: "test-anthropic-key", ...testConfig({ databaseUrl }) });
  createPostgresAppPageViewLog(databaseUrl);
  createPostgresFileUploadStore(databaseUrl);
  createPostgresBudgetTracker(databaseUrl);
  createPostgresProcessRegistry(databaseUrl);
  if (await vectorAvailable(databaseUrl)) createPostgresVectorStore(databaseUrl);
  await migrateRegisteredPgSchemas(databaseUrl);
  const owner = new pg.Client({ connectionString: ownerUrl(databaseUrl).toString() });
  await owner.connect();
  await owner.query("DELETE FROM tenants WHERE id <> $1", [TEST_TENANT]);
  await owner.end();
  await runtime.stop();
  process.exit(0);
}
