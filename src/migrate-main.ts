import { createItemsPromotion } from "./sessions/items-promotion.ts";
import { loadConfig } from "./config.ts";
import { migrateRegisteredPgSchemas } from "./persistence/pg-pool.ts";
import { buildApp } from "./wiring.ts";

const config = loadConfig();
const { runtime } = buildApp(config);
try {
  if (config.stageItemsCutover) {
    if (!config.databaseUrl || config.sessionStore !== "postgres")
      throw new Error("Staged items promotion requires Postgres");
    const promotion = await createItemsPromotion(config.databaseUrl, { analyze: true });
    await promotion.close();
  }
  await migrateRegisteredPgSchemas(config.databaseUrl);
  console.log("[qm:migrate] database migrations applied");
} finally {
  await runtime.stop();
}
