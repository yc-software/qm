import { loadConfig, type Config } from "./config.ts";
import { migrateCronQueue } from "./cron/job-queue.ts";
import { createPostgresAppPageViewLog } from "./deploy/page-views.ts";
import { createPostgresFileUploadStore } from "./files/file-upload-store.ts";
import { createPostgresVectorStore } from "./memory/postgres-vector-store.ts";
import { createPgPool, migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { createPostgresBudgetTracker } from "./ratelimit/postgres-budget.ts";
import { buildApp } from "./wiring.ts";

async function vectorExtensionAvailable(databaseUrl: string): Promise<boolean> {
  const pool = createPgPool(databaseUrl);
  try {
    return (await pool.q("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'")).length > 0;
  } finally {
    await pool.close();
  }
}

export async function withRegisteredPgSchemas<T>(
  config: Config,
  run: (built: ReturnType<typeof buildApp>) => Promise<T>,
  { vector }: { vector?: boolean } = {},
): Promise<T> {
  const built = buildApp(config);
  try {
    if (config.databaseUrl) {
      createPostgresFileUploadStore(config.databaseUrl);
      createPostgresAppPageViewLog(config.databaseUrl);
      createPostgresBudgetTracker(config.databaseUrl);
      if (vector ?? (await vectorExtensionAvailable(config.databaseUrl))) createPostgresVectorStore(config.databaseUrl);
    }
    return await run(built);
  } finally {
    await built.runtime.stop();
  }
}

if (import.meta.main) {
  const config = loadConfig();
  await withRegisteredPgSchemas(config, async () => {
    await migrateRegisteredPgSchemas(config.databaseUrl);
    if (config.databaseUrl) await migrateCronQueue(config.databaseUrl);
    console.log("[qm:migrate] database migrations applied");
  });
}
